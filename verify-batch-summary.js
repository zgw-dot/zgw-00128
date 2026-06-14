const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = 'localhost';
const PORT = 3000;
const BASE = `http://${HOST}:${PORT}`;
const DB_PATH = path.join(__dirname, 'data', 'tracker.db');

let SERVER_PROC = null;

function api(p, opts = {}) {
  return new Promise(resolve => {
    const url = new URL(p, BASE);
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      headers,
      timeout: opts.timeout || 15000
    }, res => {
      let data = '';
      const setCookie = res.headers['set-cookie'] || [];
      res.on('data', c => data += c);
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body, setCookie: setCookie[0] || null, raw: data });
      });
    });
    req.on('error', e => resolve({ status: 0, body: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null, error: 'timeout' }); });
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function clearDatabase() {
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    console.log('   数据库已删除:', DB_PATH);
  }
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function startServer() {
  return new Promise((resolve, reject) => {
    SERVER_PROC = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let started = false;
    let stderrOutput = '';
    SERVER_PROC.stderr.on('data', d => stderrOutput += d.toString());

    SERVER_PROC.stdout.on('data', async d => {
      const msg = d.toString();
      if (!started && msg.includes('冷链样本追踪系统已启动')) {
        started = true;
        await sleep(500);
        resolve();
      }
    });

    SERVER_PROC.on('exit', code => {
      if (!started) {
        reject(new Error(`服务器启动失败，退出码=${code}，stderr=${stderrOutput}`));
      }
    });

    setTimeout(() => {
      if (!started) reject(new Error('服务器启动超时'));
    }, 15000);
  });
}

function stopServer() {
  return new Promise(resolve => {
    if (!SERVER_PROC) { resolve(); return; }
    SERVER_PROC.on('exit', resolve);
    SERVER_PROC.kill('SIGTERM');
    setTimeout(() => {
      if (SERVER_PROC && SERVER_PROC.kill) SERVER_PROC.kill('SIGKILL');
    }, 5000);
  });
}

async function main() {
  try {
    console.log('========== 批次汇总 + 审计日志筛选导出 验收 ==========\n');

    clearDatabase();
    await startServer();
    await sleep(300);

    // ========== 1. admin 登录 ==========
    console.log('[1] admin 登录');
    const login = await api('/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin123' }
    });
    if (!login.body || !login.body.success) throw new Error('登录失败: ' + JSON.stringify(login.body));
    const COOKIE = login.setCookie;
    console.log('   ✅ 登录成功，admin ID=' + login.body.data.id);
    const ADMIN_ID = login.body.data.id;

    // 选库位
    const locs = await api('/api/locations', { cookie: COOKIE });
    const cooledLocs = (locs.body.data || []).filter(l => l.zone_id === 1);
    const LOC_ID_1 = cooledLocs[0].id;
    const LOC_ID_2 = cooledLocs[1] ? cooledLocs[1].id : LOC_ID_1;
    console.log(`   选库位: LOC1=${cooledLocs[0].code}(ID=${LOC_ID_1}) LOC2=${cooledLocs[1] ? cooledLocs[1].code : 'N/A'}(ID=${LOC_ID_2})`);

    const TS = Date.now().toString(36);
    const BATCH_A = 'BAT-A-' + TS;
    const BATCH_B = 'BAT-B-' + TS;

    // ========== 2. 造两个批次，各 5 条样本 ==========
    console.log('[2] 登记样本: 批次A=' + BATCH_A + ' 批次B=' + BATCH_B);
    const sampleIds = { A: [], B: [] };

    for (let i = 1; i <= 5; i++) {
      const rA = await api('/api/samples', {
        method: 'POST', cookie: COOKIE,
        body: { barcode: `${BATCH_A}-S${i}`, batch_no: BATCH_A, name: `A样本${i}`, required_zone_id: 1 }
      });
      if (!rA.body.success) throw new Error(`A-S${i} 登记失败: ` + rA.body.error);
      sampleIds.A.push(rA.body.data.id);

      const rB = await api('/api/samples', {
        method: 'POST', cookie: COOKIE,
        body: { barcode: `${BATCH_B}-S${i}`, batch_no: BATCH_B, name: `B样本${i}`, required_zone_id: 1 }
      });
      if (!rB.body.success) throw new Error(`B-S${i} 登记失败: ` + rB.body.error);
      sampleIds.B.push(rB.body.data.id);
    }
    console.log(`   ✅ 各 5 条样本已登记, A IDs=${sampleIds.A.join(',')} B IDs=${sampleIds.B.join(',')}`);

    // ========== 3. 全部入库 ==========
    console.log('[3] 全部入库');
    const inboundItems = [...sampleIds.A, ...sampleIds.B].map(sid => ({ sample_id: sid, location_id: LOC_ID_1 }));
    const ib = await api('/api/samples/batch/inbound', {
      method: 'POST', cookie: COOKIE,
      body: { items: inboundItems, remark: '批次汇总测试-入库' }
    });
    if (!ib.body.success) throw new Error('批量入库失败: ' + ib.body.error);
    console.log(`   ✅ 10 条全部入库`);

    // ========== 4. 部分出库: A 批次前 2 条，B 批次前 1 条 ==========
    console.log('[4] 部分出库');
    const outboundItems = [
      { sample_id: sampleIds.A[0] },
      { sample_id: sampleIds.A[1] },
      { sample_id: sampleIds.B[0] }
    ];
    const ob = await api('/api/samples/batch/outbound', {
      method: 'POST', cookie: COOKIE,
      body: { items: outboundItems, remark: '批次汇总测试-出库' }
    });
    if (!ob.body.success) throw new Error('批量出库失败: ' + ob.body.error);
    console.log(`   ✅ 出库: A[0,1] + B[0]`);

    // ========== 5. 部分报废: A 批次第 3 条，B 批次第 2 条 ==========
    console.log('[5] 部分报废');
    const scrapA = await api(`/api/samples/${sampleIds.A[2]}/scrap`, {
      method: 'POST', cookie: COOKIE, body: { remark: '批次汇总测试-报废A3' }
    });
    if (!scrapA.body.success) throw new Error('A3报废失败: ' + scrapA.body.error);
    const scrapB = await api(`/api/samples/${sampleIds.B[1]}/scrap`, {
      method: 'POST', cookie: COOKIE, body: { remark: '批次汇总测试-报废B2' }
    });
    if (!scrapB.body.success) throw new Error('B2报废失败: ' + scrapB.body.error);
    console.log(`   ✅ 报废: A[2] + B[1]`);

    // 此时状态:
    // A: pending=0, in_storage=2 (A[3],A[4]), outbound=2 (A[0],A[1]), scrapped=1 (A[2])
    // B: pending=0, in_storage=3 (B[2],B[3],B[4]), outbound=1 (B[0]), scrapped=1 (B[1])

    // ========== 6. 调 summary 验证全量 ==========
    console.log('[6] 调 /api/batches/summary (全量)');
    const summaryAll = await api('/api/batches/summary', { cookie: COOKIE });
    if (!summaryAll.body.success) throw new Error('summary 查询失败: ' + summaryAll.body.error);
    const allData = summaryAll.body.data;
    console.log(`   返回 ${allData.length} 个批次`);

    const batchA = allData.find(b => b.batch_no === BATCH_A);
    const batchB = allData.find(b => b.batch_no === BATCH_B);

    if (!batchA) throw new Error('未找到批次A汇总');
    if (!batchB) throw new Error('未找到批次B汇总');

    console.log(`   批次A: total=${batchA.total} pending=${batchA.pending_count} in_storage=${batchA.in_storage_count} outbound=${batchA.outbound_count} scrapped=${batchA.scrapped_count}`);
    console.log(`   批次B: total=${batchB.total} pending=${batchB.pending_count} in_storage=${batchB.in_storage_count} outbound=${batchB.outbound_count} scrapped=${batchB.scrapped_count}`);

    // 校验批次 A
    assert(batchA.total === 5, `批次A total 应=5, 实际=${batchA.total}`);
    assert(batchA.pending_count === 0, `批次A pending 应=0, 实际=${batchA.pending_count}`);
    assert(batchA.in_storage_count === 2, `批次A in_storage 应=2, 实际=${batchA.in_storage_count}`);
    assert(batchA.outbound_count === 2, `批次A outbound 应=2, 实际=${batchA.outbound_count}`);
    assert(batchA.scrapped_count === 1, `批次A scrapped 应=1, 实际=${batchA.scrapped_count}`);
    console.log('   ✅ 批次A 各状态计数正确');

    // 校验批次 B
    assert(batchB.total === 5, `批次B total 应=5, 实际=${batchB.total}`);
    assert(batchB.pending_count === 0, `批次B pending 应=0, 实际=${batchB.pending_count}`);
    assert(batchB.in_storage_count === 3, `批次B in_storage 应=3, 实际=${batchB.in_storage_count}`);
    assert(batchB.outbound_count === 1, `批次B outbound 应=1, 实际=${batchB.outbound_count}`);
    assert(batchB.scrapped_count === 1, `批次B scrapped 应=1, 实际=${batchB.scrapped_count}`);
    console.log('   ✅ 批次B 各状态计数正确');

    // 校验时间字段
    assert(batchA.first_registered_at, '批次A 缺少 first_registered_at');
    assert(batchA.last_operated_at, '批次A 缺少 last_operated_at');
    assert(batchB.first_registered_at, '批次B 缺少 first_registered_at');
    assert(batchB.last_operated_at, '批次B 缺少 last_operated_at');
    console.log(`   批次A: 最早登记=${batchA.first_registered_at} 最近操作=${batchA.last_operated_at}`);
    console.log(`   批次B: 最早登记=${batchB.first_registered_at} 最近操作=${batchB.last_operated_at}`);
    console.log('   ✅ 时间字段完整');

    // ========== 7. 调 summary 按 batch_no 查单个 ==========
    console.log('[7] 调 /api/batches/summary?batch_no=xxx (单个)');
    const summaryOne = await api(`/api/batches/summary?batch_no=${encodeURIComponent(BATCH_A)}`, { cookie: COOKIE });
    if (!summaryOne.body.success) throw new Error('summary 单个查询失败: ' + summaryOne.body.error);
    const oneData = summaryOne.body.data;
    assert(oneData.length === 1, `单个查询应返回1条, 实际=${oneData.length}`);
    assert(oneData[0].batch_no === BATCH_A, `batch_no 应=${BATCH_A}, 实际=${oneData[0].batch_no}`);
    assert(oneData[0].total === 5, `单个查询 total 应=5, 实际=${oneData[0].total}`);
    console.log('   ✅ 单个批次查询正确');

    // ========== 8. 查不存在的 batch_no ==========
    console.log('[8] 查不存在的 batch_no');
    const summaryNone = await api('/api/batches/summary?batch_no=NONEXISTENT-999', { cookie: COOKIE });
    if (!summaryNone.body.success) throw new Error('summary 查不存在的批次失败: ' + summaryNone.body.error);
    assert(summaryNone.body.data.length === 0, '不存在的批次应返回空数组');
    console.log('   ✅ 不存在的批次返回空数组');

    // ========== 9. 未登录访问 summary ==========
    console.log('[9] 未登录访问 summary');
    await api('/api/auth/logout', { method: 'POST', cookie: COOKIE });
    const summaryNoAuth = await api('/api/batches/summary', {});
    if (summaryNoAuth.body && summaryNoAuth.body.needLogin) {
      console.log('   ✅ 未登录被拒绝');
    } else {
      throw new Error('未登录应被拒绝');
    }
    const relogin = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
    const COOKIE2 = relogin.setCookie;

    // ========== 10. 审计日志筛选导出 - action_type = outbound ==========
    console.log('[10] 审计日志导出: action_type=outbound');
    const csvOutbound = await api('/api/audit-log/export/csv?action_type=outbound', { cookie: COOKIE2 });
    const csvOutRaw = csvOutbound.raw || '';
    const csvOutLines = csvOutRaw.split(/\r?\n/).filter(l => l.trim().length > 0);
    assert(csvOutLines.length >= 2, `outbound 筛选导出至少应有表头+1行数据, 实际行数=${csvOutLines.length}`);
    // 验证数据行都包含 "出库" 或 outbound
    for (let i = 1; i < csvOutLines.length; i++) {
      assert(csvOutLines[i].includes('出库') || csvOutLines[i].includes('outbound'),
        `第${i}行不包含 outbound 相关内容: ${csvOutLines[i].substring(0, 60)}`);
    }
    console.log(`   ✅ action_type=outbound 导出 ${csvOutLines.length - 1} 行数据，全部匹配`);

    // ========== 11. 审计日志筛选导出 - operator_id ==========
    console.log('[11] 审计日志导出: operator_id=' + ADMIN_ID);
    const csvByOp = await api(`/api/audit-log/export/csv?operator_id=${ADMIN_ID}`, { cookie: COOKIE2 });
    const csvOpRaw = csvByOp.raw || '';
    const csvOpLines = csvOpRaw.split(/\r?\n/).filter(l => l.trim().length > 0);
    assert(csvOpLines.length >= 2, `operator_id 筛选导出至少应有表头+1行, 实际行数=${csvOpLines.length}`);
    console.log(`   ✅ operator_id=${ADMIN_ID} 导出 ${csvOpLines.length - 1} 行数据`);

    // ========== 12. 审计日志筛选导出 - from/to 时间范围 ==========
    console.log('[12] 审计日志导出: from/to 时间范围');
    const futureTime = '2099-01-01 00:00:00';
    const pastTime = '2000-01-01 00:00:00';
    // 查未来时间范围 → 应该为空
    const csvFuture = await api(`/api/audit-log/export/csv?from=${encodeURIComponent(futureTime)}&to=2099-12-31`, { cookie: COOKIE2 });
    const csvFutureRaw = csvFuture.raw || '';
    const csvFutureLines = csvFutureRaw.split(/\r?\n/).filter(l => l.trim().length > 0);
    assert(csvFutureLines.length === 1, `未来时间范围应只有表头, 实际行数=${csvFutureLines.length}`);
    // 验证表头完整
    const csvHeader = csvFutureLines[0].replace(/^\ufeff/, '');
    const expectedHeader = '时间,操作人,IP地址,操作类型,操作对象,对象ID,操作前值,操作后值,备注';
    assert(csvHeader === expectedHeader, `空导出表头不匹配\n期望: ${expectedHeader}\n实际: ${csvHeader}`);
    console.log('   ✅ 未来时间范围导出空 CSV（只有表头）');

    // 查包含所有时间的范围 → 应有数据
    const csvAllTime = await api(`/api/audit-log/export/csv?from=${encodeURIComponent(pastTime)}&to=${encodeURIComponent(futureTime)}`, { cookie: COOKIE2 });
    const csvAllTimeRaw = csvAllTime.raw || '';
    const csvAllTimeLines = csvAllTimeRaw.split(/\r?\n/).filter(l => l.trim().length > 0);
    assert(csvAllTimeLines.length >= 2, `全时间范围应至少有表头+1行, 实际行数=${csvAllTimeLines.length}`);
    console.log(`   ✅ 全时间范围导出 ${csvAllTimeLines.length - 1} 行数据`);

    // ========== 13. 组合筛选: action_type + operator_id ==========
    console.log('[13] 审计日志导出: action_type=inbound + operator_id=' + ADMIN_ID);
    const csvCombo = await api(`/api/audit-log/export/csv?action_type=inbound&operator_id=${ADMIN_ID}`, { cookie: COOKIE2 });
    const csvComboRaw = csvCombo.raw || '';
    const csvComboLines = csvComboRaw.split(/\r?\n/).filter(l => l.trim().length > 0);
    assert(csvComboLines.length >= 2, `组合筛选应至少有表头+1行, 实际行数=${csvComboLines.length}`);
    for (let i = 1; i < csvComboLines.length; i++) {
      assert(csvComboLines[i].includes('入库') || csvComboLines[i].includes('inbound'),
        `第${i}行不是 inbound: ${csvComboLines[i].substring(0, 60)}`);
    }
    console.log(`   ✅ 组合筛选导出 ${csvComboLines.length - 1} 行，全部匹配 inbound`);

    // ========== 14. 不匹配的筛选 → 空 CSV（只带表头） ==========
    console.log('[14] 不匹配的筛选导出: action_type=login + operator_id=99999');
    const csvNoMatch = await api('/api/audit-log/export/csv?action_type=login&operator_id=99999', { cookie: COOKIE2 });
    const csvNoMatchRaw = csvNoMatch.raw || '';
    const csvNoMatchLines = csvNoMatchRaw.split(/\r?\n/).filter(l => l.trim().length > 0);
    assert(csvNoMatchLines.length === 1, `不匹配筛选应只有表头, 实际行数=${csvNoMatchLines.length}`);
    const noMatchHeader = csvNoMatchLines[0].replace(/^\ufeff/, '');
    assert(noMatchHeader === expectedHeader, `不匹配导出表头不匹配`);
    console.log('   ✅ 不匹配筛选返回空 CSV（只有表头）');

    // ========== 15. 原有无参数导出仍然正常 ==========
    console.log('[15] 审计日志导出: 无参数（全量）');
    const csvFull = await api('/api/audit-log/export/csv', { cookie: COOKIE2 });
    const csvFullRaw = csvFull.raw || '';
    const csvFullLines = csvFullRaw.split(/\r?\n/).filter(l => l.trim().length > 0);
    assert(csvFullLines.length >= 10, `全量导出应至少10行(表头+数据), 实际行数=${csvFullLines.length}`);
    console.log(`   ✅ 全量导出 ${csvFullLines.length - 1} 行数据`);

    // ========== 16. 验证筛选后导出行数与 API 查询一致 ==========
    console.log('[16] 验证筛选导出行数与 API 查询一致');
    const apiOutbound = await api('/api/audit-log?action_type=outbound&page_size=200', { cookie: COOKIE2 });
    const apiOutboundCount = apiOutbound.body.data.total;
    assert(csvOutLines.length - 1 === apiOutboundCount,
      `导出行数(${csvOutLines.length - 1}) !== API查询total(${apiOutboundCount})`);
    console.log(`   ✅ outbound: 导出${csvOutLines.length - 1}行 = API查询${apiOutboundCount}条`);

    console.log('\n========== 验收结论 ==========');
    console.log('✅ /api/batches/summary: 全量汇总、单批次查询、不存在的批次返回空、未登录拒绝');
    console.log('✅ /api/batches/summary: 各状态计数正确（pending/in_storage/outbound/scrapped）');
    console.log('✅ /api/batches/summary: first_registered_at / last_operated_at 时间字段完整');
    console.log('✅ /api/audit-log/export/csv: from/to 时间范围筛选正常');
    console.log('✅ /api/audit-log/export/csv: action_type 筛选正常');
    console.log('✅ /api/audit-log/export/csv: operator_id 筛选正常');
    console.log('✅ /api/audit-log/export/csv: 组合筛选正常');
    console.log('✅ /api/audit-log/export/csv: 不匹配时返回空 CSV（只有表头）');
    console.log('✅ /api/audit-log/export/csv: 原有列不变（9列）');
    console.log('✅ /api/audit-log/export/csv: 筛选导出行数与 API 查询一致');
    console.log('\n🎉 批次汇总 + 审计日志筛选导出 验收通过！');

  } catch (e) {
    console.error('\n❌ 验收失败:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await stopServer();
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main();
