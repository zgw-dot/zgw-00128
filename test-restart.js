const http = require('http');

const BASE_URL = 'http://localhost:3000';

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
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

async function login(username, password) {
  return request('/api/auth/login', {
    method: 'POST',
    body: { username, password }
  });
}

async function getSampleByBarcode(barcode) {
  return request(`/api/samples/barcode/${encodeURIComponent(barcode)}`);
}

async function searchHistory(params) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/history/search?${query}`);
}

async function getInventoryList() {
  return request('/api/inventory');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  return async function() {
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

async function runRestartTests() {
  console.log('========================================');
  console.log('  重启后持久化验证测试');
  console.log('========================================\n');

  console.log('正在连接服务器...\n');

  await test('1. 管理员登录', async () => {
    const res = await login('admin', 'admin123');
    assert(res.success, '登录失败');
    console.log('   登录成功:', res.data.username);
  })();

  await test('2. 按条码查询 INV-TEST003，验证状态和位置', async () => {
    const res = await getSampleByBarcode('INV-TEST003');
    assert(res.success, '查询失败');
    console.log('   条码:', res.data.barcode);
    console.log('   状态:', res.data.status_label);
    console.log('   位置:', res.data.location_code);
    assert(res.data.status === 'in_storage', '状态错误，应为在库');
    assert(res.data.location_code === 'R-A1', '位置错误，应为R-A1');
  })();

  await test('3. 验证时间线完整（包含盘点纠错记录）', async () => {
    const res = await getSampleByBarcode('INV-TEST003');
    console.log('   时间线记录数:', res.data.timeline.length);
    res.data.timeline.forEach(t => {
      console.log(`   - ${t.created_at}: ${t.action_label}${t.remark ? ' - ' + t.remark : ''}`);
    });
    assert(res.data.timeline.length >= 4, '时间线记录不足');
    const hasCorrection = res.data.timeline.some(t => t.action_type === 'inventory_correction');
    assert(hasCorrection, '缺少盘点纠错记录');
    const hasInbound = res.data.timeline.some(t => t.action_type === 'inbound');
    assert(hasInbound, '缺少入库记录');
    const hasTransfer = res.data.timeline.some(t => t.action_type === 'transfer');
    assert(hasTransfer, '缺少转移记录');
  })();

  await test('4. 验证补登的样本存在', async () => {
    const res = await getSampleByBarcode('INV-TEST-EXTRA01');
    assert(res.success, '补登的样本不存在');
    console.log('   补登样本存在:', res.data.barcode);
    console.log('   批次:', res.data.batch_no);
    assert(res.data.batch_no === 'BATCH-INV-002', '批次号错误');
  })();

  await test('5. 验证撤销转移的样本 INV-TEST001 状态为已出库', async () => {
    const res = await getSampleByBarcode('INV-TEST001');
    assert(res.success, '查询失败');
    console.log('   状态:', res.data.status_label);
    assert(res.data.status === 'outbound', '状态错误，应为已出库');
    console.log('   时间线记录数:', res.data.timeline.length);
    const hasReverse = res.data.timeline.some(t => t.action_type === 'reverse_transfer');
    assert(hasReverse, '缺少撤销转移记录');
    const hasOutbound = res.data.timeline.some(t => t.action_type === 'outbound');
    assert(hasOutbound, '缺少出库记录');
  })();

  await test('6. 验证撤销报废的样本状态为在库', async () => {
    const res = await getSampleByBarcode('INV-SCRAP-TEST');
    assert(res.success, '查询失败');
    console.log('   状态:', res.data.status_label);
    console.log('   位置:', res.data.location_code);
    assert(res.data.status === 'in_storage', '状态错误，应为在库');
    assert(res.data.location_code === 'R-A1', '位置错误，应为R-A1');
    const hasReverseScrap = res.data.timeline.some(t => t.action_type === 'reverse_scrapped');
    assert(hasReverseScrap, '缺少撤销报废记录');
  })();

  await test('7. 验证盘点单存在', async () => {
    const res = await getInventoryList();
    assert(res.success, '获取盘点单列表失败');
    console.log('   盘点单数量:', res.data.length);
    assert(res.data.length >= 1, '盘点单不存在');
    const order = res.data[0];
    console.log('   盘点单号:', order.order_no);
    console.log('   标题:', order.title);
    console.log('   状态:', order.status_label);
    console.log('   统计: 期望', order.total_expected, '扫描', order.total_scanned, '匹配', order.total_matched);
  })();

  await test('8. 历史查询 - 按条码查询完整历史', async () => {
    const res = await searchHistory({ barcode: 'INV-TEST003' });
    assert(res.success, '历史查询失败');
    assert(res.data.samples.length === 1, '应找到1个样本');
    const sample = res.data.samples[0];
    console.log('   时间线:', sample.timeline.length, '条');
    console.log('   差异记录:', sample.discrepancies.length, '条');
    assert(sample.timeline.length >= 4, '时间线记录不足');
    assert(sample.discrepancies.length >= 1, '差异记录不足');
  })();

  await test('9. 历史查询 - 按批次查询', async () => {
    const res = await searchHistory({ batch_no: 'BATCH-INV-001' });
    assert(res.success, '批次查询失败');
    console.log('   找到样本数:', res.data.samples.length);
    assert(res.data.samples.length >= 4, '样本数量不足');
  })();

  await test('10. 验证差异处理记录完整', async () => {
    const history = await searchHistory({ barcode: 'INV-TEST003' });
    const disp = history.data.samples[0].discrepancies[0];
    console.log('   差异类型:', disp.type_label);
    console.log('   处理状态:', disp.status_label);
    console.log('   处理人:', disp.handler);
    console.log('   处理时间:', disp.handled_at);
    assert(disp.status === 'resolved', '差异未处理');
    assert(disp.handler, '处理人缺失');
    assert(disp.handled_at, '处理时间缺失');
  })();

  console.log('\n========================================');
  console.log(`  重启验证完成: ${passed} 通过, ${failed} 失败`);
  console.log('========================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runRestartTests().catch(e => {
  console.error('测试执行出错:', e.message);
  console.log('请确保服务器已启动: npm start');
  process.exit(1);
});
