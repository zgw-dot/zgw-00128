const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = 'localhost';
const PORT = 3003;
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
    console.log('========== 权限 Bug 复现测试 ==========\n');
    console.log('测试目标：验证全局 currentUser 导致的权限串用问题\n');

    clearDatabase();
    await startServer();
    await sleep(300);

    // ===== [1] 准备测试数据 =====
    console.log('[1] 准备测试数据');

    const adminSession = await login('admin', 'admin123');
    console.log(`   admin 登录成功`);

    // 创建测试样本（zone2 冷冻区）
    const TS = Date.now().toString(36);
    const BATCH_NO = 'AUTH-TEST-' + TS;

    const locs = await api('/api/locations', { cookie: adminSession.cookie });
    const zone2Locs = (locs.body.data || []).filter(l => l.zone_id === 2);
    const ZONE2_LOC_ID = zone2Locs[0].id;

    // 创建一个在 zone2 的样本
    const sampleResp = await api('/api/samples', {
      method: 'POST', cookie: adminSession.cookie,
      body: {
        barcode: 'AUTH-TEST-' + TS + '-Z2',
        name: '权限测试样本-冷冻区',
        batch_no: BATCH_NO,
        required_zone_id: 2
      }
    });
    const sampleId = sampleResp.body.data.id;
    console.log(`   测试样本创建成功，ID=${sampleId}，条码=AUTH-TEST-${TS}-Z2`);

    // 入库
    await api(`/api/samples/${sampleId}/inbound`, {
      method: 'POST', cookie: adminSession.cookie,
      body: { location_id: ZONE2_LOC_ID }
    });
    console.log(`   测试样本已入库到 zone2 冷冻区`);

    // ===== [2] 缺陷复现：无 Cookie 请求也能补打 =====
    console.log('\n[2] 缺陷复现：无 Cookie 请求也能补打');
    console.log('   说明：admin 已经登录过，全局 currentUser 已设置');
    console.log('   现在发起一个不带 Cookie 的补打请求...');

    const noCookieReprint = await api(`/api/samples/${sampleId}/reprint-label`, {
      method: 'POST',
      // 注意：这里故意不带 cookie！
      body: { reason: '无Cookie测试', copies: 1 }
    });

    if (noCookieReprint.body && noCookieReprint.body.success) {
      console.log('   ❌ BUG 复现成功：无 Cookie 请求居然补打成功了！');
      console.log(`      返回数据: ${JSON.stringify(noCookieReprint.body.data.label_preview)}`);
      console.log('      这证明权限校验完全失效，全局 currentUser 被滥用');
    } else {
      console.log('   ✅ 无 Cookie 请求被正确拦截（说明 bug 可能已修复）');
    }

    // ===== [3] 缺陷复现：会话污染 =====
    console.log('\n[3] 缺陷复现：会话污染 - 库管员登录后污染全局');
    console.log('   先登录 wh_cold（只有冷藏 zone1 权限）...');

    const whColdSession = await login('wh_cold', 'whcold123');
    console.log(`   wh_cold 登录成功，zone_ids=${JSON.stringify(whColdSession.user.zone_ids)}`);

    console.log('   现在用 admin 的 cookie 查询补打记录...');
    console.log('   预期：应该看到所有记录（admin 有权限）');
    console.log('   实际：因为全局 currentUser 被 wh_cold 覆盖，可能只能看到 zone1 的记录');

    const adminQueryAfterWhLogin = await api('/api/label-reprints?page_size=50', {
      cookie: adminSession.cookie
    });

    const records = adminQueryAfterWhLogin.body.data ? (adminQueryAfterWhLogin.body.data.list || []) : [];
    const hasZone2Record = records.some(r => r.zone_id === 2);

    console.log(`   查询到 ${records.length} 条记录`);
    console.log(`   包含 zone2 记录: ${hasZone2Record}`);

    if (!hasZone2Record && records.length > 0) {
      console.log('   ❌ BUG 复现成功：admin 查询却按 wh_cold 的权限过滤了！');
      console.log('      这证明会话被污染，全局 currentUser 串用了');
    } else if (hasZone2Record) {
      console.log('   ✅ admin 查询结果正确（说明 bug 可能已修复）');
    }

    // ===== [4] 缺陷复现：库管员绕接口操作无权限温区 =====
    console.log('\n[4] 缺陷复现：库管员绕接口操作无权限温区样本');
    console.log('   wh_cold 只有 zone1 权限，但可以直接调用接口操作 zone2 样本');
    console.log('   预期：应该被权限拦截');
    console.log('   实际：如果只检查全局 currentUser 的 zone_ids，可能能绕过');

    const whColdHackZone2 = await api(`/api/samples/${sampleId}/reprint-label`, {
      method: 'POST',
      cookie: whColdSession.cookie,
      body: { reason: '越权测试', copies: 1 }
    });

    if (whColdHackZone2.body && whColdHackZone2.body.success) {
      console.log('   ❌ BUG 复现成功：wh_cold 居然能给 zone2 样本补打！');
      console.log(`      标签预览: ${JSON.stringify(whColdHackZone2.body.data.label_preview)}`);
      console.log('      这证明温区权限隔离失效');
    } else {
      console.log('   ✅ wh_cold 操作 zone2 样本被正确拦截');
    }

    // ===== [5] 总结 =====
    console.log('\n========== 复现测试总结 ==========');
    console.log('如果上面出现了 ❌ BUG 复现成功 的标记，说明权限漏洞真实存在');
    console.log('需要从根上修复：');
    console.log('  1. 每个请求必须通过 Cookie 独立识别用户，不能依赖全局变量');
    console.log('  2. 权限校验必须基于当前请求的用户，而不是全局 currentUser');
    console.log('  3. 温区权限必须在 SQL 层面过滤，不能在应用层检查后又绕过去');
    console.log('');

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
