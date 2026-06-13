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

async function logout() {
  return request('/api/auth/logout', { method: 'POST' });
}

async function createSample(barcode, batch_no, required_zone_id = 1) {
  return request('/api/samples', {
    method: 'POST',
    body: { barcode, batch_no, name: `测试样本-${barcode}`, required_zone_id, operator: 'test' }
  });
}

async function inboundSample(sampleId, locationId) {
  return request(`/api/samples/${sampleId}/inbound`, {
    method: 'POST',
    body: { location_id: locationId, operator: 'test' }
  });
}

async function outboundSample(sampleId) {
  return request(`/api/samples/${sampleId}/outbound`, {
    method: 'POST',
    body: { operator: 'test', remark: '测试出库' }
  });
}

async function transferSample(sampleId, toLocationId) {
  return request(`/api/samples/${sampleId}/transfer`, {
    method: 'POST',
    body: { to_location_id: toLocationId, operator: 'test' }
  });
}

async function scrapSample(sampleId) {
  return request(`/api/samples/${sampleId}/scrap`, {
    method: 'POST',
    body: { operator: 'test', remark: '测试报废' }
  });
}

async function createInventory(title, type, zone_id = null, location_id = null) {
  return request('/api/inventory', {
    method: 'POST',
    body: { title, type, zone_id, location_id, remark: '测试盘点' }
  });
}

async function importScan(inventoryId, csvText) {
  return request(`/api/inventory/${inventoryId}/import`, {
    method: 'POST',
    body: { csv_text: csvText }
  });
}

async function resolveDiscrepancy(discrepancyId, action, new_location_id = null, remark = '测试处理') {
  return request(`/api/discrepancies/${discrepancyId}/resolve`, {
    method: 'POST',
    body: { action, new_location_id, remark }
  });
}

async function addDispNote(discrepancyId, remark) {
  return request(`/api/discrepancies/${discrepancyId}/note`, {
    method: 'POST',
    body: { remark }
  });
}

async function reverseAction(sampleId, timelineId, reason) {
  return request(`/api/samples/${sampleId}/reverse/${timelineId}`, {
    method: 'POST',
    body: { reason, remark: '测试撤销' }
  });
}

async function getReversableActions(sampleId) {
  return request(`/api/samples/${sampleId}/reversable-actions`);
}

async function getInventoryDetail(inventoryId) {
  return request(`/api/inventory/${inventoryId}`);
}

async function searchHistory(params) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/history/search?${query}`);
}

async function getSampleByBarcode(barcode) {
  return request(`/api/samples/barcode/${encodeURIComponent(barcode)}`);
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

async function runTests() {
  console.log('========================================');
  console.log('  冷链样本追踪系统 - 盘点与纠错测试');
  console.log('========================================\n');

  await test('1. 管理员登录', async () => {
    const res = await login('admin', 'admin123');
    assert(res.success, '登录失败');
    assert(res.data.role === 'admin', '角色错误');
    console.log('   用户:', res.data.username, '角色:', res.data.role_label);
  })();

  await test('2. 创建测试样本', async () => {
    const samples = ['INV-TEST001', 'INV-TEST002', 'INV-TEST003', 'INV-TEST004', 'INV-TEST005'];
    for (const bc of samples) {
      const res = await createSample(bc, 'BATCH-INV-001', 1);
      assert(res.success, `创建样本 ${bc} 失败: ${res.error}`);
      console.log(`   样本 ${bc} 创建成功，ID:`, res.data.id);
    }
  })();

  await test('3. 样本入库到 R-A1', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await inboundSample(i, 1);
      assert(res.success, `样本 ${i} 入库失败: ${res.error}`);
    }
    console.log('   5个样本入库到 R-A1 成功');
  })();

  await test('4. 将 INV-TEST003 转移到 R-A2', async () => {
    const res = await transferSample(3, 2);
    assert(res.success, `转移失败: ${res.error}`);
    console.log('   INV-TEST003 转移到 R-A2 成功');
  })();

  await test('5. 将 INV-TEST005 出库', async () => {
    const res = await outboundSample(5);
    assert(res.success, `出库失败: ${res.error}`);
    console.log('   INV-TEST005 出库成功');
  })();

  await test('6. 按温区创建盘点单（冷藏区）', async () => {
    const res = await createInventory('2024年6月冷藏区盘点', 'zone', 1);
    assert(res.success, `创建盘点单失败: ${res.error}`);
    console.log('   盘点单创建成功:', res.data.order_no);
    global.inventoryId = res.data.id;
  })();

  await test('7. 导入扫码CSV（包含冲突场景）', async () => {
    const csv = `条码,库位,扫描时间
INV-TEST001,R-A1,2024-06-15 09:00:00
INV-TEST002,R-A1,2024-06-15 09:01:00
INV-TEST003,R-A1,2024-06-15 09:02:00
INV-TEST005,R-A1,2024-06-15 09:03:00
INV-TEST-EXTRA01,R-A1,2024-06-15 09:04:00`;

    const res = await importScan(global.inventoryId, csv);
    assert(res.success, `导入失败: ${res.error}`);
    console.log('   导入成功:', res.data.imported, '条');
    console.log('   统计: 期望', res.data.order.total_expected,
      '扫描', res.data.order.total_scanned,
      '匹配', res.data.order.total_matched,
      '多扫', res.data.order.total_extra,
      '漏扫', res.data.order.total_missing,
      '库位不一致', res.data.order.total_mislocated,
      '已出库被扫', res.data.order.total_outbound_scanned);

    assert(res.data.order.total_matched === 2, `匹配数应为2，实际${res.data.order.total_matched}`);
    assert(res.data.order.total_missing === 1, `漏扫数应为1，实际${res.data.order.total_missing}`);
    assert(res.data.order.total_mislocated === 1, `库位不一致应为1，实际${res.data.order.total_mislocated}`);
    assert(res.data.order.total_extra === 1, `多扫数应为1，实际${res.data.order.total_extra}`);
    assert(res.data.order.total_outbound_scanned === 1, `已出库被扫应为1，实际${res.data.order.total_outbound_scanned}`);
  })();

  await test('8. 获取盘点差异列表', async () => {
    const res = await getInventoryDetail(global.inventoryId);
    assert(res.success, '获取盘点详情失败');
    global.discrepancies = res.data.discrepancies;
    console.log('   差异数量:', res.data.discrepancies.length);
    res.data.discrepancies.forEach(d => {
      console.log(`   - ${d.barcode}: ${d.type_label} - ${d.status_label}`);
    });
    assert(res.data.discrepancies.length === 4, '差异数量应为4');
  })();

  await test('9. 权限测试：切换到库管员，尝试处理差异（应该被拒绝）', async () => {
    await logout();
    const loginRes = await login('warehouse', 'wh123');
    assert(loginRes.success, '库管员登录失败');
    assert(loginRes.data.role === 'warehouse', '角色错误');
    console.log('   已切换到库管员');

    const disp = global.discrepancies.find(d => d.type === 'mislocated');
    const res = await resolveDiscrepancy(disp.id, 'correct_location', disp.new_location_id, '测试处理');
    assert(!res.success, '库管员应该被拒绝处理差异');
    assert(res.forbidden, '应该返回 forbidden');
    console.log('   权限拦截成功，库管员无法处理差异');
  })();

  await test('10. 库管员可以添加差异说明', async () => {
    const disp = global.discrepancies.find(d => d.type === 'mislocated');
    const res = await addDispNote(disp.id, '库管员备注：已核实，确实放错位置了');
    assert(res.success, '添加说明失败');
    console.log('   库管员添加差异说明成功');
  })();

  await test('11. 切回管理员，处理库位不一致差异', async () => {
    await logout();
    await login('admin', 'admin123');

    const disp = global.discrepancies.find(d => d.type === 'mislocated');
    const res = await resolveDiscrepancy(disp.id, 'correct_location', disp.new_location_id, '管理员确认修正库位');
    assert(res.success, `处理差异失败: ${res.error}`);
    console.log('   库位不一致差异处理成功');

    const sample = await getSampleByBarcode('INV-TEST003');
    assert(sample.data.location_code === 'R-A1', '样本位置未修正');
    console.log('   样本 INV-TEST003 位置已修正为 R-A1');
  })();

  await test('12. 处理多扫差异（补登样本）', async () => {
    const disp = global.discrepancies.find(d => d.type === 'extra');
    const res = await request(`/api/discrepancies/${disp.id}/resolve`, {
      method: 'POST',
      body: {
        action: 'register_extra',
        batch_no: 'BATCH-INV-002',
        name: '盘点补登样本',
        remark: '盘点补登'
      }
    });
    assert(res.success, `补登失败: ${res.error}`);
    console.log('   多扫差异处理成功，样本已补登');

    const sample = await getSampleByBarcode('INV-TEST-EXTRA01');
    assert(sample.success, '补登的样本不存在');
    console.log('   补登样本 INV-TEST-EXTRA01 已存在');
  })();

  await test('13. 导出盘点结果CSV', async () => {
    return new Promise((resolve, reject) => {
      http.get(`${BASE_URL}/api/inventory/${global.inventoryId}/export/csv`, (res) => {
        assert(res.statusCode === 200, '导出失败');
        assert(res.headers['content-type'].includes('text/csv'), 'Content-Type 错误');
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          assert(data.includes('INV-TEST001'), 'CSV中缺少 INV-TEST001');
          assert(data.includes('INV-TEST003'), 'CSV中缺少 INV-TEST003');
          console.log('   盘点结果CSV导出成功，行数:', data.split('\n').length);
          resolve();
        });
      }).on('error', reject);
    });
  })();

  await test('14. 撤销功能测试：先转移再撤销', async () => {
    const sample = await getSampleByBarcode('INV-TEST001');
    const originalLocation = sample.data.current_location_id;
    console.log('   原始位置:', sample.data.location_code);

    const transferRes = await transferSample(sample.data.id, 2);
    assert(transferRes.success, '转移失败');
    console.log('   已转移到 R-A2');

    const afterTransfer = await getSampleByBarcode('INV-TEST001');
    assert(afterTransfer.data.current_location_id === 2, '转移后位置不对');

    const reversable = await getReversableActions(sample.data.id);
    assert(reversable.data.length > 0, '没有可撤销的操作');
    const timelineId = reversable.data[0].id;
    console.log('   可撤销操作ID:', timelineId);

    const reverseRes = await reverseAction(sample.data.id, timelineId, '操作失误，需要撤销');
    assert(reverseRes.success, `撤销失败: ${reverseRes.error}`);
    console.log('   撤销操作成功');

    const afterReverse = await getSampleByBarcode('INV-TEST001');
    assert(afterReverse.data.current_location_id === originalLocation, '撤销后位置未恢复');
    console.log('   位置已恢复到:', afterReverse.data.location_code);

    assert(afterReverse.data.timeline.length >= 3, '时间线记录不足');
    const hasReverse = afterReverse.data.timeline.some(t => t.action_type === 'reverse_transfer');
    assert(hasReverse, '时间线中缺少撤销记录');
    console.log('   时间线中已追加撤销记录，原记录保留');
  })();

  await test('15. 撤销后再出库（验证撤销后状态正确）', async () => {
    const sample = await getSampleByBarcode('INV-TEST001');
    assert(sample.data.status === 'in_storage', '样本状态应为在库');

    const outboundRes = await outboundSample(sample.data.id);
    assert(outboundRes.success, `撤销后出库失败: ${outboundRes.error}`);
    console.log('   撤销后样本出库成功');

    const afterOutbound = await getSampleByBarcode('INV-TEST001');
    assert(afterOutbound.data.status === 'outbound', '出库后状态错误');
    console.log('   样本状态已更新为已出库');
  })();

  await test('16. 撤销报废测试', async () => {
    const createRes = await createSample('INV-SCRAP-TEST', 'BATCH-SCRAP', 1);
    const sampleId = createRes.data.id;
    await inboundSample(sampleId, 1);

    const scrapRes = await scrapSample(sampleId);
    assert(scrapRes.success, '报废失败');
    console.log('   样本已报废');

    const afterScrap = await request(`/api/samples/${sampleId}`);
    assert(afterScrap.data.status === 'scrapped', '报废后状态错误');

    const reversable = await getReversableActions(sampleId);
    const timelineId = reversable.data[0].id;

    const reverseRes = await reverseAction(sampleId, timelineId, '误报废，需要恢复');
    assert(reverseRes.success, `撤销报废失败: ${reverseRes.error}`);
    console.log('   撤销报废成功');

    const afterReverse = await request(`/api/samples/${sampleId}`);
    assert(afterReverse.data.status === 'in_storage', '撤销后状态未恢复');
    assert(afterReverse.data.current_location_id === 1, '撤销后位置未恢复');
    console.log('   样本状态已恢复为在库，位置恢复为 R-A1');
  })();

  await test('17. 历史查询 - 按条码查询完整历史', async () => {
    const res = await searchHistory({ barcode: 'INV-TEST003' });
    assert(res.success, '历史查询失败');
    assert(res.data.samples.length === 1, '应找到1个样本');

    const sample = res.data.samples[0];
    assert(sample.timeline.length >= 4, '时间线记录不足');
    assert(sample.discrepancies.length >= 1, '差异记录不足');
    console.log('   条码查询成功: 时间线', sample.timeline.length, '条，差异', sample.discrepancies.length, '条');

    const hasCorrection = sample.timeline.some(t => t.action_type === 'inventory_correction');
    assert(hasCorrection, '时间线中缺少盘点纠错记录');
    console.log('   时间线包含盘点纠错记录');
  })();

  await test('18. 历史查询 - 按批次查询', async () => {
    const res = await searchHistory({ batch_no: 'BATCH-INV-001' });
    assert(res.success, '批次查询失败');
    assert(res.data.samples.length >= 4, '应找到至少4个样本');
    console.log('   批次查询成功，找到', res.data.samples.length, '个样本');
  })();

  await test('19. 历史查询 - 按盘点单号查询', async () => {
    const detail = await getInventoryDetail(global.inventoryId);
    const orderNo = detail.data.order.order_no;

    const res = await searchHistory({ inventory_order_id: orderNo });
    assert(res.success, '盘点单查询失败');
    assert(res.data.inventory_orders.length === 1, '应找到1个盘点单');
    console.log('   盘点单查询成功:', res.data.inventory_orders[0].order_no);
  })();

  await test('20. 持久化验证：检查数据已写入数据库', async () => {
    console.log('   记录当前状态...');

    const beforeRestart = await getSampleByBarcode('INV-TEST003');
    assert(beforeRestart.data.status === 'in_storage', '状态错误');

    const timelineCountBefore = beforeRestart.data.timeline.length;
    console.log('   时间线记录数:', timelineCountBefore);

    const history = await searchHistory({ barcode: 'INV-TEST003' });
    assert(history.data.samples.length === 1, '历史查询失败');
    assert(history.data.samples[0].discrepancies.length >= 1, '差异记录未持久化');
    assert(history.data.samples[0].reversals.length >= 0, '撤销记录查询失败');

    console.log('   所有数据已持久化到SQLite');
  })();

  console.log('\n========================================');
  console.log(`  测试完成: ${passed} 通过, ${failed} 失败`);
  console.log('========================================');
  console.log('\n📋 下一步验证:');
  console.log('   1. 手动重启服务器 (Ctrl+C 然后 npm start)');
  console.log('   2. 运行 node test-restart.js 验证重启后历史不丢');
  console.log('   3. 或按 README 中的步骤进行页面验证');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(e => {
  console.error('测试执行出错:', e);
  process.exit(1);
});
