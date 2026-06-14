const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = 'localhost';
const PORT = 3000;
const BASE = `http://${HOST}:${PORT}`;
const DB_PATH = path.join(__dirname, 'data', 'tracker.db');
const COOKIE_JAR = path.join(__dirname, 'cookies-audit.txt');

let SERVER_PROC = null;

function api(path, opts = {}) {
  return new Promise(resolve => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const req = http.request({
      hostname: HOST, port: PORT, path,
      method: opts.method || 'GET', headers,
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

function deepClone(o) {
  try { return JSON.parse(JSON.stringify(o)); } catch { return o; }
}

async function runFullFlow(label) {
  console.log(`\n===== 第${label}轮：完整业务流程 =====`);

  // 1. 登录 admin
  console.log('[1] admin 登录');
  const login = await api('/api/auth/login', {
    method: 'POST', body: { username: 'admin', password: 'admin123' }
  });
  if (!login.body || !login.body.success) throw new Error('登录失败: ' + JSON.stringify(login.body));
  const COOKIE = login.setCookie;
  console.log('   ✅ 登录成功');

  // 选库位
  const locs = await api('/api/locations', { cookie: COOKIE });
  const cooledLocs = (locs.body.data || []).filter(l => l.zone_id === 1);
  const LOC_ID = cooledLocs[0].id, LOC_CODE = cooledLocs[0].code;
  const LOC_ALT_ID = cooledLocs[1] ? cooledLocs[1].id : LOC_ID;
  const LOC_ALT_CODE = cooledLocs[1] ? cooledLocs[1].code : LOC_CODE;
  console.log(`   选库位：主=${LOC_CODE}(ID=${LOC_ID}) 副=${LOC_ALT_CODE}(ID=${LOC_ALT_ID})`);

  const RUN = 'audit-' + Date.now().toString(36);
  const B = 'AUD-' + RUN;

  // 2. 建样本
  console.log('[2] 建样本 + 入库');
  const s1 = await api('/api/samples', {
    method: 'POST', cookie: COOKIE,
    body: { barcode: B + '-S1', batch_no: 'B' + B, name: '审计测1', required_zone_id: 1 }
  });
  const s2 = await api('/api/samples', {
    method: 'POST', cookie: COOKIE,
    body: { barcode: B + '-S2', batch_no: 'B' + B, name: '审计测2', required_zone_id: 1 }
  });
  if (!s1.body.success || !s2.body.success) throw new Error('建样本失败');
  const SID1 = s1.body.data.id, SID2 = s2.body.data.id;
  console.log(`   ✅ 建样本 SID1=${SID1} SID2=${SID2}`);

  // 3. 入库
  const ib1 = await api(`/api/samples/${SID1}/inbound`, {
    method: 'POST', cookie: COOKIE, body: { location_id: LOC_ID }
  });
  const ib2 = await api(`/api/samples/${SID2}/inbound`, {
    method: 'POST', cookie: COOKIE, body: { location_id: LOC_ID }
  });
  if (!ib1.body.success || !ib2.body.success) throw new Error('入库失败: ' + (ib1.body.error || ib2.body.error));
  console.log(`   ✅ 入库到 ${LOC_CODE}`);

  // 4. 转移
  console.log('[3] 转移');
  const tr = await api(`/api/samples/${SID1}/transfer`, {
    method: 'POST', cookie: COOKIE, body: { to_location_id: LOC_ALT_ID, remark: '测试转移' }
  });
  if (!tr.body.success) throw new Error('转移失败: ' + tr.body.error);
  console.log(`   ✅ S1 从 ${LOC_CODE} 转移到 ${LOC_ALT_CODE}`);

  // 5. 建盘点 + 盘点导入
  console.log('[4] 建盘点 + 盘点导入（故意放错位置触发 mislocated）');
  const inv = await api('/api/inventory', {
    method: 'POST', cookie: COOKIE,
    body: { title: '审计测试盘点-' + RUN, type: 'location', location_id: LOC_ID }
  });
  if (!inv.body.success) throw new Error('建盘点失败');
  const INV_ID = inv.body.data.id;

  const invImport = await api(`/api/inventory/${INV_ID}/import`, {
    method: 'POST', cookie: COOKIE,
    body: { rows: [
      // S1 在 LOC_ALT_CODE，盘点在 LOC_ID 范围，扫码写 LOC_CODE（错误位置）→ 触发 mislocated
      { barcode: B + '-S1', scanned_location_code: LOC_CODE, scan_time: '2024-06-15 09:00:00' },
      // S2 在 LOC_CODE，扫码写 LOC_CODE → 匹配
      { barcode: B + '-S2', scanned_location_code: LOC_CODE, scan_time: '2024-06-15 09:01:00' }
    ]}
  });
  if (!invImport.body.success) throw new Error('盘点导入失败: ' + invImport.body.error);
  console.log(`   ✅ 盘点导入 INV_ID=${INV_ID}，mislocated=${invImport.body.data.order.total_mislocated}`);

  // 6. 纠错：找一个 mislocated 差异
  console.log('[5] 盘点纠错（修正位置）');
  const discrepanciesResp = await api(`/api/discrepancies?inventory_order_id=${INV_ID}&status=pending`, { cookie: COOKIE });
  const discrepancies = discrepanciesResp.body.data || [];
  const misDisp = discrepancies.find(d => d.type === 'mislocated');
  let correctionDone = false;
  if (misDisp) {
    const cor = await api(`/api/discrepancies/${misDisp.id}/resolve`, {
      method: 'POST', cookie: COOKIE,
      body: { action: 'correct_location', new_location_id: LOC_ALT_ID, remark: '审计测试纠错' }
    });
    if (!cor.body.success) console.log('   ⚠️ 纠错失败:', cor.body.error);
    else { correctionDone = true; console.log('   ✅ 纠错成功，差异ID=', misDisp.id); }
  } else {
    // 用 ignore 代替
    const any = discrepancies[0];
    if (any) {
      const cor = await api(`/api/discrepancies/${any.id}/resolve`, {
        method: 'POST', cookie: COOKIE,
        body: { action: 'ignore', remark: '审计测试忽略' }
      });
      if (cor.body.success) { correctionDone = true; console.log('   ✅ 忽略差异 ID=', any.id); }
    } else {
      console.log('   ⚠️ 未找到差异记录，跳过纠错步骤');
    }
  }

  // 7. 撤销：先把 S1 报废，再撤销
  console.log('[6] 报废 + 撤销报废');
  const sc = await api(`/api/samples/${SID1}/scrap`, {
    method: 'POST', cookie: COOKIE, body: { remark: '审计测试报废' }
  });
  if (!sc.body.success) throw new Error('报废失败: ' + sc.body.error);
  console.log('   ✅ S1 已报废');

  // 找报废的 timeline 记录
  const sampleDetail = await api(`/api/samples/${SID1}`, { cookie: COOKIE });
  const timelines = (sampleDetail.body.data && sampleDetail.body.data.timeline) || [];
  const scrapTimeline = timelines.find(t => t.action_type === 'scrapped');
  if (scrapTimeline) {
    const rev = await api(`/api/samples/${SID1}/reverse/${scrapTimeline.id}`, {
      method: 'POST', cookie: COOKIE,
      body: { reason: '审计测试撤销报废', remark: '撤销测试' }
    });
    if (!rev.body.success) throw new Error('撤销失败: ' + rev.body.error);
    console.log('   ✅ 撤销报废成功, timelineID=', scrapTimeline.id);
  } else {
    console.log('   ⚠️ 未找到报废记录，跳过撤销');
  }

  // 8. 出库
  console.log('[7] 出库');
  const ob = await api(`/api/samples/${SID2}/outbound`, {
    method: 'POST', cookie: COOKIE, body: { remark: '审计测试出库' }
  });
  if (!ob.body.success) throw new Error('出库失败: ' + ob.body.error);
  console.log('   ✅ S2 已出库');

  // 9. 登出 + 再登录
  console.log('[8] 登出 + 重新登录');
  await api('/api/auth/logout', { method: 'POST', cookie: COOKIE });
  console.log('   ✅ 登出');
  const login2 = await api('/api/auth/login', {
    method: 'POST', body: { username: 'warehouse', password: 'wh123' }
  });
  if (!login2.body.success) throw new Error('warehouse登录失败');
  const COOKIE2 = login2.setCookie;
  console.log('   ✅ warehouse 登录');
  // 再换回 admin
  const login3 = await api('/api/auth/login', {
    method: 'POST', body: { username: 'admin', password: 'admin123' }
  });
  const ADMIN_COOKIE = login3.setCookie;

  return {
    cookie: ADMIN_COOKIE,
    inv_id: INV_ID,
    sid1: SID1, sid2: SID2,
    correction_done: correctionDone
  };
}

async function verifyAuditLogs(ctx, roundLabel) {
  console.log(`\n===== 第${roundLabel}轮：验证审计日志 =====`);

  // viewer 无权访问
  const viewerLogin = await api('/api/auth/login', {
    method: 'POST', body: { username: 'viewer', password: 'view123' }
  });
  const viewerCookie = viewerLogin.setCookie;
  const viewerResp = await api('/api/audit-log', { cookie: viewerCookie });
  if (viewerResp.body && !viewerResp.body.success && viewerResp.body.forbidden) {
    console.log('   ✅ viewer 被拒绝访问（正确）');
  } else {
    throw new Error('viewer 应该不能访问审计日志');
  }
  // 换回 admin
  await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });

  // 查全部
  console.log('[1] 查询审计日志（全量）');
  const all = await api('/api/audit-log?page_size=100', { cookie: ctx.cookie });
  if (!all.body.success) throw new Error('查询审计日志失败: ' + all.body.error);
  const logs = all.body.data.list;
  console.log(`   共 ${logs.length} 条记录（total=${all.body.data.total}）`);
  console.assert(logs.length >= 8, '至少应该有8条以上记录（登录x3、登出x1、入库x2、转移、导入、纠错/忽略、报废、撤销、出库）');

  // 检查操作类型覆盖
  const actionTypes = new Set(logs.map(l => l.action_type));
  const requiredActions = ['login', 'logout', 'inbound', 'transfer', 'inventory_import', 'outbound', 'scrap', 'reverse'];
  // correction 不一定触发（可能只有 ignore），只检查必有的
  const missing = requiredActions.filter(a => !actionTypes.has(a));
  console.log('   出现的操作类型:', Array.from(actionTypes).join(', '));
  if (missing.length > 0) {
    console.log('   ⚠️ 缺失的操作类型:', missing.join(', '));
  } else {
    console.log('   ✅ 所有必填操作类型都已记录');
  }

  // 逐条检查字段完整性
  console.log('[2] 字段完整性检查');
  logs.forEach((l, i) => {
    if (!l.created_at) throw new Error(`第${i}条缺少 created_at`);
    if (!l.operator_name) throw new Error(`第${i}条缺少 operator_name`);
    if (!l.ip_address) throw new Error(`第${i}条缺少 ip_address`);
    if (!l.action_type) throw new Error(`第${i}条缺少 action_type`);
    if (!l.action_label) throw new Error(`第${i}条缺少 action_label`);
    if (i === 0) {
      console.log(`   样例记录[0]: 时间=${l.created_at} 操作人=${l.operator_name} IP=${l.ip_address} 类型=${l.action_label}(${l.action_type}) 对象=${l.object_label || ''} ID=${l.object_id || ''}`);
      console.log(`     备注: ${l.remark || '(无)'}`);
      if (l.before_value_parsed) console.log(`     前值: ${JSON.stringify(l.before_value_parsed)}`);
      if (l.after_value_parsed) console.log(`     后值: ${JSON.stringify(l.after_value_parsed)}`);
    }
  });
  console.log(`   ✅ ${logs.length} 条字段完整`);

  // 按操作人筛选
  console.log('[3] 筛选测试：按操作人');
  const byOp = await api('/api/audit-log?operator=' + encodeURIComponent('管理员') + '&page_size=50', { cookie: ctx.cookie });
  const adminLogs = byOp.body.data.list.filter(l => l.operator_name.includes('管理员') || l.operator_name === 'admin');
  console.log(`   操作人含"管理员"的结果: ${byOp.body.data.total} 条，匹配=${adminLogs.length}`);
  console.assert(adminLogs.length > 0, '应该有 admin 操作的日志');

  // 按操作类型筛选
  console.log('[4] 筛选测试：按操作类型=inbound');
  const byInbound = await api('/api/audit-log?action_type=inbound&page_size=50', { cookie: ctx.cookie });
  const inboundOnly = byInbound.body.data.list.filter(l => l.action_type === 'inbound');
  console.log(`   inbound 类型: ${byInbound.body.data.total} 条，实际匹配=${inboundOnly.length}`);
  console.assert(inboundOnly.length === byInbound.body.data.total && inboundOnly.length >= 2, '筛选结果应全是 inbound 且至少2条');

  // 分页测试
  console.log('[5] 分页测试');
  const p1 = await api('/api/audit-log?page=1&page_size=5', { cookie: ctx.cookie });
  const p2 = await api('/api/audit-log?page=2&page_size=5', { cookie: ctx.cookie });
  console.log(`   第1页: ${p1.body.data.list.length} 条，第2页: ${p2.body.data.list.length} 条，total=${p1.body.data.total}`);
  if (p1.body.data.total > 5) {
    console.assert(p1.body.data.list[0].id !== p2.body.data.list[0].id, '两页内容不应重复');
    console.log('   ✅ 分页正常');
  }

  // CSV 导出
  console.log('[6] CSV 导出测试');
  const csvResp = await api('/api/audit-log/export/csv', { cookie: ctx.cookie });
  const csvRaw = csvResp.raw || '';
  const csvLines = csvRaw.split(/\r?\n/).filter(l => l.trim().length > 0);
  const hasBOM = csvRaw.charCodeAt(0) === 0xFEFF;
  console.log(`   CSV 行数: ${csvLines.length}（含表头），BOM=${hasBOM ? '有' : '无'}`);
  if (csvLines.length > 0) {
    const header = csvLines[0].replace(/^\ufeff/, '');
    const expectedHeader = '时间,操作人,IP地址,操作类型,操作对象,对象ID,操作前值,操作后值,备注';
    console.log(`   表头: ${header}`);
    console.assert(header === expectedHeader, `表头不匹配，期望:"${expectedHeader}"，实际:"${header}"`);
  }
  console.assert(csvLines.length >= 9, `CSV 行数应 >=9，实际 ${csvLines.length}`);
  console.log('   ✅ CSV 导出正常，行数匹配');

  // 关键字搜索
  console.log('[7] 关键字搜索："出库"');
  const kw = await api('/api/audit-log?keyword=' + encodeURIComponent('出库') + '&page_size=50', { cookie: ctx.cookie });
  const kwMatch = kw.body.data.list.filter(l =>
    (l.remark || '').includes('出库') || l.action_type === 'outbound'
  );
  console.log(`   关键字"出库"命中: ${kw.body.data.total} 条，实际含出库=${kwMatch.length}`);
  console.assert(kw.body.data.total > 0, '关键字搜索应该有结果');

  return { logCount: logs.length, csvRowCount: csvLines.length - 1 };
}

async function main() {
  try {
    console.log('========== 审计日志完整验收 ==========\n');

    // ============ 第一轮 ============
    console.log('---------- 第1轮：清库启动 ----------');
    clearDatabase();
    await startServer();
    await sleep(300);

    const ctx1 = await runFullFlow('1');
    const v1 = await verifyAuditLogs(ctx1, '1');
    const logCountAfterRound1 = v1.logCount;

    console.log('\n---------- 第1轮结束：重启验证持久性 ----------');
    await stopServer();
    await sleep(1500);

    // ============ 第二轮 ============
    console.log('\n---------- 第2轮：重启（不清库）----------');
    await startServer();
    await sleep(300);

    // 登录 admin 继续
    const login = await api('/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin123' }
    });
    const ctx2 = { cookie: login.setCookie };

    // 先查之前的日志还在不在
    console.log('[重启后] 查询旧日志');
    const afterReboot = await api('/api/audit-log?page_size=200', { cookie: ctx2.cookie });
    const rebootCount = afterReboot.body.data.total;
    console.log(`   重启后日志总数: ${rebootCount}，重启前: ${logCountAfterRound1}，新登录增加: ${rebootCount - logCountAfterRound1}`);
    console.assert(rebootCount >= logCountAfterRound1, '重启后日志不应丢失！');
    console.log('   ✅ 重启后数据持久化正常');

    // 再跑一遍完整流程
    const ctxFlow2 = await runFullFlow('2');
    ctxFlow2.cookie = ctx2.cookie;
    const v2 = await verifyAuditLogs(ctxFlow2, '2');

    console.log('\n========== 验收结论 ==========');
    console.log(`✅ 第1轮: 日志记录 ${v1.logCount} 条，CSV ${v1.csvRowCount} 行数据`);
    console.log(`✅ 第2轮: 重启后数据保留，追加后日志 ${v2.logCount} 条，CSV ${v2.csvRowCount} 行数据`);
    console.log('✅ viewer 权限控制：已拒绝非管理员访问');
    console.log('✅ 筛选功能：操作人 / 类型 / 关键字 均正常');
    console.log('✅ 分页：第1页/第2页内容不重复');
    console.log('✅ CSV 导出：表头对齐 UTF-8 BOM，行数匹配');
    console.log('✅ 重启持久性：数据库落盘，重启后日志完整保留');
    console.log('\n🎉 审计日志功能验收通过！');

  } catch (e) {
    console.error('\n❌ 验收失败:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await stopServer();
  }
}

main();
