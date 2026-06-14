// ============================================================
// 批量导入失败明细回归测试脚本
//
// 场景:
//   1) 先创建 1 条样本 SEED01 (LOT-SEED, 冷藏(2-8℃))
//   2) 再批量导入 3 条有错的 CSV:
//      - 第 1 行: 条码 SEED01  -> 与库中已有的重复
//      - 第 2 行: 空批次      -> 批次不能为空
//      - 第 3 行: 温区不存在   -> 要求温区"不存在的温区"在温区表中不存在
//
// 断言:
//   - 接口 success=false, rollback=true
//   - data.errors 和 data.results 均存在且都有 3 条
//   - 每条的 failure_reason 分别对应 重复 / 空批次 / 无效温区
//   - audit_log 中能找到 3 条逐行失败明细 + 1 条批次汇总
//   - 3 条坏样本都没入库, 而 SEED01 仍在
//
// 运行:
//   (服务已在 http://localhost:3000 启动后)
//   node test-import-ui-regression.js
// ============================================================

const http = require('http');

function req(method, path, data) {
  return new Promise((resolve, reject) => {
    const b = data == null ? '' : JSON.stringify(data);
    const headers = { 'Content-Type': 'application/json' };
    if (b) headers['Content-Length'] = Buffer.byteLength(b);
    const r = http.request({
      hostname: 'localhost', port: 3000, path, method, headers
    }, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({ raw: s }); } });
    });
    r.on('error', reject);
    if (b) r.write(b);
    r.end();
  });
}
function post(p, d) { return req('POST', p, d); }
function get(p)   { return req('GET', p); }

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else      { failed++; console.log('  \u2717 ' + name + (detail ? ' — ' + detail : '')); }
}

async function run() {
  console.log('[1/6] Login admin');
  const login = await post('/api/auth/login', { username: 'admin', password: 'admin123' });
  check('admin 登录成功', login.success);

  console.log('\n[2/6] 先插入 1 条对照样本: 条码 SEED01');
  const seed = await post('/api/samples/import/csv', {
    rows: [{ barcode: 'SEED01', batch_no: 'LOT-SEED', name: 'Seed', required_zone: '冷藏(2-8℃)' }]
  });
  check('种子样本导入成功', seed.success && seed.data.success === 1);
  const seedBatchId = seed.data.batch_id;

  console.log('\n[3/6] 批量导入 3 条有校验错误的 CSV');
  const bad = await post('/api/samples/import/csv', {
    rows: [
      { barcode: 'SEED01',         batch_no: 'LOT-BAD', name: '重复条码',  required_zone: '冷藏(2-8℃)'      },
      { barcode: 'EMPTY_BATCH',    batch_no: '',        name: '空批次',    required_zone: '冷藏(2-8℃)'      },
      { barcode: 'BAD_ZONE',       batch_no: 'LOT-BAD', name: '无效温区',  required_zone: '不存在的温区'      }
    ]
  });

  // ---- 字段完整性 ----
  check('响应 success=false',      bad.success === false);
  check('响应 rollback=true',      bad.data?.rollback === true);
  check('data.errors 存在且为数组', Array.isArray(bad.data?.errors),  '前端 doImport() 读取 res.data.errors');
  check('data.results 存在且为数组(兼容)', Array.isArray(bad.data?.results));
  check('data.errors 长度 = 3',    bad.data.errors.length === 3,      '实际: ' + (bad.data?.errors?.length ?? '-'));
  check('data.results 长度 = 3',   bad.data.results.length === 3);
  check('data.failed = 3',         bad.data.failed === 3);
  check('data.success = 0',        bad.data.success === 0);
  check('data.batch_id 存在',      bad.data.batch_id != null);

  const errs = bad.data.errors;
  const r1 = errs.find(e => e.row_number === 1);
  const r2 = errs.find(e => e.row_number === 2);
  const r3 = errs.find(e => e.row_number === 3);
  check('第 1 行: failure_reason 含"重复"',     !!r1 && /重复/.test(r1.failure_reason || ''), JSON.stringify(r1));
  check('第 2 行: failure_reason 含"批次不能为空"', !!r2 && /批次不能为空/.test(r2.failure_reason || ''), JSON.stringify(r2));
  check('第 3 行: failure_reason 含"温区表中不存在"', !!r3 && /温区表中不存在/.test(r3.failure_reason || ''), JSON.stringify(r3));
  check('每条都有 status=failed', errs.every(e => e.status === 'failed'));

  const badBatchId = bad.data.batch_id;

  console.log('\n[4/6] 验证失败明细已持久化 (不被回滚)');
  const bd = await get('/api/samples/import/batches/' + badBatchId);
  check('批次详情可查',           bd.success);
  check('批次 status=failed',     bd.data?.batch?.status === 'failed');
  check('批次明细共 3 条',        bd.data?.results?.length === 3,
                                 '实际 ' + (bd.data?.results?.length ?? '-'));

  const audit = await get('/api/audit-log?action_type=batch_import&page_size=200');
  check('audit_log 可查', audit.success);
  const list = audit.data?.list || [];
  const perSampleFailed = list.filter(a => a.object_type === 'sample' && /批量导入失败/.test(a.remark || ''));
  const batchSummary    = list.filter(a => a.object_type === 'sample_import_batch' && String(a.object_id) === String(badBatchId));
  const seedBatchAudit  = list.filter(a => a.object_type === 'sample_import_batch' && String(a.object_id) === String(seedBatchId));

  check('audit_log 有 3 条逐行失败样本明细', perSampleFailed.length >= 3, '实际 ' + perSampleFailed.length);
  check('audit_log 有 1 条失败批次汇总',     batchSummary.length >= 1);
  check('种子批次审计日志未受影响',           seedBatchAudit.length >= 1);

  const reasons = perSampleFailed.map(a => {
    try { return JSON.parse(a.after_value || '{}').failure_reason; } catch { return null; }
  });
  check('逐行明细 after_value 都带 failure_reason', reasons.every(r => r),
                                 '缺失 ' + reasons.filter(r => !r).length + ' 条');
  check('存在"重复"原因',         reasons.some(r => /重复/.test(r || '')));
  check('存在"批次不能为空"原因', reasons.some(r => /批次不能为空/.test(r || '')));
  check('存在"温区表中不存在"原因', reasons.some(r => /温区表中不存在/.test(r || '')));

  console.log('\n[5/6] 验证回滚真正生效: 3 条坏样本未入库');
  async function hasBarcode(bc) {
    const r = await get('/api/samples/barcode/' + encodeURIComponent(bc));
    return r.success;
  }
  check('SEED01 仍在',            await hasBarcode('SEED01'));
  check('EMPTY_BATCH 未入库',     !(await hasBarcode('EMPTY_BATCH')));
  check('BAD_ZONE 未入库',        !(await hasBarcode('BAD_ZONE')));

  console.log('\n[6/6] 验证成功分支提示不退化');
  const tag = 'T' + Date.now().toString(36);
  const good = await post('/api/samples/import/csv', {
    rows: [
      { barcode: 'G01-' + tag, batch_no: 'LOT-GOOD-' + tag, name: 'G1', required_zone: '冷冻(-20℃)' },
      { barcode: 'G02-' + tag, batch_no: 'LOT-GOOD-' + tag, name: 'G2' }
    ]
  });
  check('成功分支 success=true',     good.success);
  check('成功分支 data.errors=[]',   Array.isArray(good.data?.errors) && good.data.errors.length === 0,
                                     '实际: ' + JSON.stringify(good.data?.errors));
  check('成功分支 data.results.length=2', good.data?.results?.length === 2);

  console.log('\n========================================');
  console.log('结果: ' + passed + ' 项通过, ' + failed + ' 项失败');
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('脚本异常:', e); process.exit(1); });
