const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000';
const STATE_FILE = path.join(__dirname, 'test-state.json');

// 从 test.js 生成的状态文件读取
if (!fs.existsSync(STATE_FILE)) {
  console.error('❌ 错误: 找不到 test-state.json');
  console.error('   请先运行: node test.js');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
const { runId, barcodes, batches, sampleIds, inventoryOrderId, inventoryOrderNo, locations } = state;
const LOC_MAIN_CODE = locations ? locations.main.code : 'R-A1';
const LOC_MAIN_ID   = locations ? locations.main.id   : 1;
const LOC_ALT_CODE  = locations ? locations.alt.code  : 'R-A2';
const LOC_ALT_ID    = locations ? locations.alt.id    : 2;

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  return async function () {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (e) {
      console.log(`❌ FAIL: ${name}`);
      console.log(`   Error: ${e.message}`);
      failed++;
    }
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

async function login(u, p) { return request('/api/auth/login', { method: 'POST', body: { username: u, password: p } }); }
async function getSampleByBarcode(bc) { return request(`/api/samples/barcode/${encodeURIComponent(bc)}`); }
async function getSampleById(id) { return request(`/api/samples/${id}`); }
async function searchHistory(params) {
  const q = new URLSearchParams(params).toString();
  return request(`/api/history/search?${q}`);
}
async function getInventory(id) { return request(`/api/inventory/${id}`); }
async function getDiscrepancies(params) {
  const q = new URLSearchParams(params).toString();
  return request(`/api/discrepancies?${q}`);
}

async function runTests() {
  console.log('========================================');
  console.log('  重启后持久化验证测试');
  console.log(`  读取状态文件 RUN_ID: ${runId}`);
  console.log('========================================\n');

  // 1. 管理员登录
  await test('1. 管理员登录', async () => {
    const res = await login('admin', 'admin123');
    assert(res.success, `登录失败: ${res.error}`);
    assert(res.data.role === 'admin');
    console.log('   登录成功:', res.data.username);
  })();

  // 2. 按条码查 S3：状态、位置正确（S3 被纠正到扫码库位 LOC_ALT）
  await test(`2. 按条码查 S3：状态为在库，位置为 ${LOC_ALT_CODE}`, async () => {
    const res = await getSampleByBarcode(barcodes.S3);
    assert(res.success, `查询失败: ${res.error}`);
    console.log('   条码:', barcodes.S3);
    console.log('   状态:', res.data.status_label, ' 位置:', res.data.location_code);
    assert(res.data.status === 'in_storage', `状态应为 in_storage，实际 ${res.data.status}`);
    assert(res.data.location_code === LOC_ALT_CODE,
      `位置应为 ${LOC_ALT_CODE}（扫码实际库位），实际 ${res.data.location_code}`);
  })();

  // 3. S3 时间线完整：登记→入库→盘点纠错（>=3条）
  await test('3. S3 时间线完整（含盘点纠错记录）', async () => {
    const res = await getSampleByBarcode(barcodes.S3);
    const tl = res.data.timeline;
    console.log('   时间线记录数:', tl.length);
    tl.forEach(t => console.log(`   - ${t.created_at}: ${t.action_type_label} - ${t.detail}`));
    assert(tl.length >= 3, `时间线记录应>=3（登记/入库/盘点纠错），实际 ${tl.length}`);
    const hasRegister = tl.some(t => t.action_type === 'register');
    const hasInbound = tl.some(t => t.action_type === 'inbound');
    const hasCorrection = tl.some(t => t.action_type === 'inventory_correction');
    assert(hasRegister, '缺少登记记录');
    assert(hasInbound, '缺少入库记录');
    assert(hasCorrection, '缺少盘点纠错记录 ← 核心验证点');
  })();

  // 4. 补登的 EXTRA 样本存在
  await test('4. 补登的 EXTRA 样本存在', async () => {
    const res = await getSampleByBarcode(barcodes.EXTRA);
    assert(res.success, `条码 ${barcodes.EXTRA} 查询失败: ${res.error}`);
    assert(res.data.id, '补登样本的 ID 为空');
    console.log('   补登条码:', barcodes.EXTRA);
    console.log('   批次:', res.data.batch_no, ' ID:', res.data.id);
    assert(res.data.batch_no === batches.extra, `补登批次应为 ${batches.extra}，实际 ${res.data.batch_no}`);
  })();

  // 5. S1：撤销转移后再出库 → 状态为已出库
  await test('5. S1 状态为已出库（验证撤销后再出库持久化）', async () => {
    const s1 = await getSampleById(sampleIds.S1);
    assert(s1.success, '查询 S1 失败');
    console.log('   状态:', s1.data.status_label, ' ID:', sampleIds.S1);
    assert(s1.data.status === 'outbound', `状态应为 outbound，实际 ${s1.data.status}`);
    const tl = s1.data.timeline;
    // 时间线中同时存在 transfer 和 reverse_transfer
    const hasT = tl.some(t => t.action_type === 'transfer');
    const hasRT = tl.some(t => t.action_type === 'reverse_transfer');
    const hasOut = tl.some(t => t.action_type === 'outbound');
    console.log('   时间线: transfer?', hasT, 'reverse?', hasRT, 'outbound?', hasOut);
    assert(hasT, '原转移记录被删了（不允许删除！只能追加）');
    assert(hasRT, '撤销转移记录丢失');
    assert(hasOut, '出库记录丢失');
  })();

  // 6. SCRAP：撤销报废后恢复为在库
  await test(`6. 撤销报废的 SCRAP 样本恢复为在库 ${LOC_MAIN_CODE}`, async () => {
    const res = await getSampleById(sampleIds.SCRAP);
    assert(res.success, '查询 SCRAP 失败');
    console.log('   状态:', res.data.status_label, ' 位置:', res.data.location_code);
    assert(res.data.status === 'in_storage', `状态应为 in_storage，实际 ${res.data.status}`);
    assert(res.data.current_location_id === LOC_MAIN_ID,
      `位置 ID 应为 ${LOC_MAIN_ID}（${LOC_MAIN_CODE}），实际 ${res.data.current_location_id}`);
    const tl = res.data.timeline;
    const hasScrap = tl.some(t => t.action_type === 'scrapped');
    const hasRevScrap = tl.some(t => t.action_type === 'reverse_scrapped');
    console.log('   时间线: scrapped?', hasScrap, ' reverse_scrapped?', hasRevScrap);
    assert(hasScrap, '原报废记录丢失');
    assert(hasRevScrap, '撤销报废记录丢失');
  })();

  // 7. 盘点单存在
  await test('7. 盘点单存在，状态与统计正确', async () => {
    const res = await getInventory(inventoryOrderId);
    assert(res.success, `查询盘点单 ${inventoryOrderId} 失败: ${res.error}`);
    const o = res.data.order;
    console.log('   盘点单号:', o.order_no);
    console.log('   标题:', o.title, ' 状态:', o.status_label);
    console.log('   统计: 期望', o.total_expected, ' 扫描', o.total_scanned, ' 匹配/差异:', o.total_matched, '/', o.total_mislocated + o.total_missing + o.total_extra + o.total_outbound_scanned);
    assert(o.order_no === inventoryOrderNo, `盘点单号不一致: 期望 ${inventoryOrderNo} 实际 ${o.order_no}`);
    assert(o.total_expected >= 4, `期望数应>=4（至少S1~S4），实际 ${o.total_expected}`);
    assert(o.total_scanned === 5, `扫描数应为5（固定5行CSV），实际 ${o.total_scanned}`);
  })();

  // 8. 历史查询 - 按条码 S3
  await test('8. 历史查询 - 按条码 S3（时间线+差异）', async () => {
    const res = await searchHistory({ barcode: barcodes.S3 });
    assert(res.success, `历史查询失败: ${res.error}`);
    const s = res.data.samples[0];
    console.log('   时间线:', s.timeline.length, '条  差异:', s.discrepancies.length, '条');
    assert(s.timeline.length >= 3, `时间线不足3条（登记/入库/盘点纠错）`);
    assert(s.discrepancies.length >= 1, `差异记录不足1条`);
  })();

  // 9. 历史查询 - 按批次
  await test('9. 历史查询 - 按批次 BATCH_MAIN（找到5个样本）', async () => {
    const res = await searchHistory({ batch_no: batches.main });
    assert(res.success);
    const n = res.data.samples.length;
    console.log('   找到样本数:', n);
    assert(n === 5, `应找到5个样本（S1~S5），实际 ${n}`);
  })();

  // 10. 差异处理记录完整
  await test('10. S3 的差异记录完整（类型/处理人/处理时间）', async () => {
    const dispRes = await getDiscrepancies({ barcode: barcodes.S3 });
    assert(dispRes.success, `差异查询失败: ${dispRes.error}`);
    assert(dispRes.data.length >= 1, '差异记录为空');
    const d = dispRes.data.find(x => x.type === 'mislocated');
    assert(d, '未找到 mislocated 差异');
    console.log('   差异类型:', d.type_label);
    console.log('   处理状态:', d.status_label);
    console.log('   处理人:', d.handler, ' 处理时间:', d.handled_at);
    assert(d.status === 'resolved', `状态应为 resolved，实际 ${d.status}`);
    assert(d.handler, '处理人为空');
    assert(d.handled_at, '处理时间为空');
    assert(d.handler_remark && d.handler_remark.length > 0, '处理备注为空');
  })();

  console.log('\n========================================');
  console.log(`  重启验证完成: ${passed} 通过, ${failed} 失败`);
  console.log('========================================\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(e => {
  console.error('测试执行出错:', e);
  process.exit(1);
});
