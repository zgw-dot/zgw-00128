const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = 'localhost';
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'data', 'tracker.db');
const RESULT_PATH = path.join(__dirname, 'verify-result.txt');

let SERVER_PROC = null;
let passCount = 0;
let failCount = 0;
const failures = [];

function log(msg) {
  console.log(msg);
}

function api(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (opts.cookie) headers['Cookie'] = opts.cookie;
      const req = http.request({
        hostname: HOST, port: PORT, path: urlPath,
        method: opts.method || 'GET', headers,
        timeout: opts.timeout || 15000
      }, res => {
        let data = '';
        const setCookie = res.headers['set-cookie'] || [];
        res.on('data', c => { try { data += c; } catch {} });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(data); } catch (e) { body = data; }
          resolve({ status: res.statusCode, body, setCookie: setCookie[0] || null });
        });
      });
      req.on('error', e => resolve({ status: 0, body: null, error: e.message }));
      req.on('timeout', () => {
        try { req.destroy(); } catch {}
        resolve({ status: 0, body: null, error: 'timeout' });
      });
      if (opts.body) {
        try { req.write(JSON.stringify(opts.body)); } catch (e) { reject(e); return; }
      }
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function assert(name, condition, reason) {
  if (condition) {
    passCount++;
    log(`   ✅ 通过: ${name}`);
  } else {
    failCount++;
    failures.push({ name, reason: reason || '断言失败' });
    log(`   ❌ 失败: ${name}` + (reason ? ` (${reason})` : ''));
  }
}

function clearDatabase() {
  try {
    if (fs.existsSync(DB_PATH)) {
      fs.unlinkSync(DB_PATH);
    }
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    log('   数据库已清空');
  } catch (e) {
    log('   清空数据库警告: ' + e.message);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    try {
      SERVER_PROC = spawn(process.execPath, ['server.js'], {
        cwd: __dirname,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let started = false;
      let stdoutBuf = '';
      let stderrBuf = '';

      SERVER_PROC.stdout.on('data', d => {
        try {
          const s = d.toString();
          stdoutBuf += s;
          if (!started && s.includes('冷链样本追踪系统已启动')) {
            started = true;
            setTimeout(resolve, 500);
          }
        } catch {}
      });

      SERVER_PROC.stderr.on('data', d => {
        try { stderrBuf += d.toString(); } catch {}
      });

      SERVER_PROC.on('error', e => {
        if (!started) reject(new Error('服务器启动失败: ' + e.message));
      });

      SERVER_PROC.on('exit', code => {
        if (!started) reject(new Error('服务器异常退出，代码: ' + code + ', stderr: ' + stderrBuf));
      });

      setTimeout(() => {
        if (!started) reject(new Error('服务器启动超时(15s)，stdout: ' + stdoutBuf));
      }, 15000);
    } catch (e) {
      reject(e);
    }
  });
}

function stopServer() {
  return new Promise(resolve => {
    if (!SERVER_PROC || SERVER_PROC.killed) { resolve(); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    SERVER_PROC.on('exit', finish);
    SERVER_PROC.on('close', finish);
    try { SERVER_PROC.kill('SIGTERM'); } catch (e) { log('  停止服务警告: ' + e.message); }
    setTimeout(() => {
      if (!done) {
        try { SERVER_PROC.kill('SIGKILL'); } catch {}
        setTimeout(finish, 500);
      }
    }, 5000);
  });
}

function writeResult() {
  const lines = [];
  lines.push('=== 批量操作 + 权限细化验收报告 ===');
  lines.push('日期: ' + new Date().toLocaleString());
  lines.push('');
  lines.push(`通过: ${passCount}`);
  lines.push(`失败: ${failCount}`);
  lines.push('');
  if (failures.length > 0) {
    lines.push('--- 失败明细 ---');
    failures.forEach((f, i) => {
      lines.push(`${i + 1}. ${f.name}`);
      lines.push(`   原因: ${f.reason}`);
    });
    lines.push('');
  } else {
    lines.push('🎉 所有验收场景全部通过！');
    lines.push('');
  }
  lines.push('=== 结束 ===');
  const content = lines.join('\n');
  try {
    fs.writeFileSync(RESULT_PATH, content, 'utf8');
    log(`\n   结果已写入: ${RESULT_PATH}`);
  } catch (e) {
    log('\n   写入结果文件失败: ' + e.message);
  }
  return content;
}

function runCase(name, fn) {
  return new Promise(async resolve => {
    log('\n【' + name + '】');
    try {
      await fn();
    } catch (e) {
      failCount++;
      failures.push({ name, reason: '异常: ' + (e.message || e) });
      log('   ❌ 异常: ' + (e.message || e));
      if (e.stack) log('   堆栈: ' + e.stack.split('\n').slice(0, 3).join('\n   '));
    }
    resolve();
  });
}

async function main() {
  log('========== 批量操作 + 权限细化验收 ==========\n');

  clearDatabase();

  try {
    await startServer();
    log('   服务器启动成功\n');
  } catch (e) {
    log('❌ 服务器启动失败: ' + e.message);
    failCount++;
    failures.push({ name: '服务器启动', reason: e.message });
    writeResult();
    process.exit(1);
    return;
  }

  await sleep(200);

  // 当前登录的 cookie（服务端是全局单用户，所以用 currentUser 状态）
  // 注意：这个项目没有真正的 session，是全局 currentUser 变量，所以 cookie 不影响
  // 直接通过登录接口切换用户

  try {

    await runCase('场景1: 冷藏库管员温区隔离', async () => {
      const loginRes = await api('/api/auth/login', {
        method: 'POST', body: { username: 'wh_cold', password: 'whcold123' }
      });
      assert('登录成功', loginRes.body && loginRes.body.success, '返回: ' + JSON.stringify(loginRes.body));
      assert('返回 zone_ids', loginRes.body.data && loginRes.body.data.zone_ids && loginRes.body.data.zone_ids.length === 1,
        'zone_ids: ' + JSON.stringify(loginRes.body.data?.zone_ids));

      const locs = await api('/api/locations');
      assert('查库位成功', locs.body && locs.body.success);
      const zoneNames = [...new Set(locs.body.data.map(l => l.zone_name))];
      assert('只能看到冷藏库位', zoneNames.length === 1 && zoneNames[0].includes('冷藏'),
        '实际温区: ' + zoneNames.join(','));

      const zones = await api('/api/zones');
      assert('查温区成功', zones.body && zones.body.success);
      assert('只能看到冷藏温区', zones.body.data.length === 1 && zones.body.data[0].name.includes('冷藏'),
        '温区列表: ' + JSON.stringify(zones.body.data));

      const coldZoneId = loginRes.body.data.zone_ids[0];
      const coldLocId = locs.body.data[0].id;

      const samples = [];
      for (let i = 1; i <= 5; i++) {
        const r = await api('/api/samples', {
          method: 'POST',
          body: { barcode: 'BATCH-COLD-' + i, batch_no: 'BC', name: '冷藏样本' + i, required_zone_id: coldZoneId }
        });
        if (r.body && r.body.success) samples.push(r.body.data.id);
      }
      assert('创建5个冷藏样本', samples.length === 5, '实际: ' + samples.length);

      const batchIn = await api('/api/samples/batch/inbound', {
        method: 'POST',
        body: { items: samples.map(id => ({ sample_id: id, location_id: coldLocId })), remark: '批量入库测试' }
      });
      assert('批量入库5个成功', batchIn.body && batchIn.body.success && batchIn.body.data.success === 5,
        '返回: ' + JSON.stringify(batchIn.body));

      const sampleList = await api('/api/samples');
      const barcodes = sampleList.body.data.map(s => s.barcode);
      assert('列表只看到冷藏样本', barcodes.every(b => b.startsWith('BATCH-COLD-')),
        '条码: ' + barcodes.join(','));

      // 记下来给后续跨区测试用
      global.__testState = { coldZoneId, coldLocId, coldSampleIds: samples };
    });

    await runCase('场景2: 冷冻库管员温区隔离', async () => {
      const state = global.__testState || {};
      const loginRes = await api('/api/auth/login', {
        method: 'POST', body: { username: 'wh_frozen', password: 'whfrozen123' }
      });
      assert('登录成功', loginRes.body && loginRes.body.success);

      const locs = await api('/api/locations');
      const zoneNames = [...new Set(locs.body.data.map(l => l.zone_name))];
      assert('只能看到冷冻库位', zoneNames.length === 1 && zoneNames[0].includes('冷冻'),
        '实际温区: ' + zoneNames.join(','));

      const frozenZoneId = loginRes.body.data.zone_ids[0];
      const frozenLocId = locs.body.data[0].id;

      const samples = [];
      for (let i = 1; i <= 5; i++) {
        const r = await api('/api/samples', {
          method: 'POST',
          body: { barcode: 'BATCH-FROZ-' + i, batch_no: 'BF', name: '冷冻样本' + i, required_zone_id: frozenZoneId }
        });
        if (r.body && r.body.success) samples.push(r.body.data.id);
      }
      assert('创建5个冷冻样本', samples.length === 5);

      const batchIn = await api('/api/samples/batch/inbound', {
        method: 'POST',
        body: { items: samples.map(id => ({ sample_id: id, location_id: frozenLocId })), remark: '冷冻批量入库' }
      });
      assert('批量入库5个冷冻样本成功', batchIn.body && batchIn.body.success && batchIn.body.data.success === 5,
        '返回: ' + JSON.stringify(batchIn.body));

      const sampleList = await api('/api/samples');
      const barcodes = sampleList.body.data.map(s => s.barcode);
      assert('看不到冷藏样本', !barcodes.some(b => b.startsWith('BATCH-COLD-')),
        '条码: ' + barcodes.join(','));

      // 跨温区操作测试
      if (state.coldSampleIds && state.coldSampleIds.length > 0) {
        const crossOut = await api('/api/samples/' + state.coldSampleIds[0] + '/outbound', {
          method: 'POST', body: { remark: '跨区测试' }
        });
        assert('跨温区出库被拦截', !crossOut.body.success && crossOut.body.forbidden === true,
          '返回: ' + JSON.stringify(crossOut.body));
      }

      state.frozenZoneId = frozenZoneId;
      state.frozenLocId = frozenLocId;
      state.frozenSampleIds = samples;
      global.__testState = state;
    });

    await runCase('场景3: 只读用户写操作全拦截', async () => {
      const state = global.__testState || {};
      const loginRes = await api('/api/auth/login', {
        method: 'POST', body: { username: 'viewer', password: 'view123' }
      });
      assert('登录成功', loginRes.body && loginRes.body.success);

      const createRes = await api('/api/samples', {
        method: 'POST', body: { barcode: 'VIEWER-TEST', batch_no: 'BV', name: '只读测试' }
      });
      assert('创建样本被拦', !createRes.body.success && createRes.body.forbidden === true);

      const inboundRes = await api('/api/samples/' + (state.frozenSampleIds?.[0] || 1) + '/inbound', {
        method: 'POST', body: { location_id: state.frozenLocId || 1 }
      });
      assert('入库被拦', !inboundRes.body.success && inboundRes.body.forbidden === true);

      const transferRes = await api('/api/samples/' + (state.frozenSampleIds?.[0] || 1) + '/transfer', {
        method: 'POST', body: { to_location_id: state.frozenLocId || 1 }
      });
      assert('转移被拦', !transferRes.body.success && transferRes.body.forbidden === true);

      const outboundRes = await api('/api/samples/' + (state.frozenSampleIds?.[0] || 1) + '/outbound', {
        method: 'POST', body: { remark: '测试' }
      });
      assert('出库被拦', !outboundRes.body.success && outboundRes.body.forbidden === true);

      const scrapRes = await api('/api/samples/' + (state.frozenSampleIds?.[0] || 1) + '/scrap', {
        method: 'POST', body: { remark: '测试' }
      });
      assert('报废被拦', !scrapRes.body.success && scrapRes.body.forbidden === true);

      const batchRes = await api('/api/samples/batch/inbound', {
        method: 'POST', body: { items: [{ sample_id: 1, location_id: 1 }] }
      });
      assert('批量入库被拦', !batchRes.body.success && batchRes.body.forbidden === true);

      const listRes = await api('/api/samples');
      assert('读取样本列表正常', listRes.body && listRes.body.success);
    });

    await runCase('场景4: 批量操作异常整批回滚', async () => {
      const state = global.__testState || {};
      const loginRes = await api('/api/auth/login', {
        method: 'POST', body: { username: 'admin', password: 'admin123' }
      });
      assert('管理员登录成功', loginRes.body && loginRes.body.success);

      const coldZoneId = state.coldZoneId || 1;
      const coldLocId = state.coldLocId || 1;

      // 创建3个样本
      const rids = [];
      for (let i = 1; i <= 3; i++) {
        const r = await api('/api/samples', {
          method: 'POST',
          body: { barcode: 'ROLLBACK-' + i, batch_no: 'RB', name: '回滚测试' + i, required_zone_id: coldZoneId }
        });
        if (r.body && r.body.success) rids.push(r.body.data.id);
      }
      assert('创建3个回滚测试样本', rids.length === 3);

      // 先单独入库第1个
      const firstIn = await api('/api/samples/' + rids[0] + '/inbound', {
        method: 'POST', body: { location_id: coldLocId }
      });
      assert('第1个样本单独入库成功', firstIn.body && firstIn.body.success);

      const s1before = await api('/api/samples/' + rids[0]);
      assert('入库后状态=在库', s1before.body.data.status === 'in_storage');
      const s2before = await api('/api/samples/' + rids[1]);
      assert('第2个状态=待入库', s2before.body.data.status === 'pending');

      // 批量入库全部3个(含已入库的第1个) - 应该整批回滚
      const rollbackRes = await api('/api/samples/batch/inbound', {
        method: 'POST',
        body: { items: rids.map(id => ({ sample_id: id, location_id: coldLocId })), remark: '回滚测试' }
      });
      assert('批量入库失败(预期)', !rollbackRes.body.success, '返回: ' + JSON.stringify(rollbackRes.body));
      assert('返回 rollback=true', rollbackRes.body.rollback === true);

      // 验证回滚后数据没变
      const s1after = await api('/api/samples/' + rids[0]);
      assert('回滚后第1个仍为在库', s1after.body.data.status === 'in_storage');

      const s2after = await api('/api/samples/' + rids[1]);
      assert('回滚后第2个仍为待入库', s2after.body.data.status === 'pending');

      const s3after = await api('/api/samples/' + rids[2]);
      assert('回滚后第3个仍为待入库', s3after.body.data.status === 'pending');
    });

    await runCase('场景5: 批量转移和出库', async () => {
      const state = global.__testState || {};
      const loginRes = await api('/api/auth/login', {
        method: 'POST', body: { username: 'wh_cold', password: 'whcold123' }
      });
      assert('冷藏库管员登录', loginRes.body && loginRes.body.success);

      const locs = await api('/api/locations');
      const loc2 = locs.body.data.find(l => l.code === 'R-A2');
      if (loc2 && state.coldSampleIds && state.coldSampleIds.length >= 3) {
        const bt = await api('/api/samples/batch/transfer', {
          method: 'POST',
          body: {
            items: state.coldSampleIds.slice(0, 2).map(id => ({ sample_id: id, to_location_id: loc2.id })),
            remark: '批量转移'
          }
        });
        assert('批量转移2个成功', bt.body && bt.body.success && bt.body.data.success === 2,
          '返回: ' + JSON.stringify(bt.body));
      }

      if (state.coldSampleIds && state.coldSampleIds.length >= 1) {
        const bo = await api('/api/samples/batch/outbound', {
          method: 'POST',
          body: {
            items: [{ sample_id: state.coldSampleIds[2] }],
            remark: '批量出库'
          }
        });
        assert('批量出库1个成功', bo.body && bo.body.success && bo.body.data.success === 1,
          '返回: ' + JSON.stringify(bo.body));
      }
    });

    await runCase('场景6: 用户温区权限管理 API', async () => {
      const loginRes = await api('/api/auth/login', {
        method: 'POST', body: { username: 'admin', password: 'admin123' }
      });
      assert('管理员登录', loginRes.body && loginRes.body.success);

      const list = await api('/api/user-zone-access');
      assert('查询权限列表成功', list.body && list.body.success);
      assert('有权限记录', list.body.data && list.body.data.length > 0);

      // 非管理员测试
      await api('/api/auth/login', {
        method: 'POST', body: { username: 'wh_cold', password: 'whcold123' }
      });
      const forbidden = await api('/api/user-zone-access');
      assert('库管员无权访问权限管理', !forbidden.body.success && forbidden.body.forbidden === true);
    });

  } catch (e) {
    log('\n❌ 主流程异常: ' + e.message);
    failCount++;
    failures.push({ name: '主流程', reason: e.message });
  }

  log('\n========== 验收结论 ==========');
  log(`通过: ${passCount}, 失败: ${failCount}`);

  writeResult();

  // 停掉服务器
  try {
    await stopServer();
    log('   服务已停止');
  } catch (e) {
    log('   停止服务失败: ' + e.message);
  }

  // 退出码
  const exitCode = failCount > 0 ? 1 : 0;
  log(`   退出码: ${exitCode}`);
  process.exit(exitCode);
}

// 全局异常兜底
process.on('uncaughtException', e => {
  log('\n❌ 未捕获异常: ' + e.message);
  if (e.stack) log('   ' + e.stack.split('\n').slice(0, 5).join('\n   '));
  failCount++;
  failures.push({ name: '全局未捕获异常', reason: e.message });
  try { writeResult(); } catch {}
  try { stopServer(); } catch {}
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason, promise) => {
  log('\n❌ 未处理的 Promise 拒绝: ' + (reason?.message || reason));
  failCount++;
  failures.push({ name: 'Promise 未处理拒绝', reason: reason?.message || String(reason) });
  try { writeResult(); } catch {}
});

// 启动
main().catch(e => {
  log('\n❌ 主函数异常: ' + e.message);
  failCount++;
  failures.push({ name: '主函数', reason: e.message });
  try { writeResult(); } catch {}
  process.exit(1);
});
