const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000';
const STATE_FILE = path.join(__dirname, 'test-state.json');

// ===== 唯一标识符：每次运行生成，避免重复条码/批次冲突
const RUN_ID = Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36).padStart(3, '0');

// 本次测试使用的条码/批次（全部带上 RUN_ID 后缀）
const BATCH_MAIN = `BATCH-${RUN_ID}`;
const BATCH_EXTRA = `BATCH-EXTRA-${RUN_ID}`;
const BATCH_SCRAP = `BATCH-SCRAP-${RUN_ID}`;

const BARCODES = {
  S1: `INV-${RUN_ID}-S1`,
  S2: `INV-${RUN_ID}-S2`,
  S3: `INV-${RUN_ID}-S3`,
  S4: `INV-${RUN_ID}-S4`,
  S5: `INV-${RUN_ID}-S5`,
  EXTRA: `INV-${RUN_ID}-EXTRA`,
  SCRAP: `INV-${RUN_ID}-SCRAP`
};

// 运行时保存的 ID 映射（样本ID/盘点单ID/差异ID等）
let state = {
  runId: RUN_ID,
  createdAt: new Date().toISOString(),
  barcodes: BARCODES,
  batches: { main: BATCH_MAIN, extra: BATCH_EXTRA, scrap: BATCH_SCRAP },
  sampleIds: {},
  inventoryOrderId: null,
  inventoryOrderNo: null,
  discrepancyIds: {},
  transferTimelineId: null,
  scrapTimelineId: null
};

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

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
  return request('/api/auth/logout', { method: 'POST', body: {} });
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

async function resolveDiscrepancy(discrepancyId, action, extra = {}) {
  return request(`/api/discrepancies/${discrepancyId}/resolve`, {
    method: 'POST',
    body: { action, remark: '测试处理', ...extra }
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

async function getSampleById(sampleId) {
  return request(`/api/samples/${sampleId}`);
}

async function getLocations() {
  return request('/api/locations');
}

async function createLocation(code, name, zone_id, capacity) {
  return request('/api/locations', {
    method: 'POST',
    body: { code, name, zone_id, capacity }
  });
}

// 选一个指定温区、有>=minFree空闲容量的库位
async function pickZoneLocation(zoneId, minFree = 10) {
  const res = await getLocations();
  if (!res.success) throw new Error('获取库位失败');
  const candidates = res.data.filter(l =>
    l.zone_id === zoneId && (l.capacity - (l.used_count || 0)) >= minFree
  );
  if (candidates.length === 0) {
    // 找不到就返回该温区任意一个
    return res.data.find(l => l.zone_id === zoneId);
  }
  return candidates[0];
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

async function runTests() {
  console.log('========================================');
  console.log('  冷链样本追踪系统 - 盘点与纠错测试');
  console.log(`  运行标识: ${RUN_ID}`);
  console.log('========================================\n');

  // ===== 1. 管理员登录
  await test('1. 管理员登录', async () => {
    const res = await login('admin', 'admin123');
    assert(res.success, `登录失败: ${res.error}`);
    assert(res.data.role === 'admin', '角色错误，应为admin');
    console.log('   用户:', res.data.username, '角色:', res.data.role_label);
  })();

  // ===== 1.5 选择有空闲容量的冷藏库位（防止多次测试后库位满）
  let LOC_MAIN = null;  // 主库位：入库、盘点、扫码用
  let LOC_ALT = null;   // 副库位：S3 转移过去制造库位不一致
  await test('1.5 动态选择冷藏库位（避免容量爆满）', async () => {
    const all = await getLocations();
    assert(all.success, '获取库位失败');
    // 找冷藏区(zone_id=1)库位按空闲从多到少
    let cooled = all.data.filter(l => l.zone_id === 1).sort((a, b) => {
      const fa = a.capacity - (a.occupancy || 0);
      const fb = b.capacity - (b.occupancy || 0);
      return fb - fa;
    });
    // 如果空闲不够（两个库位都<6），创建两个 RUN 专用临时库位，容量 100
    const needFree = 6;
    const topOk = cooled.length >= 2
      && (cooled[0].capacity - (cooled[0].occupancy||0)) >= needFree
      && (cooled[1].capacity - (cooled[1].occupancy||0)) >= needFree;
    if (!topOk) {
      console.log('   现有冷藏库位空闲不足，创建测试专用临时库位...');
      const c1 = await createLocation(`TEST-${RUN_ID}-M`, `测试库位-${RUN_ID}-M`, 1, 100);
      const c2 = await createLocation(`TEST-${RUN_ID}-A`, `测试库位-${RUN_ID}-A`, 1, 100);
      assert(c1.success && c2.success, `创建测试库位失败: ${c1.error||c2.error}`);
      // 刷新列表拿完整信息
      const all2 = await getLocations();
      cooled = all2.data.filter(l => l.zone_id === 1).sort((a, b) => b.id - a.id);
    }
    assert(cooled.length >= 2, '冷藏区库位不足2个（需要主库位+副库位）');
    LOC_MAIN = cooled[0];
    LOC_ALT = cooled[1];
    state.locations = {
      main: { id: LOC_MAIN.id, code: LOC_MAIN.code },
      alt: { id: LOC_ALT.id, code: LOC_ALT.code }
    };
    saveState();
    console.log(`   主库位: ${LOC_MAIN.code} (ID=${LOC_MAIN.id}, 容量=${LOC_MAIN.capacity}, 已用=${LOC_MAIN.occupancy||0})`);
    console.log(`   副库位: ${LOC_ALT.code} (ID=${LOC_ALT.id}, 容量=${LOC_ALT.capacity}, 已用=${LOC_ALT.occupancy||0})`);
  })();

  // ===== 2. 创建 5 个测试样本（带唯一条码）
  await test('2. 创建测试样本（唯一条码批次）', async () => {
    const samples = [
      { key: 'S1', bc: BARCODES.S1 },
      { key: 'S2', bc: BARCODES.S2 },
      { key: 'S3', bc: BARCODES.S3 },
      { key: 'S4', bc: BARCODES.S4 },
      { key: 'S5', bc: BARCODES.S5 }
    ];
    for (const { key, bc } of samples) {
      const res = await createSample(bc, BATCH_MAIN, 1);
      assert(res.success, `创建样本 ${bc} 失败: ${res.error}`);
      state.sampleIds[key] = res.data.id;
      console.log(`   样本 ${bc} 创建成功，ID: ${res.data.id}`);
    }
    saveState();
  })();

  // ===== 3. 样本入库到主库位
  await test(`3. 5 个样本入库到 ${LOC_MAIN.code}`, async () => {
    for (const key of ['S1', 'S2', 'S3', 'S4', 'S5']) {
      const sid = state.sampleIds[key];
      const res = await inboundSample(sid, LOC_MAIN.id);
      assert(res.success, `样本 ${key} (ID=${sid}) 入库到 ${LOC_MAIN.code} 失败: ${res.error}`);
    }
    console.log(`   5个样本入库到 ${LOC_MAIN.code} 成功`);
  })();

  // ===== 4. 准备 mislocated（库位不一致）场景：
  //   S3 台账保持在 LOC_MAIN，扫码 CSV 中 S3 的位置写 LOC_ALT.code
  //   这样盘点算法会看到：台账在 LOC_MAIN 但扫码在 LOC_ALT → mislocated
  await test(`4. 准备 mislocated 场景：S3台账保持在${LOC_MAIN.code}，扫码写${LOC_ALT.code}`, async () => {
    const sid = state.sampleIds.S3;
    const sample = await getSampleById(sid);
    assert(sample.data.current_location_id === LOC_MAIN.id,
      `S3 台账应在 ${LOC_MAIN.code}，实际在 ${sample.data.location_code}`);
    console.log(`   台账 ${sample.data.location_code}，扫码将写 ${LOC_ALT.code} → 制造库位不一致`);
  })();

  // ===== 5. 将 S5 出库（制造已出库被扫）
  await test('5. 将 S5 出库', async () => {
    const sid = state.sampleIds.S5;
    const res = await outboundSample(sid);
    assert(res.success, `出库失败: ${res.error}`);
    console.log(`   样本 ${BARCODES.S5} (ID=${sid}) 出库成功`);
  })();

  // ===== 6. 按库位创建盘点单（盘点范围=主库位，隔离历史数据干扰）
  await test(`6. 按库位创建盘点单（${LOC_MAIN.code}）`, async () => {
    const title = `自动化测试盘点-${RUN_ID}`;
    const res = await createInventory(title, 'location', null, LOC_MAIN.id);
    assert(res.success, `创建盘点单失败: ${res.error}`);
    state.inventoryOrderId = res.data.id;
    state.inventoryOrderNo = res.data.order_no;
    console.log('   盘点单创建成功:', res.data.order_no, 'ID:', res.data.id);
    saveState();
  })();

  // ===== 7. 导入扫码 CSV（包含冲突场景）
  await test('7. 导入扫码CSV（制造5种差异场景）', async () => {
    // 盘点范围：主库位 LOC_MAIN。台账在 LOC_MAIN 的样本：S1、S2、S3、S4
    // 扫码内容：
    //   S1 @ LOC_MAIN  → 匹配
    //   S2 @ LOC_MAIN  → 匹配
    //   S3 @ LOC_ALT   → 库位不一致（台账在 LOC_MAIN，扫码在 LOC_ALT）
    //   S5 @ LOC_MAIN  → 已出库样本被扫到
    //   EXTRA @ LOC_MAIN → 多扫（台账无此样本）
    //   漏扫：S4（台账在 LOC_MAIN，但未扫到）
    const MC = LOC_MAIN.code;
    const AC = LOC_ALT.code;
    const csv = `条码,库位,扫描时间
${BARCODES.S1},${MC},2024-06-15 09:00:00
${BARCODES.S2},${MC},2024-06-15 09:01:00
${BARCODES.S3},${AC},2024-06-15 09:02:00
${BARCODES.S5},${MC},2024-06-15 09:03:00
${BARCODES.EXTRA},${MC},2024-06-15 09:04:00`;

    const res = await importScan(state.inventoryOrderId, csv);
    assert(res.success, `导入失败: ${res.error}`);
    console.log('   导入成功:', res.data.imported, '条');
    const o = res.data.order;
    console.log('   统计: 期望', o.total_expected,
      '扫描', o.total_scanned,
      '匹配', o.total_matched,
      '多扫', o.total_extra,
      '漏扫', o.total_missing,
      '库位不一致', o.total_mislocated,
      '已出库被扫', o.total_outbound_scanned);

    // 按库位盘点仍可能有历史样本在该库位，但这5项本次测试必然产生 → 只校验 >=
    assert(o.total_scanned === 5, `扫描数应为5（5行CSV数据），实际${o.total_scanned}`);
    assert(o.total_extra >= 1, `多扫数应>=1，实际${o.total_extra} ← EXTRA应为多扫`);
    assert(o.total_mislocated >= 1, `库位不一致应>=1，实际${o.total_mislocated} ← S3应为库位不一致`);
    assert(o.total_outbound_scanned >= 1, `已出库被扫应>=1，实际${o.total_outbound_scanned} ← S5已出库却被扫`);
    assert(o.total_missing >= 1, `漏扫应>=1，实际${o.total_missing} ← S4应被漏扫`);
    assert(o.total_matched >= 2, `匹配应>=2，实际${o.total_matched} ← S1,S2应匹配`);
  })();

  // ===== 8. 获取盘点差异列表，保存差异 ID（按条码存，防止同type被历史数据覆盖）
  await test('8. 获取盘点差异列表（检查5类差异都存在）', async () => {
    const res = await getInventoryDetail(state.inventoryOrderId);
    assert(res.success, '获取盘点详情失败');
    const discrepancies = res.data.discrepancies;
    console.log('   差异总数量:', discrepancies.length, '（含历史数据）');
    discrepancies.forEach(d => {
      console.log(`   - ${d.barcode}: ${d.type_label} - ${d.status_label}`);
    });

    // 按条码保存差异 ID
    state.discrepancyIdsByBarcode = {};
    discrepancies.forEach(d => { state.discrepancyIdsByBarcode[d.barcode] = d.id; });
    state.discrepancyTypeByBarcode = {};
    discrepancies.forEach(d => { state.discrepancyTypeByBarcode[d.barcode] = d.type; });

    // 验证本次测试的5个核心差异都存在
    assert(state.discrepancyIdsByBarcode[BARCODES.S3],
      `缺少 S3(${BARCODES.S3}) 的库位不一致差异`);
    assert(state.discrepancyIdsByBarcode[BARCODES.S5],
      `缺少 S5(${BARCODES.S5}) 的已出库被扫差异`);
    assert(state.discrepancyIdsByBarcode[BARCODES.EXTRA],
      `缺少 EXTRA(${BARCODES.EXTRA}) 的多扫差异`);
    assert(state.discrepancyIdsByBarcode[BARCODES.S4],
      `缺少 S4(${BARCODES.S4}) 的漏扫差异`);
    assert(state.discrepancyTypeByBarcode[BARCODES.S3] === 'mislocated',
      `S3 差异类型应为 mislocated`);
    assert(state.discrepancyTypeByBarcode[BARCODES.EXTRA] === 'extra',
      `EXTRA 差异类型应为 extra`);
    assert(state.discrepancyTypeByBarcode[BARCODES.S4] === 'missing',
      `S4 差异类型应为 missing`);
    assert(state.discrepancyTypeByBarcode[BARCODES.S5] === 'outbound_scanned',
      `S5 差异类型应为 outbound_scanned`);

    // 兼容后续的 state.discrepancyIds 读取（取本次的条码对应的id）
    state.discrepancyIds = {
      mislocated: state.discrepancyIdsByBarcode[BARCODES.S3],
      extra: state.discrepancyIdsByBarcode[BARCODES.EXTRA],
      missing: state.discrepancyIdsByBarcode[BARCODES.S4],
      outbound_scanned: state.discrepancyIdsByBarcode[BARCODES.S5]
    };
    saveState();
  })();

  // ===== 9. 权限测试：库管员尝试处理差异（应该被拒绝）
  await test('9. 权限测试：库管员无法处理差异', async () => {
    await logout();
    const loginRes = await login('warehouse', 'wh123');
    assert(loginRes.success, `库管员登录失败: ${loginRes.error}`);
    assert(loginRes.data.role === 'warehouse', `角色错误，应为 warehouse`);
    console.log('   已切换到库管员:', loginRes.data.username);

    const dispId = state.discrepancyIds.mislocated;
    const res = await resolveDiscrepancy(dispId, 'correct_location', { new_location_id: LOC_ALT.id });
    assert(!res.success, '库管员应该被拒绝处理差异，但成功了');
    assert(res.forbidden === true, '应该返回 forbidden 标志');
    console.log('   ✅ 权限拦截成功，库管员无法处理差异');
  })();

  // ===== 10. 库管员可以添加差异说明
  await test('10. 库管员可以添加差异说明', async () => {
    const dispId = state.discrepancyIds.mislocated;
    const res = await addDispNote(dispId, '库管员备注：已核实，确实放错位置了');
    assert(res.success, `添加说明失败: ${res.error}`);
    console.log('   库管员添加差异说明成功');
  })();

  // ===== 11. 切回管理员，处理库位不一致差异
  await test('11. 管理员处理库位不一致差异', async () => {
    await logout();
    const loginRes = await login('admin', 'admin123');
    assert(loginRes.success, '管理员登录失败');

    const dispId = state.discrepancyIds.mislocated;
    // 扫码发现 S3 在 LOC_ALT，相信扫码结果，把台账修正到 LOC_ALT
    const res = await resolveDiscrepancy(dispId, 'correct_location', { new_location_id: LOC_ALT.id });
    assert(res.success, `处理差异失败: ${res.error}`);
    console.log('   库位不一致差异处理成功');

    const sample = await getSampleByBarcode(BARCODES.S3);
    assert(sample.success, `查询样本失败`);
    assert(sample.data.location_code === LOC_ALT.code,
      `样本位置未修正，期望${LOC_ALT.code}，实际${sample.data.location_code}`);
    console.log(`   样本 ${BARCODES.S3} 位置已修正为 ${LOC_ALT.code}`);
  })();

  // ===== 12. 处理多扫差异（补登样本）
  await test('12. 处理多扫差异（补登记样本）', async () => {
    const dispId = state.discrepancyIds.extra;
    const res = await resolveDiscrepancy(dispId, 'register_extra', {
      batch_no: BATCH_EXTRA,
      name: '盘点补登样本'
    });
    assert(res.success, `补登失败: ${res.error}`);
    console.log('   多扫差异处理成功，样本已补登');

    const sample = await getSampleByBarcode(BARCODES.EXTRA);
    assert(sample.success, `补登的条码 ${BARCODES.EXTRA} 不存在: ${sample.error}`);
    state.sampleIds.EXTRA = sample.data.id;
    console.log('   补登样本已存在，ID:', sample.data.id);
    saveState();
  })();

  // ===== 13. 导出盘点结果 CSV
  await test('13. 导出盘点结果CSV', async () => {
    return new Promise((resolve, reject) => {
      const req = http.get(`${BASE_URL}/api/inventory/${state.inventoryOrderId}/export/csv`, (res) => {
        try {
          assert(res.statusCode === 200, `导出失败，状态码${res.statusCode}`);
          assert(res.headers['content-type'].includes('text/csv'), 'Content-Type 错误');
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            assert(data.includes(BARCODES.S1), `CSV中缺少 ${BARCODES.S1}`);
            assert(data.includes(BARCODES.S3), `CSV中缺少 ${BARCODES.S3}`);
            const lineCount = data.split('\n').filter(l => l.trim()).length;
            console.log('   盘点结果CSV导出成功，数据行数:', lineCount);
            resolve();
          });
        } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  })();

  // ===== 14. 撤销功能测试：先转移 S1 到 LOC_ALT 再撤销
  await test('14. 撤销功能测试：转移→撤销→验证反向记录', async () => {
    const sid = state.sampleIds.S1;
    const before = await getSampleById(sid);
    const originalLocation = before.data.current_location_id;
    console.log('   原始位置:', before.data.location_code);

    // 转移到 LOC_ALT
    const transferRes = await transferSample(sid, LOC_ALT.id);
    assert(transferRes.success, `转移失败: ${transferRes.error}`);
    console.log(`   已转移到 ${LOC_ALT.code}`);

    const afterTransfer = await getSampleById(sid);
    assert(afterTransfer.data.current_location_id === LOC_ALT.id, '转移后位置不对');

    // 获取可撤销操作
    const reversable = await getReversableActions(sid);
    assert(reversable.data && reversable.data.length > 0, '没有可撤销的操作');
    const toReverse = reversable.data.find(r => r.action_type === 'transfer');
    assert(toReverse, '未找到 transfer 可撤销记录');
    state.transferTimelineId = toReverse.id;
    console.log('   可撤销转移记录ID:', toReverse.id);

    // 撤销
    const reverseRes = await reverseAction(sid, toReverse.id, '操作失误，需要撤销');
    assert(reverseRes.success, `撤销失败: ${reverseRes.error}`);
    console.log('   撤销操作成功');

    // 验证位置恢复
    const afterReverse = await getSampleById(sid);
    assert(afterReverse.data.current_location_id === originalLocation,
      `撤销后位置未恢复，期望${originalLocation}，实际${afterReverse.data.current_location_id}`);
    console.log('   位置已恢复到:', afterReverse.data.location_code);

    // 验证时间线：有转移 + 撤销转移，原记录不删
    const tl = afterReverse.data.timeline;
    assert(tl.length >= 3, `时间线记录不足，至少3条（登记/入库/转移/撤销转移），实际${tl.length}`);
    const hasTransfer = tl.some(t => t.action_type === 'transfer');
    const hasReverse = tl.some(t => t.action_type === 'reverse_transfer');
    assert(hasTransfer, '原转移记录被删除了（不允许！撤销只能追加，不能删除原记录');
    assert(hasReverse, '时间线中缺少撤销转移记录');
    console.log('   ✅ 原转移记录保留，已追加撤销记录');
    saveState();
  })();

  // ===== 15. 撤销后再出库（验证撤销后状态正确）
  await test('15. 撤销后再出库（验证状态恢复正常）', async () => {
    const sid = state.sampleIds.S1;
    const before = await getSampleById(sid);
    assert(before.data.status === 'in_storage', `样本状态应为in_storage，实际${before.data.status}`);

    const outboundRes = await outboundSample(sid);
    assert(outboundRes.success, `撤销后出库失败: ${outboundRes.error}`);
    console.log('   撤销后样本出库成功');

    const after = await getSampleById(sid);
    assert(after.data.status === 'outbound', `出库后状态错误，应为 outbound`);
    console.log('   ✅ 样本状态已更新为已出库');
  })();

  // ===== 16. 撤销报废测试
  await test('16. 撤销报废测试（新增→入库→报废→撤销）', async () => {
    // 新创建一个报废测试专用样本
    const createRes = await createSample(BARCODES.SCRAP, BATCH_SCRAP, 1);
    assert(createRes.success, `创建样本失败: ${createRes.error}`);
    const sid = createRes.data.id;
    state.sampleIds.SCRAP = sid;

    const ibRes = await inboundSample(sid, LOC_MAIN.id);
    assert(ibRes.success, `入库失败: ${ibRes.error}`);

    const scrapRes = await scrapSample(sid);
    assert(scrapRes.success, `报废失败: ${scrapRes.error}`);
    console.log('   样本已报废');

    const afterScrap = await getSampleById(sid);
    assert(afterScrap.data.status === 'scrapped', `报废后状态错误`);

    // 找可撤销的报废
    const reversable = await getReversableActions(sid);
    const toReverse = reversable.data.find(r => r.action_type === 'scrapped');
    assert(toReverse, '未找到 scrapped 可撤销记录');
    state.scrapTimelineId = toReverse.id;

    // 撤销
    const reverseRes = await reverseAction(sid, toReverse.id, '误报废，需要恢复');
    assert(reverseRes.success, `撤销报废失败: ${reverseRes.error}`);
    console.log('   撤销报废成功');

    const afterReverse = await getSampleById(sid);
    assert(afterReverse.data.status === 'in_storage', `撤销后状态应为 in_storage`);
    assert(afterReverse.data.current_location_id === LOC_MAIN.id,
      `撤销后位置应为 ${LOC_MAIN.id} (${LOC_MAIN.code})，实际 ${afterReverse.data.current_location_id}`);
    console.log(`   ✅ 样本状态已恢复为在库，位置${LOC_MAIN.code}`);
    saveState();
  })();

  // ===== 17. 历史查询 - 按条码查询完整历史
  await test('17. 历史查询 - 按条码（S3，含盘点纠错记录）', async () => {
    const res = await searchHistory({ barcode: BARCODES.S3 });
    assert(res.success, `历史查询失败: ${res.error}`);
    assert(res.data.samples.length === 1, `应找到1个样本，实际${res.data.samples.length}`);

    const sample = res.data.samples[0];
    console.log('   条码查询成功: 时间线', sample.timeline.length, '条，差异', sample.discrepancies.length, '条');

    // S3 时间线至少：登记→入库→盘点纠错 → 共3条以上
    assert(sample.timeline.length >= 3, `时间线记录应>=3，实际${sample.timeline.length}`);
    assert(sample.discrepancies.length >= 1, '差异记录不足，至少1条（mislocated）');

    const hasCorrection = sample.timeline.some(t => t.action_type === 'inventory_correction');
    assert(hasCorrection, '时间线中缺少盘点纠错记录');
    console.log('   ✅ 时间线包含盘点纠错记录');
  })();

  // ===== 18. 历史查询 - 按批次查询
  await test('18. 历史查询 - 按批次（BATCH_MAIN共5条）', async () => {
    const res = await searchHistory({ batch_no: BATCH_MAIN });
    assert(res.success, `批次查询失败: ${res.error}`);
    console.log('   批次查询成功，找到', res.data.samples.length, '个样本');

    // 5 条：S1~S5
    assert(res.data.samples.length === 5, `应找到5个样本（S1~S5），实际${res.data.samples.length}`);
  })();

  // ===== 19. 历史查询 - 按盘点单号查询
  await test('19. 历史查询 - 按盘点单号查询', async () => {
    const res = await searchHistory({ inventory_order_id: state.inventoryOrderNo });
    assert(res.success, `盘点单查询失败: ${res.error}`);
    assert(res.data.inventory_orders.length >= 1, '应找到至少1个盘点单');
    // 找到我们的那个
    const our = res.data.inventory_orders.find(o => o.order_no === state.inventoryOrderNo);
    assert(our, `未找到盘点单 ${state.inventoryOrderNo}`);
    console.log('   盘点单查询成功:', our.order_no);
  })();

  // ===== 20. 持久化验证（当前查询数据一致
  await test('20. 持久化验证：所有数据实时存在（可重启验证）', async () => {
    console.log('   记录当前状态到 test-state.json，供重启后验证...');

    // 验证 S3 状态
    const s3 = await getSampleByBarcode(BARCODES.S3);
    assert(s3.data.status === 'in_storage', `S3状态应为 in_storage`);
    const timelineCount = s3.data.timeline.length;
    console.log('   S3 时间线记录数:', timelineCount);

    // 验证补登的 EXTRA 样本存在
    const extra = await getSampleByBarcode(BARCODES.EXTRA);
    assert(extra.success, `补登样本 ${BARCODES.EXTRA} 不存在`);

    // 验证历史查询差异存在

    const hist = await searchHistory({ barcode: BARCODES.S3 });
    assert(hist.data.samples[0].discrepancies.length >= 1, `S3差异记录未持久化`);

    saveState();
    console.log('   ✅ 所有数据状态正常，test-state.json 已保存（RUN_ID:', RUN_ID, ')');
  })();

  console.log('\n========================================');
  console.log(`  测试完成: ${passed} 通过, ${failed} 失败`);
  console.log('========================================');
  console.log('\n📁 状态文件已保存:', STATE_FILE);
  console.log('   包含：条码/批次/样本ID/盘点单ID，供重启后验证');
  console.log('\n📋 下一步验证:');
  console.log('   1. 重启服务器 (Ctrl+C 然后 node server.js');
  console.log('   2. 运行 node test-restart.js');
  console.log('   3. 或按 README 中的步骤进行页面/API验证');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(e => {
  console.error('测试执行出错:', e);
  process.exit(1);
});
