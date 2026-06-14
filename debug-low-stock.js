const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = 'localhost';
const PORT = 3001;
const BASE = `http://${HOST}:${PORT}`;
const DB_PATH = path.join(__dirname, 'data', 'debug-test.db');

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

function startServer() {
  return new Promise((resolve, reject) => {
    SERVER_PROC = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(PORT), DB_PATH: DB_PATH },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let started = false;
    let stderrOutput = '';
    SERVER_PROC.stderr.on('data', d => {
      stderrOutput += d.toString();
      console.log('SERVER STDERR:', d.toString().trim());
    });

    SERVER_PROC.stdout.on('data', async d => {
      const msg = d.toString();
      console.log('SERVER STDOUT:', msg.trim());
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
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

    console.log('启动服务器...');
    await startServer();
    await sleep(500);

    console.log('\n--- 登录 ---');
    const login = await api('/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin123' }
    });
    console.log('登录状态:', login.status);
    console.log('登录响应:', JSON.stringify(login.body, null, 2));
    const COOKIE = login.setCookie;

    console.log('\n--- 创建样本 ---');
    const TS = Date.now().toString(36);
    const BATCH_NO = 'DEBUG-' + TS;
    for (let i = 0; i < 3; i++) {
      const r = await api('/api/samples', {
        method: 'POST', cookie: COOKIE,
        body: {
          barcode: `${BATCH_NO}-S${i + 1}`,
          batch_no: BATCH_NO,
          name: `测试物品${i + 1}`,
          required_zone_id: 1
        }
      });
      console.log(`样本${i + 1}:`, r.body.success ? '成功' : '失败 - ' + r.body.error);
    }

    console.log('\n--- 获取库位 ---');
    const locs = await api('/api/locations', { cookie: COOKIE });
    const LOC_ID = locs.body.data[0].id;
    console.log('库位ID:', LOC_ID);

    console.log('\n--- 批量入库 ---');
    const samples = await api(`/api/samples?batch_no=${encodeURIComponent(BATCH_NO)}`, { cookie: COOKIE });
    const sampleIds = samples.body.data.map(s => s.id);
    const inboundItems = sampleIds.map(sid => ({ sample_id: sid, location_id: LOC_ID }));
    const ib = await api('/api/samples/batch/inbound', {
      method: 'POST', cookie: COOKIE,
      body: { items: inboundItems }
    });
    console.log('入库结果:', JSON.stringify(ib.body, null, 2));

    console.log('\n--- 查询默认阈值 ---');
    const threshold = await api('/api/inventory/config/threshold', { cookie: COOKIE });
    console.log('阈值响应:', JSON.stringify(threshold.body, null, 2));

    console.log('\n--- 低库存查询 ---');
    const lowStock = await api('/api/inventory/low-stock', { cookie: COOKIE });
    console.log('低库存状态:', lowStock.status);
    console.log('低库存响应:', JSON.stringify(lowStock.body, null, 2));
    console.log('原始响应:', lowStock.raw);

  } catch (e) {
    console.error('\n❌ 调试失败:', e.message);
    console.error(e.stack);
  } finally {
    await stopServer();
  }
}

main();
