const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000';
const STATE_FILE = path.join(__dirname, 'test-state-workorder.json');

const RUN_ID = Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36).padStart(3, '0');

const BATCH_WO = `BATCH-WO-${RUN_ID}`;
const BARCODES = {
  W1: `WO-${RUN_ID}-W1`,
  W2: `WO-${RUN_ID}-W2`,
  W3: `WO-${RUN_ID}-W3`,
  W4: `WO-${RUN_ID}-W4`,
  W5: `WO-${RUN_ID}-W5`
};

let state = {
  runId: RUN_ID,
  createdAt: new Date().toISOString(),
  barcodes: BARCODES,
  batch: BATCH_WO,
  sampleIds: {},
  workorderIds: {}
};

let cookieAdmin = null;
let cookieWarehouse = null;
let cookieWhCold = null;

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
          resolve({ body: JSON.parse(data), headers: res.headers });
        } catch (e) {
          resolve({ body: data, headers: res.headers });
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
  const res = await request('/api/auth/login', {
    method: 'POST',
    body: { username, password }
  });
  if (res.headers && res.headers['set-cookie']) {
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    return { cookie, user: res.body.data };
  }
  return { cookie: null, user: res.body.data };
}

async function apiCall(path, options = {}) {
  const { cookie, method, body } = options;
  const headers = {};
  if (cookie) {
    headers['Cookie'] = cookie;
  }
  return request(path, { method: method || 'GET', body, headers });
}

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  results.push({ name, fn });
}

async function runTests() {
  console.log('='.repeat(60));
  console.log('温控异常处置工单 - 验收测试');
  console.log(`RUN_ID: ${RUN_ID}`);
  console.log('='.repeat(60));

  for (const t of results) {
    try {
      await t.fn();
      console.log(`✅ 通过: ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`❌ 失败: ${t.name}`);
      console.log(`   错误: ${e.message}`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`测试结果: ${passed} 通过, ${failed} 失败`);
  console.log('='.repeat(60));

  saveState();

  if (failed > 0) {
    process.exit(1);
  }
}

test('登录管理员账号', async () => {
  const res = await login('admin', 'admin123');
  if (!res.cookie) throw new Error('登录失败');
  cookieAdmin = res.cookie;
});

test('登录库管员账号（全温区）', async () => {
  const res = await login('warehouse', 'wh123');
  if (!res.cookie) throw new Error('登录失败');
  cookieWarehouse = res.cookie;
});

test('登录冷藏库管员账号', async () => {
  const res = await login('wh_cold', 'whcold123');
  if (!res.cookie) throw new Error('登录失败');
  cookieWhCold = res.cookie;
});

test('创建测试样本 - W1 W2 (冷藏), W3 (冷冻)', async () => {
  const samples = [
    { barcode: BARCODES.W1, zone: 1, name: '工单测试样本-W1' },
    { barcode: BARCODES.W2, zone: 1, name: '工单测试样本-W2' },
    { barcode: BARCODES.W3, zone: 2, name: '工单测试样本-W3' },
    { barcode: BARCODES.W4, zone: 1, name: '工单测试样本-W4' },
    { barcode: BARCODES.W5, zone: 1, name: '工单测试样本-W5' }
  ];

  for (const s of samples) {
    const res = await apiCall('/api/samples', {
      cookie: cookieAdmin,
      method: 'POST',
      body: {
        barcode: s.barcode,
        batch_no: BATCH_WO,
        name: s.name,
        required_zone_id: s.zone
      }
    });
    if (!res.body.success) throw new Error(`创建样本 ${s.barcode} 失败: ${res.body.error}`);
    state.sampleIds[s.barcode] = res.body.data.id;
  }
});

test('入库样本 W1 W2 W3 到对应温区', async () => {
  const locMap = { 1: 1, 2: 3 };

  for (const barcode of [BARCODES.W1, BARCODES.W2, BARCODES.W3]) {
    const sampleId = state.sampleIds[barcode];
    const sample = (await apiCall(`/api/samples/${sampleId}`, { cookie: cookieAdmin })).body.data;
    const locId = locMap[sample.required_zone_id];

    const res = await apiCall(`/api/samples/${sampleId}/inbound`, {
      cookie: cookieAdmin,
      method: 'POST',
      body: { location_id: locId }
    });
    if (!res.body.success) throw new Error(`入库 ${barcode} 失败: ${res.body.error}`);
  }
});

test('出库样本 W4，用于测试已出库样本拦截', async () => {
  const sampleId = state.sampleIds[BARCODES.W4];
  const res = await apiCall(`/api/samples/${sampleId}/inbound`, {
    cookie: cookieAdmin,
    method: 'POST',
    body: { location_id: 1 }
  });
  if (!res.body.success) throw new Error('W4 入库失败: ' + res.body.error);

  const res2 = await apiCall(`/api/samples/${sampleId}/outbound`, {
    cookie: cookieAdmin,
    method: 'POST',
    body: { remark: '测试出库' }
  });
  if (!res2.body.success) throw new Error('W4 出库失败: ' + res2.body.error);
});

test('管理员创建温控异常工单 - 温区不匹配类型', async () => {
  const res = await apiCall('/api/workorders', {
    cookie: cookieAdmin,
    method: 'POST',
    body: {
      type: 'zone_mismatch',
      title: '测试工单-温区不匹配',
      description: '测试创建温区不匹配工单',
      priority: 'high',
      sample_ids: [state.sampleIds[BARCODES.W1]]
    }
  });
  if (!res.body.success) throw new Error('创建工单失败: ' + res.body.error);
  state.workorderIds.wo1 = res.body.data.id;
});

test('工单列表查询 - 验证新创建的工单存在', async () => {
  const res = await apiCall('/api/workorders?status=pending', { cookie: cookieAdmin });
  if (!res.body.success) throw new Error('查询工单列表失败');
  const wo = res.body.data.list.find(w => w.id === state.workorderIds.wo1);
  if (!wo) throw new Error('未找到刚创建的工单');
  if (wo.status !== 'pending') throw new Error('工单状态应为 pending');
  if (wo.type !== 'zone_mismatch') throw new Error('工单类型应为 zone_mismatch');
});

test('工单详情查询 - 验证样本关联正确', async () => {
  const res = await apiCall(`/api/workorders/${state.workorderIds.wo1}`, { cookie: cookieAdmin });
  if (!res.body.success) throw new Error('查询工单详情失败');
  const wo = res.body.data;
  if (!wo.samples || wo.samples.length !== 1) throw new Error('工单应关联1个样本');
  if (wo.samples[0].sample_barcode !== BARCODES.W1) throw new Error('关联样本条码不正确');
});

test('样本详情查询 - 验证时间线中存在工单创建记录', async () => {
  const res = await apiCall(`/api/samples/${state.sampleIds[BARCODES.W1]}`, { cookie: cookieAdmin });
  if (!res.body.success) throw new Error('查询样本详情失败');
  const timeline = res.body.data.timeline;
  const woTimeline = timeline.find(t => t.action_type === 'workorder_create');
  if (!woTimeline) throw new Error('样本时间线中未找到工单创建记录');
});

test('重复工单拦截 - 同一样本不能有两个未关闭工单', async () => {
  const res = await apiCall('/api/workorders', {
    cookie: cookieAdmin,
    method: 'POST',
    body: {
      type: 'temp_exception',
      title: '重复工单测试',
      sample_ids: [state.sampleIds[BARCODES.W1]]
    }
  });
  if (res.body.success) throw new Error('应该被重复工单拦截');
  if (!res.body.error.includes('未关闭的重复工单')) throw new Error('错误信息不正确: ' + res.body.error);
});

test('管理员指派工单给库管员', async () => {
  const res = await apiCall(`/api/workorders/${state.workorderIds.wo1}/assign`, {
    cookie: cookieAdmin,
    method: 'POST',
    body: {
      assigned_to_id: 2,
      assigned_to_name: '仓库管理员'
    }
  });
  if (!res.body.success) throw new Error('指派工单失败: ' + res.body.error);

  const detail = await apiCall(`/api/workorders/${state.workorderIds.wo1}`, { cookie: cookieAdmin });
  if (detail.body.data.status !== 'processing') throw new Error('指派后状态应为 processing');
  if (detail.body.data.assigned_to_name !== '仓库管理员') throw new Error('指派人不正确');
});

test('库管员处理自己的工单', async () => {
  const res = await apiCall(`/api/workorders/${state.workorderIds.wo1}/process`, {
    cookie: cookieWarehouse,
    method: 'POST',
    body: {
      handle_result: '已调整到正确温区',
      handle_remark: '样本已移至R-A1库位'
    }
  });
  if (!res.body.success) throw new Error('处理工单失败: ' + res.body.error);
});

test('管理员关闭工单', async () => {
  const res = await apiCall(`/api/workorders/${state.workorderIds.wo1}/close`, {
    cookie: cookieAdmin,
    method: 'POST',
    body: { close_remark: '处理完成，正常关闭' }
  });
  if (!res.body.success) throw new Error('关闭工单失败: ' + res.body.error);

  const detail = await apiCall(`/api/workorders/${state.workorderIds.wo1}`, { cookie: cookieAdmin });
  if (detail.body.data.status !== 'closed') throw new Error('关闭后状态应为 closed');
});

test('管理员驳回工单', async () => {
  const createRes = await apiCall('/api/workorders', {
    cookie: cookieAdmin,
    method: 'POST',
    body: {
      type: 'temp_exception',
      title: '测试驳回工单',
      sample_ids: [state.sampleIds[BARCODES.W2]]
    }
  });
  if (!createRes.body.success) throw new Error('创建工单失败');
  const woId = createRes.body.data.id;
  state.workorderIds.woReject = woId;

  const res = await apiCall(`/api/workorders/${woId}/reject`, {
    cookie: cookieAdmin,
    method: 'POST',
    body: { reject_reason: '信息不足，需要补充更多细节' }
  });
  if (!res.body.success) throw new Error('驳回工单失败: ' + res.body.error);

  const detail = await apiCall(`/api/workorders/${woId}`, { cookie: cookieAdmin });
  if (detail.body.data.status !== 'rejected') throw new Error('驳回后状态应为 rejected');
  if (!detail.body.data.reject_reason) throw new Error('驳回原因为空');
});

test('跨温区权限拦截 - 冷藏库管员不能操作冷冻样本', async () => {
  const res = await apiCall('/api/workorders', {
    cookie: cookieWhCold,
    method: 'POST',
    body: {
      type: 'temp_exception',
      title: '跨温区测试工单',
      sample_ids: [state.sampleIds[BARCODES.W3]]
    }
  });
  if (res.body.success) throw new Error('应该被跨温区权限拦截');
  if (!res.body.forbidden) throw new Error('应返回 forbidden: true');
});

test('已出库样本不能创建普通工单', async () => {
  const res = await apiCall('/api/workorders', {
    cookie: cookieAdmin,
    method: 'POST',
    body: {
      type: 'temp_exception',
      title: '已出库样本测试',
      sample_ids: [state.sampleIds[BARCODES.W4]]
    }
  });
  if (res.body.success) throw new Error('已出库样本不能创建普通工单');
  if (!res.body.error.includes('已出库样本')) throw new Error('错误信息应包含已出库样本');
});

test('已出库样本可以创建 outbound_scanned 类型工单', async () => {
  const res = await apiCall('/api/workorders', {
    cookie: cookieAdmin,
    method: 'POST',
    body: {
      type: 'outbound_scanned',
      title: '已出库样本被扫到',
      sample_ids: [state.sampleIds[BARCODES.W4]]
    }
  });
  if (!res.body.success) throw new Error('outbound_scanned 类型应该可以创建: ' + res.body.error);
  state.workorderIds.woOutbound = res.body.data.id;
});

test('库管员不能处理非自己的工单', async () => {
  const createRes = await apiCall('/api/workorders', {
    cookie: cookieAdmin,
    method: 'POST',
    body: {
      type: 'temp_exception',
      title: '非指派工单测试',
      sample_ids: [state.sampleIds[BARCODES.W5]]
    }
  });
  const woId = createRes.body.data.id;
  state.workorderIds.woOther = woId;

  await apiCall(`/api/workorders/${woId}/assign`, {
    cookie: cookieAdmin,
    method: 'POST',
    body: { assigned_to_id: 5, assigned_to_name: '冷冻库管员' }
  });

  const res = await apiCall(`/api/workorders/${woId}/process`, {
    cookie: cookieWarehouse,
    method: 'POST',
    body: { handle_result: '尝试处理别人的工单' }
  });
  if (res.body.success) throw new Error('应该只能处理指派给自己的工单');
  if (!res.body.forbidden) throw new Error('应返回 forbidden');
});

test('按状态筛选工单', async () => {
  const res = await apiCall('/api/workorders?status=closed', { cookie: cookieAdmin });
  if (!res.body.success) throw new Error('查询失败');
  const closedList = res.body.data.list.filter(w => w.status === 'closed');
  if (closedList.length === 0) throw new Error('应该有关闭的工单');
});

test('按温区筛选工单', async () => {
  const res = await apiCall('/api/workorders?zone_id=1', { cookie: cookieAdmin });
  if (!res.body.success) throw new Error('查询失败');
});

test('按批次筛选工单', async () => {
  const res = await apiCall(`/api/workorders?batch_no=${BATCH_WO}`, { cookie: cookieAdmin });
  if (!res.body.success) throw new Error('查询失败');
  if (res.body.data.total === 0) throw new Error('按批次筛选应该有结果');
});

test('导出门单 CSV', async () => {
  const res = await request('/api/workorders/export/csv', {
    headers: { Cookie: cookieAdmin }
  });
  if (!res.body || typeof res.body !== 'string') throw new Error('导出CSV失败');
  if (!res.body.includes('工单号')) throw new Error('CSV应包含工单号列');
  if (!res.body.includes('状态')) throw new Error('CSV应包含状态列');
});

test('获取样本关联的工单列表', async () => {
  const res = await apiCall(`/api/samples/${state.sampleIds[BARCODES.W1]}/workorders`, {
    cookie: cookieAdmin
  });
  if (!res.body.success) throw new Error('查询失败');
  if (res.body.data.length === 0) throw new Error('样本应有关联工单');
});

test('审计日志 - 验证工单创建有审计记录', async () => {
  const res = await apiCall('/api/audit-logs?action_type=workorder_create', { cookie: cookieAdmin });
});

console.log('准备运行测试...');
runTests().catch(e => {
  console.error('测试执行出错:', e);
  process.exit(1);
});
