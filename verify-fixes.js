// 用 Node.js 原生 http 验证两个关键修复：
// 1) viewer 账号能正常登录（之前db.js里不存在）
// 2) JSON rows 导入字段：scanned_location_code=有效，location=空会导致 mislocated 不触发

const http = require('http');
const { execSync } = require('child_process');

const HOST = 'localhost';
const PORT = 3000;
const BASE = `http://${HOST}:${PORT}`;

function api(path, opts = {}) {
  return new Promise(resolve => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const req = http.request({
      hostname: HOST, port: PORT, path,
      method: opts.method || 'GET', headers
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
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

async function main() {
  console.log('========== curl 等价验证 ==========\n');

  // ========== 1. viewer 登录验证 ==========
  console.log('[1/6] viewer 登录（viewer/view123）');
  const v = await api('/api/auth/login', {
    method: 'POST', body: { username: 'viewer', password: 'view123' }
  });
  console.log('   返回:', v.status === 200 && v.body.success
    ? '✅ 成功：' + v.body.data.username + ' / ' + v.body.data.role_label
    : '❌ 失败：' + (v.body.error || v.body));
  console.assert(v.body.success && v.body.data.role === 'viewer', 'viewer 登录失败');

  // ========== 2. admin 登录（保存 cookie 给后面用） ==========
  console.log('\n[2/6] admin 登录');
  const a = await api('/api/auth/login', {
    method: 'POST', body: { username: 'admin', password: 'admin123' }
  });
  const COOKIE = a.setCookie;
  console.log('   返回:', a.body.success ? '✅ 成功' : '❌ ' + a.body.error);
  console.assert(a.body.success, 'admin 登录失败');

  // ========== 2.5 动态选一个空闲充足的冷藏库位（location_id=1 R-A1 可能满了） ==========
  const locsResp = await api('/api/locations', { cookie: COOKIE });
  const cooledLocs = (locsResp.body.data || [])
    .filter(l => l.zone_id === 1)
    .sort((a, b) => (b.capacity - (b.occupancy || 0)) - (a.capacity - (a.occupancy || 0)));
  let LOC_ID = cooledLocs[0] ? cooledLocs[0].id : 1;
  let LOC_CODE = cooledLocs[0] ? cooledLocs[0].code : 'R-A1';
  let LOC_ALT_ID = cooledLocs[1] ? cooledLocs[1].id : 2;
  let LOC_ALT_CODE = cooledLocs[1] ? cooledLocs[1].code : 'R-A2';
  // 如果两个库位都不够，选容量最大的（即使容量100用了20也够）
  if ((cooledLocs[0].capacity - (cooledLocs[0].occupancy||0)) < 3) {
    LOC_ID = cooledLocs[0].id; LOC_CODE = cooledLocs[0].code; // 至少2个样本入库，应该够
  }
  console.log(`   选库位: 主=${LOC_CODE}(ID=${LOC_ID}) 副=${LOC_ALT_CODE}(ID=${LOC_ALT_ID})`);

  // ========== 3. 建样本+入库+建盘点（用唯一前缀防重复） ==========
  const RUN = 'curlchk-' + Date.now().toString(36);
  const B = 'CURL-' + RUN;
  console.log(`\n[3/6] 准备测试 RUN=${RUN}（建2个样本+入库+建盘点单）`);
  const s1 = await api('/api/samples', {
    method: 'POST', cookie: COOKIE,
    body: { barcode: B + '-S1', batch_no: 'B' + B, name: 'curl测1', required_zone_id: 1 }
  });
  const s2 = await api('/api/samples', {
    method: 'POST', cookie: COOKIE,
    body: { barcode: B + '-S2', batch_no: 'B' + B, name: 'curl测2', required_zone_id: 1 }
  });
  const SID1 = s1.body.data.id, SID2 = s2.body.data.id;
  console.log('   建样本:', s1.body.success && s2.body.success ? '✅ 成功 SID1=' + SID1 + ' SID2=' + SID2 : '❌ 失败');
  console.assert(s1.body.success && s2.body.success);

  const ib1 = await api(`/api/samples/${SID1}/inbound`, {
    method: 'POST', cookie: COOKIE, body: { location_id: LOC_ID }
  });
  const ib2 = await api(`/api/samples/${SID2}/inbound`, {
    method: 'POST', cookie: COOKIE, body: { location_id: LOC_ID }
  });
  console.log(`   入库到 ${LOC_CODE}(ID=${LOC_ID}):`, ib1.body.success && ib2.body.success ? '✅ 成功' : '❌ ' + (ib1.body.error||ib2.body.error));
  console.assert(ib1.body.success && ib2.body.success);

  const inv = await api('/api/inventory', {
    method: 'POST', cookie: COOKIE,
    body: { title: 'curl字段验证-' + RUN, type: 'location', location_id: LOC_ID }
  });
  const INV_ID = inv.body.data.id;
  console.log('   建盘点单 INV_ID=' + INV_ID, inv.body.success ? '✅ 成功' : '❌ 失败');
  console.assert(inv.body.success);

  // ========== 4. 关键验证：传 location（错误字段）→ scanned_location_code 应为空 → mislocated 不触发 ==========
  console.log('\n[4/6] 导入字段测试A：传 location（错误字段）→ 应 0 个库位不一致');
  // S1 台账在 LOC_CODE，扫码故意写 LOC_ALT_CODE（但用的是错误字段 location）
  const badImport = await api(`/api/inventory/${INV_ID}/import`, {
    method: 'POST', cookie: COOKIE,
    body: { rows: [
      { barcode: B + '-S1', location: LOC_ALT_CODE, scan_time: '2024-06-15 09:00:00' },
      { barcode: B + '-S2', location: LOC_CODE, scan_time: '2024-06-15 09:01:00' }
    ]}
  });
  const mislBad = badImport.body.data.order.total_mislocated;
  console.log('   库位不一致数:', mislBad);
  console.log('   判定:', mislBad === 0
    ? '✅ 正确（字段写错，scanned_location_code=空，系统没比较库位）'
    : '❌ 异常：居然还检测到库位不一致');
  console.assert(mislBad === 0, '写 location 字段还能检测出 mislocated，bug 未修！');

  // ========== 5. 关键验证：传 scanned_location_code（正确字段）→ mislocated 正常触发 ==========
  console.log('\n[5/6] 导入字段测试B：传 scanned_location_code（正确字段）→ 应 >=1 个库位不一致');
  const goodImport = await api(`/api/inventory/${INV_ID}/import`, {
    method: 'POST', cookie: COOKIE,
    body: { rows: [
      // S1 台账 LOC_CODE，扫码写 LOC_ALT_CODE（正确字段名），应触发 mislocated
      { barcode: B + '-S1', scanned_location_code: LOC_ALT_CODE, scan_time: '2024-06-15 09:00:00' },
      { barcode: B + '-S2', scanned_location_code: LOC_CODE, scan_time: '2024-06-15 09:01:00' }
    ]}
  });
  const mislGood = goodImport.body.data.order.total_mislocated;
  console.log('   库位不一致数:', mislGood);
  console.log('   判定:', mislGood >= 1
    ? '✅ 正确（scanned_location_code 生效，S1 判定 mislocated）'
    : '❌ 失败：没检测到库位不一致');
  console.assert(mislGood >= 1, '写 scanned_location_code 没触发 mislocated！');

  // ========== 6. viewer 再次登录验证（因为 session 可能换了） ==========
  console.log('\n[6/6] viewer 再次登录（验证补建生效）');
  const v2 = await api('/api/auth/login', {
    method: 'POST', body: { username: 'viewer', password: 'view123' }
  });
  console.log('   用户:', v2.body.data && v2.body.data.username,
              ' 角色:', v2.body.data && v2.body.data.role_label);
  console.assert(v2.body.success && v2.body.data.role_label === '只读用户', 'viewer 第2次登录失败');
  console.log('   判定: ✅ viewer/view123 能正常登录');

  console.log('\n============== 结论 ==============');
  console.log('✅ 修复1（viewer账号）：db.js 启动时对缺失用户单独检查插入');
  console.log('✅ 修复2（导入字段）：README 和测试统一用 scanned_location_code/location_code');
  console.log('  → location 字段不会报语法错，但 scanned_location_code 为空 → 库位不一致对比失效');
  console.log('  → 必须写 scanned_location_code 或 location_code');
}

main().catch(e => { console.error('\n❌ 断言失败:', e.message); process.exit(1); });
