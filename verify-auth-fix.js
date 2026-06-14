const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = 'localhost';
const PORT = 3004;
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
  });
}

function stopServer() {
  return new Promise(resolve => {
    if (SERVER_PROC) {
      SERVER_PROC.kill('SIGTERM');
      SERVER_PROC.on('exit', () => {
        SERVER_PROC = null;
        setTimeout(resolve, 300);
      });
    } else {
      resolve();
    }
  });
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`\n❌ 断言失败: ${msg}`);
    throw new Error(msg);
  }
  console.log(`   ✅ ${msg}`);
}

async function login(username, password) {
  const r = await api('/api/auth/login', {
    method: 'POST', body: { username, password }
  });
  if (!r.body || !r.body.success) throw new Error(`登录失败 ${username}: ${JSON.stringify(r.body)}`);
  return { cookie: r.setCookie, user: r.body.data };
}

async function main() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    return async () => {
      try {
        console.log(`\n🧪 ${name}`);
        await fn();
        passed++;
      } catch (e) {
        failed++;
        console.error(`   ❌ 测试失败: ${e.message}`);
      }
    };
  }

  try {
    console.log('========== 权限修复回归测试 ==========\n');

    clearDatabase();
    await startServer();
    await sleep(300);

    // ===== 准备测试数据 =====
    console.log('[准备] 创建测试数据');

    const adminSession = await login('admin', 'admin123');
    console.log(`   admin 登录成功，cookie=${adminSession.cookie ? '已获取' : '未获取'}`);
    assert(adminSession.cookie, '登录应返回 session cookie');

    const TS = Date.now().toString(36);
    const BATCH_NO = 'REG-TEST-' + TS;

    const locs = await api('/api/locations', { cookie: adminSession.cookie });
    const zone1Locs = (locs.body.data || []).filter(l => l.zone_id === 1);
    const zone2Locs = (locs.body.data || []).filter(l => l.zone_id === 2);
    const ZONE1_LOC_ID = zone1Locs[0].id;
    const ZONE2_LOC_ID = zone2Locs[0].id;

    // 创建 zone1 样本
    const s1 = await api('/api/samples', {
      method: 'POST', cookie: adminSession.cookie,
      body: {
        barcode: 'REG-TEST-' + TS + '-Z1',
        name: '回归测试样本-冷藏',
        batch_no: BATCH_NO,
        required_zone_id: 1
      }
    });
    const sample1Id = s1.body.data.id;
    await api(`/api/samples/${sample1Id}/inbound`, {
      method: 'POST', cookie: adminSession.cookie,
      body: { location_id: ZONE1_LOC_ID }
    });

    // 创建 zone2 样本
    const s2 = await api('/api/samples', {
      method: 'POST', cookie: adminSession.cookie,
      body: {
        barcode: 'REG-TEST-' + TS + '-Z2',
        name: '回归测试样本-冷冻',
        batch_no: BATCH_NO,
        required_zone_id: 2
      }
    });
    const sample2Id = s2.body.data.id;
    await api(`/api/samples/${sample2Id}/inbound`, {
      method: 'POST', cookie: adminSession.cookie,
      body: { location_id: ZONE2_LOC_ID }
    });

    console.log(`   测试样本创建完成: zone1=${sample1Id}, zone2=${sample2Id}`);

    // ===== 测试用例 =====

    const tests = [];

    function test(name, fn) {
      tests.push({ name, fn });
    }

    test('[1] 无 Cookie 补打请求被拦截', async () => {
      const r = await api(`/api/samples/${sample1Id}/reprint-label`, {
        method: 'POST',
        body: { reason: '无Cookie测试', copies: 1 }
      });
      assert(!r.body.success, '无 Cookie 补打应失败');
      assert(r.body.error.includes('请先登录') || r.body.needLogin === true, '应提示未登录');
    });

    test('[2] 无 Cookie 查询记录被拦截', async () => {
      const r = await api('/api/label-reprints');
      assert(!r.body.success, '无 Cookie 查询应失败');
      assert(r.body.error.includes('请先登录') || r.body.needLogin === true, '应提示未登录');
    });

    test('[3] 无 Cookie 导出被拦截', async () => {
      const r = await api('/api/label-reprints/export/csv');
      assert(!r.body || (typeof r.body === 'object' && !r.body.success), '无 Cookie 导出应失败');
    });

    test('[4] admin 有 Cookie 补打 zone1 成功', async () => {
      const r = await api(`/api/samples/${sample1Id}/reprint-label`, {
        method: 'POST', cookie: adminSession.cookie,
        body: { reason: '回归测试-admin', copies: 2 }
      });
      assert(r.body.success, 'admin 补打 zone1 应成功');
      const preview = r.body.data.label_preview;
      assert(preview.operator_name === '系统管理员', '操作人应为系统管理员');
      assert(preview.zone_name.includes('冷藏'), '温区应为冷藏');
    });

    test('[5] admin 有 Cookie 补打 zone2 成功', async () => {
      const r = await api(`/api/samples/${sample2Id}/reprint-label`, {
        method: 'POST', cookie: adminSession.cookie,
        body: { reason: '回归测试-admin-zone2', copies: 1 }
      });
      assert(r.body.success, 'admin 补打 zone2 应成功');
      const preview = r.body.data.label_preview;
      assert(preview.zone_name.includes('冷冻'), '温区应为冷冻');
    });

    test('[6] admin 查询记录能看到所有温区', async () => {
      const r = await api('/api/label-reprints?page_size=50', { cookie: adminSession.cookie });
      assert(r.body.success, '查询应成功');
      const list = r.body.data.list || [];
      assert(list.length >= 2, `应至少有2条记录，实际=${list.length}`);
      const hasZone1 = list.some(x => x.zone_id === 1);
      const hasZone2 = list.some(x => x.zone_id === 2);
      assert(hasZone1, '应包含 zone1 记录');
      assert(hasZone2, '应包含 zone2 记录');
    });

    let whColdSession = null;
    test('[7] 登录 wh_cold（只有 zone1 权限）', async () => {
      whColdSession = await login('wh_cold', 'whcold123');
      assert(whColdSession.cookie, 'wh_cold 登录应返回 cookie');
      assert(whColdSession.user.zone_ids.length === 1, 'wh_cold 应只有1个温区权限');
      assert(whColdSession.user.zone_ids[0] === 1, 'wh_cold 应有 zone1 权限');
    });

    test('[8] wh_cold 补打 zone1 成功', async () => {
      const r = await api(`/api/samples/${sample1Id}/reprint-label`, {
        method: 'POST', cookie: whColdSession.cookie,
        body: { reason: '回归测试-wh_cold', copies: 1 }
      });
      assert(r.body.success, 'wh_cold 补打 zone1 应成功');
      const preview = r.body.data.label_preview;
      assert(preview.operator_name === '冷藏库管员', '操作人应为冷藏库管员');
    });

    test('[9] wh_cold 补打 zone2 被拦截', async () => {
      const r = await api(`/api/samples/${sample2Id}/reprint-label`, {
        method: 'POST', cookie: whColdSession.cookie,
        body: { reason: '越权测试', copies: 1 }
      });
      assert(!r.body.success, 'wh_cold 补打 zone2 应失败');
      assert(r.body.error.includes('无权') || r.body.forbidden === true, '应提示无权操作');
    });

    test('[10] wh_cold 查询只能看到 zone1 记录', async () => {
      const r = await api('/api/label-reprints?page_size=50', { cookie: whColdSession.cookie });
      assert(r.body.success, '查询应成功');
      const list = r.body.data.list || [];
      assert(list.length > 0, '应有记录');
      const allZone1 = list.every(x => x.zone_id === 1 || x.zone_id === null);
      assert(allZone1, 'wh_cold 应只能看到 zone1 记录');
      const hasZone2 = list.some(x => x.zone_id === 2);
      assert(!hasZone2, 'wh_cold 不应看到 zone2 记录');
    });

    test('[11] admin 会话不受 wh_cold 登录影响', async () => {
      const r = await api('/api/label-reprints?page_size=50', { cookie: adminSession.cookie });
      assert(r.body.success, 'admin 查询应成功');
      const list = r.body.data.list || [];
      const hasZone1 = list.some(x => x.zone_id === 1);
      const hasZone2 = list.some(x => x.zone_id === 2);
      assert(hasZone1 && hasZone2, 'admin 应仍能看到所有温区记录，会话未被污染');
    });

    test('[12] wh_cold 导出只能导出 zone1 记录', async () => {
      const r = await api('/api/label-reprints/export/csv', { cookie: whColdSession.cookie });
      assert(r.raw && r.raw.length > 0, '导出应成功');
      assert(r.raw.includes('冷藏'), '导出应包含冷藏记录');
      assert(!r.raw.includes('冷冻'), '导出不应包含冷冻记录');
    });

    test('[13] admin 导出能导出所有温区记录', async () => {
      const r = await api('/api/label-reprints/export/csv', { cookie: adminSession.cookie });
      assert(r.raw && r.raw.length > 0, '导出应成功');
      assert(r.raw.includes('冷藏'), '导出应包含冷藏记录');
      assert(r.raw.includes('冷冻'), '导出应包含冷冻记录');
    });

    test('[14] 登出后 cookie 失效', async () => {
      await api('/api/auth/logout', {
        method: 'POST', cookie: whColdSession.cookie
      });
      const r = await api('/api/label-reprints', { cookie: whColdSession.cookie });
      assert(!r.body.success, '登出后查询应失败');
      assert(r.body.error.includes('请先登录') || r.body.needLogin === true, '应提示未登录');
    });

    test('[15] 直接绕接口：无 cookie 不能获取标签预览', async () => {
      const r = await api(`/api/samples/${sample1Id}/reprint-label`, {
        method: 'POST',
        body: { reason: '绕接口测试', copies: 1 }
      });
      assert(!r.body.success, '无 cookie 不能补打');
      assert(!r.body.data || !r.body.data.label_preview, '不应返回标签预览');
    });

    test('[16] 两个用户同时操作，会话互不干扰', async () => {
      // 重新登录 wh_cold
      const whSession = await login('wh_cold', 'whcold123');
      // 并发请求（Node.js 单线程，实际是串行，但可以测试会话识别）
      const r1 = await api('/api/label-reprints?page_size=50', { cookie: adminSession.cookie });
      const r2 = await api('/api/label-reprints?page_size=50', { cookie: whSession.cookie });

      assert(r1.body.success, 'admin 查询应成功');
      assert(r2.body.success, 'wh_cold 查询应成功');

      const list1 = r1.body.data.list || [];
      const list2 = r2.body.data.list || [];

      const adminHasZone2 = list1.some(x => x.zone_id === 2);
      const whHasZone2 = list2.some(x => x.zone_id === 2);

      assert(adminHasZone2, 'admin 应能看到 zone2');
      assert(!whHasZone2, 'wh_cold 不应看到 zone2');
    });

    // 执行所有测试
    for (const t of tests) {
      try {
        console.log(`\n🧪 ${t.name}`);
        await t.fn();
        passed++;
      } catch (e) {
        failed++;
        console.error(`   ❌ 测试失败: ${e.message}`);
      }
    }
    console.log('\n========== 回归测试总结 ==========');
    console.log(`✅ 通过: ${passed}`);
    console.log(`❌ 失败: ${failed}`);
    console.log(`📊 总计: ${passed + failed}`);

    if (failed > 0) {
      console.log('\n❌ 存在测试失败，请检查修复是否完整');
      await stopServer();
      process.exit(1);
    } else {
      console.log('\n🎉 所有回归测试通过！权限 bug 已修复');
    }

    await stopServer();
    process.exit(0);

  } catch (e) {
    console.error('\n测试执行出错:', e.message);
    console.error(e.stack);
    await stopServer();
    process.exit(1);
  }
}

main();
