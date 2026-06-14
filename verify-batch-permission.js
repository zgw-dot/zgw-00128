const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = 'localhost';
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'data', 'tracker.db');

let SERVER_PROC = null;
let errors = 0;

function api(urlPath, opts = {}) {
  return new Promise(resolve => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const req = http.request({
      hostname: HOST, port: PORT, path: urlPath,
      method: opts.method || 'GET', headers,
      timeout: opts.timeout || 15000
    }, res => {
      let data = '';
      const setCookie = res.headers['set-cookie'] || [];
      res.on('data', c => data += c);
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body, setCookie: setCookie[0] || null });
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

function assert(condition, msg) {
  if (!condition) {
    console.log(`   ❌ 失败: ${msg}`);
    errors++;
  } else {
    console.log(`   ✅ 通过: ${msg}`);
  }
}

function clearDatabase() {
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    console.log('   数据库已删除');
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
    SERVER_PROC.stdout.on('data', d => {
      if (!started && d.toString().includes('冷链样本追踪系统已启动')) {
        started = true;
        setTimeout(resolve, 500);
      }
    });
    setTimeout(() => { if (!started) reject(new Error('服务器启动超时')); }, 15000);
  });
}

function stopServer() {
  return new Promise(resolve => {
    if (!SERVER_PROC) { resolve(); return; }
    SERVER_PROC.on('exit', resolve);
    SERVER_PROC.kill('SIGTERM');
    setTimeout(() => { if (SERVER_PROC) SERVER_PROC.kill('SIGKILL'); }, 5000);
  });
}

async function main() {
  try {
    console.log('========== 批量操作 + 权限细化验收 ==========\n');

    clearDatabase();
    await startServer();
    await sleep(300);

    // ===== 场景1: 两个库管员分别绑冷藏和冷冻，互相看不到对方数据 =====
    console.log('\n===== 场景1: 温区权限隔离 =====');

    console.log('[1] 冷藏库管员登录');
    const coldLogin = await api('/api/auth/login', {
      method: 'POST', body: { username: 'wh_cold', password: 'whcold123' }
    });
    assert(coldLogin.body.success, '冷藏库管员登录成功');
    const COLD_COOKIE = coldLogin.setCookie;
    assert(coldLogin.body.data.zone_ids && coldLogin.body.data.zone_ids.length === 1, '登录返回 zone_ids 长度=1');
    console.log(`   zone_ids: ${JSON.stringify(coldLogin.body.data.zone_ids)}`);

    console.log('[2] 冷冻库管员登录');
    const frozenLogin = await api('/api/auth/login', {
      method: 'POST', body: { username: 'wh_frozen', password: 'whfrozen123' }
    });
    assert(frozenLogin.body.success, '冷冻库管员登录成功');
    const FROZEN_COOKIE = frozenLogin.setCookie;

    console.log('[3] 冷藏库管员查看库位 - 只能看冷藏区');
    const coldLocs = await api('/api/locations', { cookie: COLD_COOKIE });
    assert(coldLocs.body.success, '冷藏库管员查库位成功');
    const coldZoneNames = [...new Set(coldLocs.body.data.map(l => l.zone_name))];
    console.log(`   可见温区: ${coldZoneNames.join(', ')}`);
    assert(coldZoneNames.length === 1 && coldZoneNames[0].includes('冷藏'), '冷藏库管员只能看冷藏库位');

    console.log('[4] 冷冻库管员查看库位 - 只能看冷冻区');
    const frozenLocs = await api('/api/locations', { cookie: FROZEN_COOKIE });
    assert(frozenLocs.body.success, '冷冻库管员查库位成功');
    const frozenZoneNames = [...new Set(frozenLocs.body.data.map(l => l.zone_name))];
    console.log(`   可见温区: ${frozenZoneNames.join(', ')}`);
    assert(frozenZoneNames.length === 1 && frozenZoneNames[0].includes('冷冻'), '冷冻库管员只能看冷冻库位');

    // ===== 场景2: 各批量入库5个样本 =====
    console.log('\n===== 场景2: 批量入库 =====');

    console.log('[5] 冷藏库管员批量入库5个样本');
    const coldLocId = coldLocs.body.data[0].id;
    const coldLocCode = coldLocs.body.data[0].code;
    const coldSamples = [];
    for (let i = 1; i <= 5; i++) {
      const res = await api('/api/samples', {
        method: 'POST', cookie: COLD_COOKIE,
        body: { barcode: `COLD-B${i}`, batch_no: 'BATCH-COLD', name: `冷藏样本${i}`, required_zone_id: coldLogin.body.data.zone_ids[0] }
      });
      assert(res.body.success, `创建冷藏样本${i}成功`);
      if (res.body.success) coldSamples.push(res.body.data.id);
    }

    const coldBatchIn = await api('/api/samples/batch/inbound', {
      method: 'POST', cookie: COLD_COOKIE,
      body: {
        items: coldSamples.map(id => ({ sample_id: id, location_id: coldLocId })),
        remark: '冷藏批量入库'
      }
    });
    assert(coldBatchIn.body.success, `冷藏批量入库5个样本成功 (success=${coldBatchIn.body.data.success})`);
    if (!coldBatchIn.body.success) console.log(`   错误: ${coldBatchIn.body.error}`);

    console.log('[6] 冷冻库管员批量入库5个样本');
    const frozenLocId = frozenLocs.body.data[0].id;
    const frozenSamples = [];
    for (let i = 1; i <= 5; i++) {
      const res = await api('/api/samples', {
        method: 'POST', cookie: FROZEN_COOKIE,
        body: { barcode: `FROZ-B${i}`, batch_no: 'BATCH-FROZ', name: `冷冻样本${i}`, required_zone_id: frozenLogin.body.data.zone_ids[0] }
      });
      assert(res.body.success, `创建冷冻样本${i}成功`);
      if (res.body.success) frozenSamples.push(res.body.data.id);
    }

    const frozenBatchIn = await api('/api/samples/batch/inbound', {
      method: 'POST', cookie: FROZEN_COOKIE,
      body: {
        items: frozenSamples.map(id => ({ sample_id: id, location_id: frozenLocId })),
        remark: '冷冻批量入库'
      }
    });
    assert(frozenBatchIn.body.success, `冷冻批量入库5个样本成功 (success=${frozenBatchIn.body.data.success})`);
    if (!frozenBatchIn.body.success) console.log(`   错误: ${frozenBatchIn.body.error}`);

    console.log('[7] 互相看不到对方数据');
    const coldSamplesList = await api('/api/samples', { cookie: COLD_COOKIE });
    assert(coldSamplesList.body.success, '冷藏库管员查样本成功');
    const coldBarcodes = coldSamplesList.body.data.map(s => s.barcode);
    console.log(`   冷藏库管员可见样本: ${coldBarcodes.join(', ')}`);
    assert(coldBarcodes.every(b => b.startsWith('COLD')), '冷藏库管员只看到冷藏样本');
    assert(!coldBarcodes.some(b => b.startsWith('FROZ')), '冷藏库管员看不到冷冻样本');

    const frozenSamplesList = await api('/api/samples', { cookie: FROZEN_COOKIE });
    assert(frozenSamplesList.body.success, '冷冻库管员查样本成功');
    const frozenBarcodes = frozenSamplesList.body.data.map(s => s.barcode);
    console.log(`   冷冻库管员可见样本: ${frozenBarcodes.join(', ')}`);
    assert(frozenBarcodes.every(b => b.startsWith('FROZ')), '冷冻库管员只看到冷冻样本');
    assert(!frozenBarcodes.some(b => b.startsWith('COLD')), '冷冻库管员看不到冷藏样本');

    // ===== 场景3: 只读用户所有写操作被拦 =====
    console.log('\n===== 场景3: 只读用户写操作拦截 =====');

    console.log('[8] 只读用户登录');
    const viewerLogin = await api('/api/auth/login', {
      method: 'POST', body: { username: 'viewer', password: 'view123' }
    });
    assert(viewerLogin.body.success, '只读用户登录成功');
    const VIEWER_COOKIE = viewerLogin.setCookie;

    console.log('[9] 只读用户尝试创建样本');
    const viewerCreate = await api('/api/samples', {
      method: 'POST', cookie: VIEWER_COOKIE,
      body: { barcode: 'VIEWER-TEST', batch_no: 'BATCH-V', name: '只读测试' }
    });
    assert(!viewerCreate.body.success && viewerCreate.body.forbidden, '只读用户创建样本被拦');

    console.log('[10] 只读用户尝试入库');
    const viewerInbound = await api(`/api/samples/${coldSamples[0]}/inbound`, {
      method: 'POST', cookie: VIEWER_COOKIE,
      body: { location_id: coldLocId }
    });
    assert(!viewerInbound.body.success && viewerInbound.body.forbidden, '只读用户入库被拦');

    console.log('[11] 只读用户尝试转移');
    const viewerTransfer = await api(`/api/samples/${coldSamples[0]}/transfer`, {
      method: 'POST', cookie: VIEWER_COOKIE,
      body: { to_location_id: coldLocId }
    });
    assert(!viewerTransfer.body.success && viewerTransfer.body.forbidden, '只读用户转移被拦');

    console.log('[12] 只读用户尝试出库');
    const viewerOutbound = await api(`/api/samples/${coldSamples[0]}/outbound`, {
      method: 'POST', cookie: VIEWER_COOKIE,
      body: { remark: '只读测试' }
    });
    assert(!viewerOutbound.body.success && viewerOutbound.body.forbidden, '只读用户出库被拦');

    console.log('[13] 只读用户尝试报废');
    const viewerScrap = await api(`/api/samples/${coldSamples[0]}/scrap`, {
      method: 'POST', cookie: VIEWER_COOKIE,
      body: { remark: '只读测试' }
    });
    assert(!viewerScrap.body.success && viewerScrap.body.forbidden, '只读用户报废被拦');

    console.log('[14] 只读用户尝试批量入库');
    const viewerBatch = await api('/api/samples/batch/inbound', {
      method: 'POST', cookie: VIEWER_COOKIE,
      body: { items: [{ sample_id: coldSamples[0], location_id: coldLocId }] }
    });
    assert(!viewerBatch.body.success && viewerBatch.body.forbidden, '只读用户批量入库被拦');

    // ===== 场景4: 批量入库混一条异常样本，整批回滚 =====
    console.log('\n===== 场景4: 批量操作异常回滚 =====');

    console.log('[15] admin 登录，先确认当前样本数');
    const adminLogin = await api('/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin123' }
    });
    assert(adminLogin.body.success, 'admin 登录成功');
    const ADMIN_COOKIE = adminLogin.setCookie;

    const beforeSamples = await api('/api/samples', { cookie: ADMIN_COOKIE });
    const beforeCount = beforeSamples.body.data.length;
    const beforeInStorage = beforeSamples.body.data.filter(s => s.status === 'in_storage').length;
    console.log(`   回滚前: 总样本=${beforeCount}, 在库=${beforeInStorage}`);

    console.log('[16] 创建6个样本，其中1个先入库（模拟异常）');
    const batchTestSamples = [];
    for (let i = 1; i <= 6; i++) {
      const res = await api('/api/samples', {
        method: 'POST', cookie: ADMIN_COOKIE,
        body: { barcode: `ROLLBACK-T${i}`, batch_no: 'BATCH-RB', name: `回滚测试${i}`, required_zone_id: 1 }
      });
      assert(res.body.success, `创建回滚测试样本${i}成功`);
      if (res.body.success) batchTestSamples.push(res.body.data.id);
    }

    console.log('[17] 先把第1个样本单独入库');
    const firstInbound = await api(`/api/samples/${batchTestSamples[0]}/inbound`, {
      method: 'POST', cookie: ADMIN_COOKIE,
      body: { location_id: coldLocId }
    });
    assert(firstInbound.body.success, '第1个样本单独入库成功');

    console.log('[18] 尝试批量入库6个样本（包含已入库的第1个，应整批回滚）');
    const allLocs = await api('/api/locations', { cookie: ADMIN_COOKIE });
    const rAColdLoc = allLocs.body.data.find(l => l.code === 'R-A1');
    const rollbackBatch = await api('/api/samples/batch/inbound', {
      method: 'POST', cookie: ADMIN_COOKIE,
      body: {
        items: batchTestSamples.map(id => ({ sample_id: id, location_id: rAColdLoc.id })),
        remark: '回滚测试批量入库'
      }
    });
    assert(!rollbackBatch.body.success, '批量入库失败（符合预期）');
    assert(rollbackBatch.body.rollback === true, '整批已回滚');
    console.log(`   回滚原因: ${rollbackBatch.body.error}`);

    console.log('[19] 确认回滚后数据没变');
    const afterSamples = await api('/api/samples', { cookie: ADMIN_COOKIE });
    const afterInStorage = afterSamples.body.data.filter(s => s.status === 'in_storage').length;
    const afterPending = afterSamples.body.data.filter(s => s.status === 'pending').length;
    console.log(`   回滚后: 在库=${afterInStorage}, 待入库=${afterPending}`);

    const sample1 = await api(`/api/samples/${batchTestSamples[0]}`, { cookie: ADMIN_COOKIE });
    assert(sample1.body.data.status === 'in_storage', '第1个样本仍为在库（之前单独入库的）');

    const sample2 = await api(`/api/samples/${batchTestSamples[1]}`, { cookie: ADMIN_COOKIE });
    assert(sample2.body.data.status === 'pending', '第2个样本仍为待入库（回滚后没变）');

    // ===== 场景5: 库管员不能操作别人温区的样本 =====
    console.log('\n===== 场景5: 跨温区操作拦截 =====');

    console.log('[20] 冷藏库管员尝试操作冷冻样本');
    const crossZoneOutbound = await api(`/api/samples/${frozenSamples[0]}/outbound`, {
      method: 'POST', cookie: COLD_COOKIE,
      body: { remark: '跨区测试' }
    });
    assert(!crossZoneOutbound.body.success && crossZoneOutbound.body.forbidden, '冷藏库管员不能操作冷冻温区样本');

    console.log('[21] 冷冻库管员尝试操作冷藏样本');
    const crossZoneTransfer = await api(`/api/samples/${coldSamples[0]}/transfer`, {
      method: 'POST', cookie: FROZEN_COOKIE,
      body: { to_location_id: frozenLocId }
    });
    assert(!crossZoneTransfer.body.success && crossZoneTransfer.body.forbidden, '冷冻库管员不能操作冷藏温区样本');

    console.log('[22] 冷藏库管员尝试在冷冻库位入库');
    const crossZoneInbound = await api(`/api/samples/${batchTestSamples[1]}/inbound`, {
      method: 'POST', cookie: COLD_COOKIE,
      body: { location_id: frozenLocId }
    });
    assert(!crossZoneInbound.body.success && crossZoneInbound.body.forbidden, '冷藏库管员不能在冷冻库位入库');

    // ===== 场景6: 批量转移和出库 =====
    console.log('\n===== 场景6: 批量转移和出库 =====');

    console.log('[23] 冷藏库管员批量转移2个样本');
    const rA2Loc = coldLocs.body.data.find(l => l.code === 'R-A2');
    if (rA2Loc) {
      const batchTransfer = await api('/api/samples/batch/transfer', {
        method: 'POST', cookie: COLD_COOKIE,
        body: {
          items: coldSamples.slice(0, 2).map(id => ({ sample_id: id, to_location_id: rA2Loc.id })),
          remark: '批量转移测试'
        }
      });
      assert(batchTransfer.body.success, `批量转移2个样本成功 (success=${batchTransfer.body.data.success})`);
      if (!batchTransfer.body.success) console.log(`   错误: ${batchTransfer.body.error}`);
    }

    console.log('[24] 冷冻库管员批量出库2个样本');
    const batchOutbound = await api('/api/samples/batch/outbound', {
      method: 'POST', cookie: FROZEN_COOKIE,
      body: {
        items: frozenSamples.slice(0, 2).map(id => ({ sample_id: id })),
        remark: '批量出库测试'
      }
    });
    assert(batchOutbound.body.success, `批量出库2个样本成功 (success=${batchOutbound.body.data.success})`);
    if (!batchOutbound.body.success) console.log(`   错误: ${batchOutbound.body.error}`);

    // ===== 场景7: 用户温区权限管理 API =====
    console.log('\n===== 场景7: 用户温区权限管理 API =====');

    console.log('[25] 查询用户温区权限');
    const accessList = await api('/api/user-zone-access', { cookie: ADMIN_COOKIE });
    assert(accessList.body.success, '查询用户温区权限成功');
    console.log(`   共 ${accessList.body.data.length} 条权限记录`);

    console.log('[26] 非管理员不能访问权限管理');
    const forbiddenAccess = await api('/api/user-zone-access', { cookie: COLD_COOKIE });
    assert(!forbiddenAccess.body.success && forbiddenAccess.body.forbidden, '库管员无权访问权限管理');

    // ===== 最终结果 =====
    console.log('\n========== 验收结论 ==========');
    if (errors === 0) {
      console.log('🎉 所有验收场景全部通过！');
    } else {
      console.log(`❌ 有 ${errors} 项验收失败`);
      process.exitCode = 1;
    }

  } catch (e) {
    console.error('\n❌ 验收异常:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await stopServer();
  }
}

main();
