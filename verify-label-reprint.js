const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = 'localhost';
const PORT = 3002;
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
    let done = false;
    SERVER_PROC.on('exit', () => {
      if (done) return;
      done = true;
      resolve();
    });
    try {
      if (process.platform === 'win32') {
        SERVER_PROC.kill('SIGKILL');
      } else {
        SERVER_PROC.kill('SIGTERM');
        setTimeout(() => {
          if (!done && SERVER_PROC && SERVER_PROC.kill) {
            try { SERVER_PROC.kill('SIGKILL'); } catch(e) {}
          }
        }, 3000);
      }
    } catch(e) {}
    setTimeout(() => {
      if (!done) {
        done = true;
        resolve();
      }
    }, 5000);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function login(username, password) {
  const r = await api('/api/auth/login', {
    method: 'POST', body: { username, password }
  });
  if (!r.body || !r.body.success) throw new Error(`登录失败 ${username}: ${JSON.stringify(r.body)}`);
  return { cookie: r.setCookie, user: r.body.data };
}

async function main() {
  try {
    console.log('========== 样本标签补打功能 专项验收 ==========\n');

    clearDatabase();
    await startServer();
    await sleep(300);

    // ===== [1] 登录并获取用户信息 =====
    console.log('[1] 用户登录');
    const adminSession = await login('admin', 'admin123');
    const ADMIN_ID = adminSession.user.id;
    const ADMIN_NAME = adminSession.user.real_name;
    console.log(`   admin 登录: id=${ADMIN_ID}, name=${ADMIN_NAME}`);

    const whColdSession = await login('wh_cold', 'whcold123');
    const WH_COLD_ID = whColdSession.user.id;
    const WH_COLD_NAME = whColdSession.user.real_name;
    const WH_COLD_ZONES = whColdSession.user.zone_ids || whColdSession.user.accessible_zones || [];
    const whColdCookie = whColdSession.cookie;
    console.log(`   wh_cold 登录: id=${WH_COLD_ID}, name=${WH_COLD_NAME}, zones=${JSON.stringify(WH_COLD_ZONES)}`);

    const viewerSession = await login('viewer', 'view123');
    console.log(`   viewer 登录（只读，用于权限测试）`);

    // 重要：服务器使用全局 currentUser，需要重新登录 admin 来设置全局用户
    await login('admin', 'admin123');

    // ===== [2] 准备测试数据 =====
    console.log('\n[2] 准备测试样本和库位');

    await sleep(500);
    const locs = await api('/api/locations', { cookie: adminSession.cookie });
    const allLocations = locs.body.data || [];
    const zone1Locs = allLocations.filter(l => l.zone_id === 1);
    const zone2Locs = allLocations.filter(l => l.zone_id === 2);
    const ZONE1_LOC_ID = zone1Locs[0].id;
    const ZONE1_LOC_CODE = zone1Locs[0].code;
    const ZONE2_LOC_ID = zone2Locs[0].id;
    const ZONE2_LOC_CODE = zone2Locs[0].code;
    console.log(`   zone1 库位: ${ZONE1_LOC_CODE}(id=${ZONE1_LOC_ID})`);
    console.log(`   zone2 库位: ${ZONE2_LOC_CODE}(id=${ZONE2_LOC_ID})`);

    const TS = Date.now().toString(36);
    const BATCH_NO = 'LR-TEST-' + TS;

    const testSamples = [
      { suffix: 'A', status: 'pending', zone_id: 1, loc_id: null },
      { suffix: 'B', status: 'in_storage', zone_id: 1, loc_id: ZONE1_LOC_ID },
      { suffix: 'C', status: 'in_storage', zone_id: 2, loc_id: ZONE2_LOC_ID },
      { suffix: 'D', status: 'outbound', zone_id: 1, loc_id: null },
      { suffix: 'E', status: 'scrapped', zone_id: 1, loc_id: null }
    ];

    const sampleMap = {};
    for (const ts of testSamples) {
      const barcode = `${BATCH_NO}-${ts.suffix}`;
      const r = await api('/api/samples', {
        method: 'POST', cookie: adminSession.cookie,
        body: { barcode, batch_no: BATCH_NO, name: `补打测试样本${ts.suffix}`, required_zone_id: ts.zone_id }
      });
      assert(r.body.success, `样本${ts.suffix}登记失败: ${r.body.error}`);
      const sampleId = r.body.data.id;
      sampleMap[ts.suffix] = { id: sampleId, barcode, ...ts };

      if (ts.status === 'in_storage') {
        const ib = await api(`/api/samples/${sampleId}/inbound`, {
          method: 'POST', cookie: adminSession.cookie,
          body: { location_id: ts.loc_id }
        });
        assert(ib.body.success, `样本${ts.suffix}入库失败: ${ib.body.error}`);
      } else if (ts.status === 'outbound') {
        const ib = await api(`/api/samples/${sampleId}/inbound`, {
          method: 'POST', cookie: adminSession.cookie,
          body: { location_id: ZONE1_LOC_ID }
        });
        const ob = await api(`/api/samples/${sampleId}/outbound`, {
          method: 'POST', cookie: adminSession.cookie,
          body: { remark: '测试出库' }
        });
        assert(ob.body.success, `样本${ts.suffix}出库失败: ${ob.body.error}`);
      } else if (ts.status === 'scrapped') {
        const ib = await api(`/api/samples/${sampleId}/inbound`, {
          method: 'POST', cookie: adminSession.cookie,
          body: { location_id: ZONE1_LOC_ID }
        });
        const sc = await api(`/api/samples/${sampleId}/scrap`, {
          method: 'POST', cookie: adminSession.cookie,
          body: { reason: '测试报废' }
        });
        assert(sc.body.success, `样本${ts.suffix}报废失败: ${sc.body.error}`);
      }
    }
    console.log('   ✅ 5个测试样本准备完成');

    // ===== [3] 成功补打：管理员给在库样本补打 =====
    console.log('\n[3] 成功补打：管理员给在库样本补打标签');
    const reprint3 = await api(`/api/samples/${sampleMap.B.id}/reprint-label`, {
      method: 'POST', cookie: adminSession.cookie,
      body: { reason: '标签损坏', copies: 3 }
    });
    assert(reprint3.body.success, `管理员补打失败: ${reprint3.body.error}`);
    const preview = reprint3.body.data.label_preview;
    assert(preview.barcode === sampleMap.B.barcode, `条码不匹配: ${preview.barcode} != ${sampleMap.B.barcode}`);
    assert(preview.batch_no === BATCH_NO, `批次不匹配: ${preview.batch_no} != ${BATCH_NO}`);
    assert(preview.copies === 3, `份数不匹配: ${preview.copies} != 3`);
    assert(preview.operator_name === ADMIN_NAME, `操作人不匹配: ${preview.operator_name} != ${ADMIN_NAME}`);
    assert(preview.reason === '标签损坏', `原因不匹配: ${preview.reason}`);
    assert(preview.location_code === ZONE1_LOC_CODE, `库位不匹配: ${preview.location_code} != ${ZONE1_LOC_CODE}`);
    console.log('   ✅ 标签预览数据正确');
    console.log(`     条码: ${preview.barcode}`);
    console.log(`     批次: ${preview.batch_no}`);
    console.log(`     温区: ${preview.zone_name}`);
    console.log(`     库位: ${preview.location_code}`);
    console.log(`     份数: ${preview.copies}`);
    console.log(`     操作人: ${preview.operator_name}`);

    // 验证时间线记录
    const detail3 = await api(`/api/samples/${sampleMap.B.id}`, { cookie: adminSession.cookie });
    const tl3 = detail3.body.data.timeline || [];
    const reprintTl3 = tl3.find(t => t.action_type === 'label_reprint');
    assert(reprintTl3, '时间线中应包含标签补打记录');
    assert(reprintTl3.action_label === '标签补打', `动作标签错误: ${reprintTl3.action_label}`);
    assert(reprintTl3.operator === ADMIN_NAME, `时间线操作人错误: ${reprintTl3.operator}`);
    console.log('   ✅ 时间线记录正确');

    // ===== [4] 成功补打：管理员给待入库样本补打 =====
    console.log('\n[4] 成功补打：管理员给待入库样本补打标签');
    const reprint4 = await api(`/api/samples/${sampleMap.A.id}/reprint-label`, {
      method: 'POST', cookie: adminSession.cookie,
      body: { reason: '首次打印', copies: 1 }
    });
    assert(reprint4.body.success, `待入库样本补打失败: ${reprint4.body.error}`);
    const preview4 = reprint4.body.data.label_preview;
    assert(preview4.location_code === '待入库', `待入库样本库位应为"待入库"，实际=${preview4.location_code}`);
    console.log('   ✅ 待入库样本补打成功（库位显示为待入库）');

    // ===== [5] 状态冲突：已出库样本不能补打 =====
    console.log('\n[5] 状态冲突：已出库样本不能补打');
    const reprint5 = await api(`/api/samples/${sampleMap.D.id}/reprint-label`, {
      method: 'POST', cookie: adminSession.cookie,
      body: { reason: '测试', copies: 1 }
    });
    assert(!reprint5.body.success, '已出库样本补打应失败');
    assert(reprint5.body.error.includes('已出库'), `错误信息应包含"已出库"，实际=${reprint5.body.error}`);
    console.log(`   ✅ 已出库样本正确拦截: ${reprint5.body.error}`);

    // ===== [6] 状态冲突：已报废样本不能补打 =====
    console.log('\n[6] 状态冲突：已报废样本不能补打');
    const reprint6 = await api(`/api/samples/${sampleMap.E.id}/reprint-label`, {
      method: 'POST', cookie: adminSession.cookie,
      body: { reason: '测试', copies: 1 }
    });
    assert(!reprint6.body.success, '已报废样本补打应失败');
    assert(reprint6.body.error.includes('已报废'), `错误信息应包含"已报废"，实际=${reprint6.body.error}`);
    console.log(`   ✅ 已报废样本正确拦截: ${reprint6.body.error}`);

    // ===== [7] 权限拦截：库管员不能操作无权限温区的样本 =====
    console.log('\n[7] 权限拦截：库管员不能操作zone2的样本');
    await login('wh_cold', 'whcold123'); // 设置全局用户为 wh_cold
    const reprint7 = await api(`/api/samples/${sampleMap.C.id}/reprint-label`, {
      method: 'POST', cookie: whColdCookie,
      body: { reason: '测试越权', copies: 1 }
    });
    assert(!reprint7.body.success, '库管员操作zone2样本应失败');
    assert(reprint7.status === 403 || reprint7.body.error.includes('无权'),
      `应返回403或无权提示，实际status=${reprint7.status}, error=${reprint7.body.error}`);
    console.log(`   ✅ 越权操作正确拦截: status=${reprint7.status}`);

    // ===== [8] 权限验证：库管员可以操作有权限温区的样本 =====
    console.log('\n[8] 权限验证：库管员可以操作zone1的样本');
    // 全局用户已经是 wh_cold 了
    const reprint8 = await api(`/api/samples/${sampleMap.B.id}/reprint-label`, {
      method: 'POST', cookie: whColdCookie,
      body: { reason: '标签模糊', copies: 2 }
    });
    assert(reprint8.body.success, `库管员操作zone1样本应成功，错误=${reprint8.body.error}`);
    const preview8 = reprint8.body.data.label_preview;
    assert(preview8.operator_name === WH_COLD_NAME, `操作人应为${WH_COLD_NAME}，实际=${preview8.operator_name}`);
    console.log(`   ✅ 库管员操作有权限样本成功，操作人=${preview8.operator_name}`);

    // ===== [9] 权限拦截：viewer只读用户不能补打 =====
    console.log('\n[9] 权限拦截：只读用户不能补打');
    await login('viewer', 'view123'); // 设置全局用户为 viewer
    const reprint9 = await api(`/api/samples/${sampleMap.B.id}/reprint-label`, {
      method: 'POST', cookie: viewerSession.cookie,
      body: { reason: '测试', copies: 1 }
    });
    assert(!reprint9.body.success, '只读用户补打应失败');
    assert(reprint9.status === 403 || reprint9.body.error.includes('权限'),
      `应返回403或无权提示，实际status=${reprint9.status}`);
    console.log(`   ✅ 只读用户正确拦截: status=${reprint9.status}`);

    // 重新登录 admin，继续后续测试
    await login('admin', 'admin123');

    // ===== [10] 参数校验：补打原因必填 =====
    console.log('\n[10] 参数校验：补打原因必填');
    const reprint10 = await api(`/api/samples/${sampleMap.B.id}/reprint-label`, {
      method: 'POST', cookie: adminSession.cookie,
      body: { reason: '', copies: 1 }
    });
    assert(!reprint10.body.success, '原因空应失败');
    assert(reprint10.body.error.includes('原因'), `错误信息应提示原因，实际=${reprint10.body.error}`);
    console.log(`   ✅ 空原因正确拦截: ${reprint10.body.error}`);

    // ===== [11] 参数校验：份数范围 1-100 =====
    console.log('\n[11] 参数校验：份数范围 1-100');
    const reprint11a = await api(`/api/samples/${sampleMap.B.id}/reprint-label`, {
      method: 'POST', cookie: adminSession.cookie,
      body: { reason: '测试', copies: 0 }
    });
    assert(!reprint11a.body.success, '份数0应失败');
    const reprint11b = await api(`/api/samples/${sampleMap.B.id}/reprint-label`, {
      method: 'POST', cookie: adminSession.cookie,
      body: { reason: '测试', copies: 101 }
    });
    assert(!reprint11b.body.success, '份数101应失败');
    console.log('   ✅ 份数范围校验正确（0和101均被拦截）');

    // ===== [12] 防重复提交：同一样本1分钟内同一原因重复提交 =====
    console.log('\n[12] 防重复提交：同一样本1分钟内同一原因重复提交');
    const uniqueReason = `测试防重复-${Date.now()}`;
    const reprint12a = await api(`/api/samples/${sampleMap.B.id}/reprint-label`, {
      method: 'POST', cookie: adminSession.cookie,
      body: { reason: uniqueReason, copies: 1 }
    });
    assert(reprint12a.body.success, '第一次提交应成功');

    const reprint12b = await api(`/api/samples/${sampleMap.B.id}/reprint-label`, {
      method: 'POST', cookie: adminSession.cookie,
      body: { reason: uniqueReason, copies: 1 }
    });
    assert(!reprint12b.body.success, '1分钟内同一原因重复提交应拦截');
    assert(reprint12b.body.duplicate_warning === true, '应返回 duplicate_warning 标志');
    assert(reprint12b.body.error.includes('60秒'), `错误信息应提示60秒，实际=${reprint12b.body.error}`);
    console.log(`   ✅ 重复提交正确拦截: ${reprint12b.body.error}`);
    console.log('     duplicate_warning 标志已正确返回');

    // ===== [13] 不同原因的重复提交应允许 =====
    console.log('\n[13] 不同原因的重复提交应允许');
    const reprint13 = await api(`/api/samples/${sampleMap.B.id}/reprint-label`, {
      method: 'POST', cookie: adminSession.cookie,
      body: { reason: uniqueReason + '-不同', copies: 1 }
    });
    assert(reprint13.body.success, '不同原因应允许提交');
    console.log('   ✅ 不同原因的重复提交正常通过');

    // ===== [14] 查询补打记录列表 =====
    console.log('\n[14] 查询补打记录列表');
    const list14 = await api('/api/label-reprints?page_size=50', { cookie: adminSession.cookie });
    assert(list14.body.success, '查询补打记录失败');
    const records14 = list14.body.data.list || [];
    assert(records14.length >= 5, `补打记录应>=5条，实际=${records14.length}`);
    console.log(`   ✅ 补打记录列表正常，共 ${records14.length} 条`);

    // 验证记录字段
    const firstRecord = records14[0];
    const requiredFields = ['id', 'sample_barcode', 'batch_no', 'sample_name', 'zone_name',
      'location_code', 'reason', 'copies', 'operator_name', 'reprint_time'];
    for (const f of requiredFields) {
      assert(firstRecord.hasOwnProperty(f), `记录缺少字段: ${f}`);
    }
    console.log('   ✅ 记录字段完整');

    // ===== [15] 按条码筛选 =====
    console.log('\n[15] 按条码筛选');
    const barcodeFilter = await api(`/api/label-reprints?barcode=${sampleMap.A.barcode}&page_size=50`,
      { cookie: adminSession.cookie });
    const filteredByBarcode = barcodeFilter.body.data.list || [];
    const allMatchBarcode = filteredByBarcode.every(r => r.sample_barcode === sampleMap.A.barcode);
    assert(allMatchBarcode, '按条码筛选结果不正确');
    console.log(`   ✅ 按条码筛选正确，${sampleMap.A.barcode} 共 ${filteredByBarcode.length} 条`);

    // ===== [16] 按批次筛选 =====
    console.log('\n[16] 按批次筛选');
    const batchFilter = await api(`/api/label-reprints?batch_no=${BATCH_NO}&page_size=50`,
      { cookie: adminSession.cookie });
    const filteredByBatch = batchFilter.body.data.list || [];
    const allMatchBatch = filteredByBatch.every(r => r.batch_no === BATCH_NO);
    assert(allMatchBatch, '按批次筛选结果不正确');
    console.log(`   ✅ 按批次筛选正确，${BATCH_NO} 共 ${filteredByBatch.length} 条`);

    // ===== [17] 温区权限过滤：库管员只能看到自己温区的补打记录 =====
    console.log('\n[17] 温区权限过滤：库管员只能看到zone1的补打记录');
    await login('wh_cold', 'whcold123'); // 设置全局用户为 wh_cold
    const whList = await api('/api/label-reprints?page_size=50', { cookie: whColdCookie });
    const whRecords = whList.body.data.list || [];
    const allZone1 = whRecords.every(r => r.zone_id === 1 || r.zone_id === null);
    assert(allZone1, '库管员应只能看到zone1的记录');
    console.log(`   ✅ 库管员权限过滤正确，共 ${whRecords.length} 条（全部属于zone1）`);

    // 重新登录 admin
    await login('admin', 'admin123');

    // ===== [18] 导出CSV =====
    console.log('\n[18] 导出CSV');
    const export18 = await api(`/api/label-reprints/export/csv?batch_no=${BATCH_NO}`,
      { cookie: adminSession.cookie });
    assert(export18.raw && export18.raw.length > 0, 'CSV导出为空');
    assert(export18.raw.includes('\uFEFF'), 'CSV应包含BOM');
    assert(export18.raw.includes('条码'), 'CSV应包含"条码"列');
    assert(export18.raw.includes('批次号'), 'CSV应包含"批次号"列');
    assert(export18.raw.includes('补打原因'), 'CSV应包含"补打原因"列');
    assert(export18.raw.includes('操作人'), 'CSV应包含"操作人"列');
    assert(export18.raw.includes(sampleMap.B.barcode), 'CSV应包含测试样本条码');
    console.log('   ✅ CSV导出内容正确');
    console.log(`     文件大小: ${export18.raw.length} 字节`);
    console.log(`     包含BOM: ${export18.raw.startsWith('\uFEFF')}`);

    // ===== [19] 审计日志验证 =====
    console.log('\n[19] 审计日志验证');
    const audit19 = await api('/api/audit-log?action_type=label_reprint&page_size=50',
      { cookie: adminSession.cookie });
    assert(audit19.body.success, '查询审计日志失败');
    const auditLogs = audit19.body.data.list || [];
    assert(auditLogs.length >= 1, '应至少有1条标签补打审计日志');
    const reprintAudit = auditLogs.find(l => l.object_type === 'label_reprint');
    assert(reprintAudit, '审计日志中应包含 label_reprint 类型');
    assert(reprintAudit.action_label === '标签补打', `审计日志动作标签错误: ${reprintAudit.action_label}`);
    console.log('   ✅ 审计日志记录正确');

    // ===== [20] 重启后查询验证 =====
    console.log('\n[20] 重启验证：补打记录持久化');

    const beforeList = await api('/api/label-reprints?page_size=100', { cookie: adminSession.cookie });
    const beforeCount = beforeList.body.data.total;
    const beforeRecords = beforeList.body.data.list;
    console.log(`   重启前补打记录数: ${beforeCount}`);

    console.log('   正在重启服务器...');
    await stopServer();
    await sleep(2000);
    await startServer();
    await sleep(1000);

    const restartAdmin = await login('admin', 'admin123');
    const afterList = await api('/api/label-reprints?page_size=100', { cookie: restartAdmin.cookie });
    const afterCount = afterList.body.data.total;
    const afterRecords = afterList.body.data.list;

    assert(afterCount === beforeCount,
      `重启后记录数应=${beforeCount}，实际=${afterCount}`);
    assert(afterRecords.length === beforeRecords.length,
      `重启后记录列表长度不匹配`);

    // 验证第一条记录内容一致
    assert(afterRecords[0].sample_barcode === beforeRecords[0].sample_barcode,
      '重启后条码不一致');
    assert(afterRecords[0].reason === beforeRecords[0].reason,
      '重启后原因不一致');
    assert(afterRecords[0].operator_name === beforeRecords[0].operator_name,
      '重启后操作人不一致');

    // 验证时间线和审计日志也保留
    const detailAfter = await api(`/api/samples/${sampleMap.B.id}`, { cookie: restartAdmin.cookie });
    const tlAfter = detailAfter.body.data.timeline || [];
    const reprintTlAfter = tlAfter.find(t => t.action_type === 'label_reprint');
    assert(reprintTlAfter, '重启后时间线记录应保留');

    const auditAfter = await api('/api/audit-log?action_type=label_reprint&page_size=50',
      { cookie: restartAdmin.cookie });
    assert(auditAfter.body.data.list.length >= 1, '重启后审计日志应保留');

    console.log(`   ✅ 重启后数据完整，记录数=${afterCount}`);
    console.log('     补打记录、时间线、审计日志均已持久化');

    // ===== [21] 分页验证 =====
    console.log('\n[21] 分页验证');
    const page1 = await api('/api/label-reprints?page=1&page_size=2',
      { cookie: restartAdmin.cookie });
    const page2 = await api('/api/label-reprints?page=2&page_size=2',
      { cookie: restartAdmin.cookie });
    assert(page1.body.data.page === 1, 'page1页码错误');
    assert(page2.body.data.page === 2, 'page2页码错误');
    assert(page1.body.data.page_size === 2, 'page_size错误');
    assert(page1.body.data.list.length <= 2, 'page1记录数应<=2');
    assert(page2.body.data.list.length <= 2, 'page2记录数应<=2');
    if (page1.body.data.list.length === 2 && page2.body.data.list.length >= 1) {
      assert(page1.body.data.list[0].id !== page2.body.data.list[0].id,
        '分页结果不应重复');
    }
    console.log('   ✅ 分页功能正常');

    // ===== 验收结论 =====
    console.log('\n========== 验收结论 ==========');
    console.log('✅ 成功补打：管理员给在库样本补打，标签预览数据正确');
    console.log('✅ 成功补打：管理员给待入库样本补打');
    console.log('✅ 成功补打：库管员给有权限温区的样本补打');
    console.log('✅ 状态冲突：已出库样本正确拦截');
    console.log('✅ 状态冲突：已报废样本正确拦截');
    console.log('✅ 权限拦截：库管员不能操作无权限温区的样本');
    console.log('✅ 权限拦截：只读用户不能补打');
    console.log('✅ 参数校验：补打原因必填');
    console.log('✅ 参数校验：份数范围 1-100');
    console.log('✅ 防重复提交：1分钟内同一原因重复提交被拦截，返回duplicate_warning标志');
    console.log('✅ 不同原因的重复提交正常允许');
    console.log('✅ 时间线记录：每次补打正确写入样本时间线');
    console.log('✅ 审计日志：每次补打正确写入审计日志');
    console.log('✅ 补打记录列表：查询正常，字段完整');
    console.log('✅ 按条码筛选功能正常');
    console.log('✅ 按批次筛选功能正常');
    console.log('✅ 温区权限过滤：库管员只能看到自己温区的记录');
    console.log('✅ CSV导出：内容正确，带BOM支持中文');
    console.log('✅ 分页功能正常');
    console.log('✅ 重启后数据持久化：补打记录、时间线、审计日志均保留');
    console.log('\n🎉 样本标签补打功能 专项验收通过！');

  } catch (e) {
    console.error('\n❌ 验收失败:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await stopServer();
  }
}

main();
