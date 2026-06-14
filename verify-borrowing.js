const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = 'localhost';
const PORT = 3000;
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

    setTimeout(() => {
      if (!started) reject(new Error('服务器启动超时'));
    }, 15000);
  });
}

function stopServer() {
  return new Promise(resolve => {
    if (!SERVER_PROC) { resolve(); return; }
    let done = false;
    SERVER_PROC.on('exit', () => {
      if (done) return;
      done = true;
      resolve();
    });
    try {
      if (process.platform === 'win32') {
        SERVER_PROC.kill('SIGKILL');
      } else {
        SERVER_PROC.kill('SIGTERM');
        setTimeout(() => {
          if (!done && SERVER_PROC && SERVER_PROC.kill) {
            try { SERVER_PROC.kill('SIGKILL'); } catch(e) {}
          }
        }, 3000);
      }
    } catch(e) {}
    setTimeout(() => {
      if (!done) {
        done = true;
        resolve();
      }
    }, 5000);
  });
}

function restartServer() {
  return stopServer().then(() => startServer());
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  try {
    console.log('========== 样本领用与归还模块 验收 ==========\n');

    clearDatabase();
    await startServer();
    await sleep(300);

    console.log('[1] admin 登录');
    const login = await api('/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin123' }
    });
    if (!login.body || !login.body.success) throw new Error('登录失败: ' + JSON.stringify(login.body));
    const ADMIN_COOKIE = login.setCookie;
    console.log('   ✅ admin 登录成功');

    const locs = await api('/api/locations', { cookie: ADMIN_COOKIE });
    const cooledLocs = (locs.body.data || []).filter(l => l.zone_id === 1);
    const LOC_ID_1 = cooledLocs[0].id;
    const LOC_ID_2 = cooledLocs[1].id;
    console.log(`   选库位: ${cooledLocs[0].code}(ID=${LOC_ID_1}), ${cooledLocs[1].code}(ID=${LOC_ID_2})`);

    const TS = Date.now().toString(36);
    const BATCH_NO = 'BRW-TEST-' + TS;

    console.log('\n[2] 登记并入库 4 个样本');
    const itemNames = ['领用样本A', '领用样本B', '领用样本C', '领用样本D'];
    const sampleIds = [];
    const barcodes = [];

    for (let i = 0; i < itemNames.length; i++) {
      const bc = `${BATCH_NO}-S${i + 1}`;
      barcodes.push(bc);
      const r = await api('/api/samples', {
        method: 'POST', cookie: ADMIN_COOKIE,
        body: {
          barcode: bc,
          batch_no: BATCH_NO,
          name: itemNames[i],
          required_zone_id: 1
        }
      });
      if (!r.body.success) throw new Error(`${itemNames[i]} 登记失败: ` + r.body.error);
      sampleIds.push(r.body.data.id);
    }

    const inboundItems = sampleIds.map(sid => ({ sample_id: sid, location_id: LOC_ID_1 }));
    const ib = await api('/api/samples/batch/inbound', {
      method: 'POST', cookie: ADMIN_COOKIE,
      body: { items: inboundItems, remark: '领用测试-入库' }
    });
    if (!ib.body.success) throw new Error('批量入库失败: ' + ib.body.error);
    assert(ib.body.data.success === 4, `应入库4条, 实际=${ib.body.data.success}`);
    console.log('   ✅ 4 条样本已入库');

    // ========== 3. 创建领用单（草稿） ==========
    console.log('\n[3] 创建领用单（草稿状态）');
    const futureDate = new Date(Date.now() + 7 * 86400000).toISOString().substring(0, 10);

    const createRes1 = await api('/api/borrowings', {
      method: 'POST', cookie: ADMIN_COOKIE,
      body: {
        sample_barcode: barcodes[0],
        expected_return_date: futureDate,
        purpose: '实验检测',
        remark: '验收测试-领用1'
      }
    });
    if (!createRes1.body.success) throw new Error('创建领用单1失败: ' + createRes1.body.error);
    const BORROW_ID_1 = createRes1.body.data.id;
    const BORROW_NO_1 = createRes1.body.data.borrowing_no;
    console.log(`   ✅ 领用单1创建成功: ${BORROW_NO_1}(ID=${BORROW_ID_1})`);

    const createRes2 = await api('/api/borrowings', {
      method: 'POST', cookie: ADMIN_COOKIE,
      body: {
        sample_barcode: barcodes[1],
        expected_return_date: futureDate,
        purpose: '质量控制',
        remark: '验收测试-领用2'
      }
    });
    if (!createRes2.body.success) throw new Error('创建领用单2失败: ' + createRes2.body.error);
    const BORROW_ID_2 = createRes2.body.data.id;
    const BORROW_NO_2 = createRes2.body.data.borrowing_no;
    console.log(`   ✅ 领用单2创建成功: ${BORROW_NO_2}(ID=${BORROW_ID_2})`);

    // ========== 4. 查询领用单列表 ==========
    console.log('\n[4] 查询领用单列表');
    const listRes = await api('/api/borrowings', { cookie: ADMIN_COOKIE });
    assert(listRes.body.success, '查询领用单列表失败');
    assert(listRes.body.data.length === 2, `应返回2条领用单, 实际=${listRes.body.data.length}`);
    assert(listRes.body.data[0].status === 'draft', '状态应为draft');
    assert(listRes.body.data[0].status_label === '草稿', '状态标签应为"草稿"');
    console.log('   ✅ 领用单列表查询正确（2条，状态=草稿）');

    // ========== 5. 查询领用单详情 ==========
    console.log('\n[5] 查询领用单详情');
    const detailRes = await api(`/api/borrowings/${BORROW_ID_1}`, { cookie: ADMIN_COOKIE });
    assert(detailRes.body.success, '查询领用单详情失败');
    assert(detailRes.body.data.borrowing_no === BORROW_NO_1, '领用单号不匹配');
    assert(detailRes.body.data.sample_barcode === barcodes[0], '条码不匹配');
    assert(detailRes.body.data.sample_detail, '应包含样本详情');
    assert(detailRes.body.data.sample_detail.barcode === barcodes[0], '样本详情条码不匹配');
    console.log('   ✅ 领用单详情正确（含样本详情）');

    // ========== 6. 重复领用检测 ==========
    console.log('\n[6] 重复领用检测');
    const dupCreate = await api('/api/borrowings', {
      method: 'POST', cookie: ADMIN_COOKIE,
      body: {
        sample_barcode: barcodes[0],
        expected_return_date: futureDate,
        purpose: '重复领用测试'
      }
    });
    assert(!dupCreate.body.success, '已有未归还领用单时应拒绝创建');
    assert(dupCreate.body.error && dupCreate.body.error.includes('未归还'), '应提示已有未归还领用单');
    console.log('   ✅ 重复领用被拒绝');

    // ========== 7. 确认借出（草稿→已借出） ==========
    console.log('\n[7] 确认借出');
    const borrowRes1 = await api(`/api/borrowings/${BORROW_ID_1}/borrow`, {
      method: 'PUT', cookie: ADMIN_COOKIE,
      body: { remark: '验收测试-确认借出' }
    });
    if (!borrowRes1.body.success) throw new Error('确认借出1失败: ' + borrowRes1.body.error);
    console.log('   ✅ 领用单1确认借出成功');

    const borrowRes2 = await api(`/api/borrowings/${BORROW_ID_2}/borrow`, {
      method: 'PUT', cookie: ADMIN_COOKIE,
      body: { remark: '验收测试-确认借出' }
    });
    if (!borrowRes2.body.success) throw new Error('确认借出2失败: ' + borrowRes2.body.error);
    console.log('   ✅ 领用单2确认借出成功');

    // 验证领用单状态
    const borrowedDetail = await api(`/api/borrowings/${BORROW_ID_1}`, { cookie: ADMIN_COOKIE });
    assert(borrowedDetail.body.data.status === 'borrowed', '确认后状态应为borrowed');
    assert(borrowedDetail.body.data.borrowed_at, '借出时间不应为空');
    console.log('   ✅ 确认后状态=已借出，借出时间已记录');

    // 验证样本状态联动
    const sampleAfter = await api(`/api/samples/${sampleIds[0]}`, { cookie: ADMIN_COOKIE });
    assert(sampleAfter.body.data.status === 'borrowed', '样本状态应为borrowed');
    console.log('   ✅ 样本状态联动：已借出');

    // ========== 8. 已借出样本不能再领用 ==========
    console.log('\n[8] 已借出样本不能再领用');
    const borrowAgain = await api('/api/borrowings', {
      method: 'POST', cookie: ADMIN_COOKIE,
      body: {
        sample_barcode: barcodes[0],
        expected_return_date: futureDate,
        purpose: '再借一次'
      }
    });
    assert(!borrowAgain.body.success, '已借出样本应不能再领用');
    console.log('   ✅ 已借出样本领用被拒绝');

    // ========== 9. 归还（完好） ==========
    console.log('\n[9] 归还领用单1（样本完好）');
    const returnRes1 = await api(`/api/borrowings/${BORROW_ID_1}/return`, {
      method: 'PUT', cookie: ADMIN_COOKIE,
      body: {
        return_location_id: LOC_ID_2,
        sample_condition: '完好',
        return_remark: '验收测试-完好归还'
      }
    });
    if (!returnRes1.body.success) throw new Error('归还1失败: ' + returnRes1.body.error);
    console.log('   ✅ 领用单1归还成功（完好）');

    const returnedDetail1 = await api(`/api/borrowings/${BORROW_ID_1}`, { cookie: ADMIN_COOKIE });
    assert(returnedDetail1.body.data.status === 'returned', '归还后状态应为returned');
    assert(returnedDetail1.body.data.return_sample_condition === '完好', '归还样本状态应为完好');
    assert(returnedDetail1.body.data.returned_at, '归还时间不应为空');
    assert(returnedDetail1.body.data.returned_by, '归还人不应为空');
    console.log('   ✅ 归还后状态=已归还，归还人/时间/样本状态已记录');

    // 验证样本回到在库
    const sampleReturn1 = await api(`/api/samples/${sampleIds[0]}`, { cookie: ADMIN_COOKIE });
    assert(sampleReturn1.body.data.status === 'in_storage', '完好归还后样本应在库');
    assert(sampleReturn1.body.data.current_location_id === LOC_ID_2, '完好归还后样本应回到指定库位');
    console.log('   ✅ 样本回到在库，放回指定库位');

    // ========== 10. 归还（损坏→报废） ==========
    console.log('\n[10] 归还领用单2（样本损坏→联动报废）');
    const returnRes2 = await api(`/api/borrowings/${BORROW_ID_2}/return`, {
      method: 'PUT', cookie: ADMIN_COOKIE,
      body: {
        return_location_id: LOC_ID_1,
        sample_condition: '损坏',
        return_remark: '运输中破损'
      }
    });
    if (!returnRes2.body.success) throw new Error('归还2失败: ' + returnRes2.body.error);
    console.log('   ✅ 领用单2归还成功（损坏）');

    const returnedDetail2 = await api(`/api/borrowings/${BORROW_ID_2}`, { cookie: ADMIN_COOKIE });
    assert(returnedDetail2.body.data.return_sample_condition === '损坏', '归还样本状态应为损坏');
    console.log('   ✅ 归还样本状态=损坏');

    // 验证样本联动标记为报废
    const sampleReturn2 = await api(`/api/samples/${sampleIds[1]}`, { cookie: ADMIN_COOKIE });
    assert(sampleReturn2.body.data.status === 'scrapped', '损坏归还后样本应标记为报废');
    assert(sampleReturn2.body.data.current_location_id === null, '报废后样本不应有库位');
    console.log('   ✅ 样本联动标记为报废，库位已清空');

    // ========== 11. 归还（遗失→丢失） ==========
    console.log('\n[11] 创建领用单3并归还（样本遗失→联动丢失）');
    const createRes3 = await api('/api/borrowings', {
      method: 'POST', cookie: ADMIN_COOKIE,
      body: {
        sample_barcode: barcodes[2],
        expected_return_date: futureDate,
        purpose: '遗失测试'
      }
    });
    if (!createRes3.body.success) throw new Error('创建领用单3失败: ' + createRes3.body.error);
    const BORROW_ID_3 = createRes3.body.data.id;
    console.log(`   领用单3创建成功`);

    const borrowRes3 = await api(`/api/borrowings/${BORROW_ID_3}/borrow`, {
      method: 'PUT', cookie: ADMIN_COOKIE
    });
    if (!borrowRes3.body.success) throw new Error('确认借出3失败: ' + borrowRes3.body.error);

    const returnRes3 = await api(`/api/borrowings/${BORROW_ID_3}/return`, {
      method: 'PUT', cookie: ADMIN_COOKIE,
      body: {
        return_location_id: LOC_ID_1,
        sample_condition: '遗失',
        return_remark: '样本无法找到'
      }
    });
    if (!returnRes3.body.success) throw new Error('归还3失败: ' + returnRes3.body.error);
    console.log('   ✅ 领用单3归还成功（遗失）');

    const sampleReturn3 = await api(`/api/samples/${sampleIds[2]}`, { cookie: ADMIN_COOKIE });
    assert(sampleReturn3.body.data.status === 'lost', '遗失归还后样本应标记为丢失');
    console.log('   ✅ 样本联动标记为丢失');

    // ========== 12. 生命周期校验 ==========
    console.log('\n[12] 生命周期校验：已归还不能再次操作');
    const reBorrow = await api(`/api/borrowings/${BORROW_ID_1}/borrow`, {
      method: 'PUT', cookie: ADMIN_COOKIE
    });
    assert(!reBorrow.body.success, '已归还领用单不应能再次借出');
    console.log('   ✅ 已归还领用单再次借出被拒绝');

    const reReturn = await api(`/api/borrowings/${BORROW_ID_1}/return`, {
      method: 'PUT', cookie: ADMIN_COOKIE,
      body: { return_location_id: LOC_ID_1, sample_condition: '完好' }
    });
    assert(!reReturn.body.success, '已归还领用单不应能再次归还');
    console.log('   ✅ 已归还领用单再次归还被拒绝');

    // ========== 13. 普通用户权限验证 ==========
    console.log('\n[13] 普通用户权限验证');

    const whLogin = await api('/api/auth/login', {
      method: 'POST', body: { username: 'warehouse', password: 'wh123' }
    });
    if (!whLogin.body || !whLogin.body.success) throw new Error('warehouse 登录失败');
    const WH_COOKIE = whLogin.setCookie;
    const WH_USER_ID = whLogin.body.data.id;
    console.log('   warehouse 登录成功');

    // warehouse 创建领用单
    const whCreate = await api('/api/borrowings', {
      method: 'POST', cookie: WH_COOKIE,
      body: {
        sample_barcode: barcodes[3],
        expected_return_date: futureDate,
        purpose: '库管员领用测试'
      }
    });
    assert(whCreate.body.success, 'warehouse 创建领用单失败: ' + (whCreate.body.error || ''));
    const WH_BORROW_ID = whCreate.body.data.id;
    console.log('   ✅ warehouse 创建领用单成功');

    // warehouse 查看列表：只能看到自己的
    const whList = await api('/api/borrowings', { cookie: WH_COOKIE });
    assert(whList.body.success, 'warehouse 查询列表失败');
    const whOtherBorrowings = whList.body.data.filter(b => b.borrower_id !== WH_USER_ID);
    assert(whOtherBorrowings.length === 0, `warehouse 不应看到别人的领用单, 实际看到${whOtherBorrowings.length}条`);
    console.log(`   ✅ warehouse 只能看到自己的领用记录（${whList.body.data.length}条）`);

    // warehouse 不能看别人的领用详情
    const whOtherDetail = await api(`/api/borrowings/${BORROW_ID_1}`, { cookie: WH_COOKIE });
    assert(!whOtherDetail.body.success, 'warehouse 不应看到admin的领用详情');
    assert(whOtherDetail.body.error && whOtherDetail.body.error.includes('无权'), '应返回无权提示');
    console.log('   ✅ warehouse 无权查看别人的领用详情');

    // admin 能看全部
    const adminRelogin = await api('/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin123' }
    });
    if (!adminRelogin.body || !adminRelogin.body.success) throw new Error('admin 重新登录失败');
    const ADMIN_COOKIE2 = adminRelogin.setCookie;

    const adminList = await api('/api/borrowings', { cookie: ADMIN_COOKIE2 });
    assert(adminList.body.data.length >= 4, `admin 应能看到全部领用单, 实际=${adminList.body.data.length}`);
    console.log(`   ✅ admin 能看到全部领用单（${adminList.body.data.length}条）`);

    const ADMIN_CURR = ADMIN_COOKIE2;

    // ========== 14. 逾期检测 ==========
    console.log('\n[14] 逾期检测');

    // 创建一个预计归还日期为过去的领用单（需要先创建一个在库样本）
    const overdueSampleBarcode = `${BATCH_NO}-S5`;
    const overdueSampleRes = await api('/api/samples', {
      method: 'POST', cookie: ADMIN_CURR,
      body: {
        barcode: overdueSampleBarcode,
        batch_no: BATCH_NO,
        name: '逾期测试样本',
        required_zone_id: 1
      }
    });
    if (!overdueSampleRes.body.success) throw new Error('逾期测试样本登记失败: ' + overdueSampleRes.body.error);
    const overdueSampleId = overdueSampleRes.body.data.id;

    await api('/api/samples/batch/inbound', {
      method: 'POST', cookie: ADMIN_CURR,
      body: { items: [{ sample_id: overdueSampleId, location_id: LOC_ID_1 }], remark: '逾期测试入库' }
    });

    const pastDate = new Date(Date.now() - 7 * 86400000).toISOString().substring(0, 10);
    const overdueCreate = await api('/api/borrowings', {
      method: 'POST', cookie: ADMIN_CURR,
      body: {
        sample_barcode: overdueSampleBarcode,
        expected_return_date: pastDate,
        purpose: '逾期测试'
      }
    });
    assert(overdueCreate.body.success, '创建逾期领用单应成功（草稿不检查日期）');
    const OVERDUE_BORROW_ID = overdueCreate.body.data.id;
    console.log('   ✅ 逾期领用单创建成功（预计归还日期为过去）');

    // 确认借出
    const overdueBorrow = await api(`/api/borrowings/${OVERDUE_BORROW_ID}/borrow`, {
      method: 'PUT', cookie: ADMIN_CURR
    });
    assert(overdueBorrow.body.success, '逾期领用单确认借出应成功');
    console.log('   ✅ 逾期领用单确认借出成功');

    // 查询列表时触发逾期标记
    const listAfterOverdue = await api('/api/borrowings', { cookie: ADMIN_CURR });
    const overdueBorrowing = listAfterOverdue.body.data.find(b => b.id === OVERDUE_BORROW_ID);
    assert(overdueBorrowing && overdueBorrowing.status === 'overdue', '逾期领用单应被自动标记为overdue');
    console.log('   ✅ 查询列表时逾期领用单自动标记为"逾期"');

    // 逾期清单接口
    const overdueList = await api('/api/borrowings/overdue', { cookie: ADMIN_CURR });
    assert(overdueList.body.success, '逾期清单接口失败');
    assert(overdueList.body.data.length >= 1, `逾期清单应至少1条, 实际=${overdueList.body.data.length}`);
    const found = overdueList.body.data.find(b => b.id === OVERDUE_BORROW_ID);
    assert(found, '逾期清单应包含逾期领用单');
    console.log(`   ✅ 逾期清单返回 ${overdueList.body.data.length} 条`);

    // 逾期后仍可归还
    const overdueReturn = await api(`/api/borrowings/${OVERDUE_BORROW_ID}/return`, {
      method: 'PUT', cookie: ADMIN_CURR,
      body: {
        return_location_id: LOC_ID_1,
        sample_condition: '完好',
        return_remark: '逾期归还'
      }
    });
    if (!overdueReturn.body.success) throw new Error('逾期归还失败: ' + overdueReturn.body.error);
    console.log('   ✅ 逾期领用单仍可归还');

    // ========== 15. 审计日志验证 ==========
    console.log('\n[15] 审计日志验证');

    const auditCreate = await api('/api/audit-log?action_type=borrowing_create&page_size=50', { cookie: ADMIN_CURR });
    assert(auditCreate.body.success, '查询创建领用审计日志失败');
    assert(auditCreate.body.data.total >= 4, `应至少有4条创建领用审计日志, 实际=${auditCreate.body.data.total}`);
    console.log(`   ✅ 创建领用审计日志: ${auditCreate.body.data.total} 条`);

    const auditBorrow = await api('/api/audit-log?action_type=borrowing_borrow&page_size=50', { cookie: ADMIN_CURR });
    assert(auditBorrow.body.data.total >= 4, `应至少有4条确认借出审计日志, 实际=${auditBorrow.body.data.total}`);
    console.log(`   ✅ 确认借出审计日志: ${auditBorrow.body.data.total} 条`);

    const auditReturn = await api('/api/audit-log?action_type=borrowing_return&page_size=50', { cookie: ADMIN_CURR });
    assert(auditReturn.body.data.total >= 3, `应至少有3条归还审计日志, 实际=${auditReturn.body.data.total}`);
    console.log(`   ✅ 归还审计日志: ${auditReturn.body.data.total} 条`);

    const auditOverdue = await api('/api/audit-log?action_type=borrowing_overdue&page_size=50', { cookie: ADMIN_CURR });
    assert(auditOverdue.body.data.total >= 1, `应至少有1条逾期审计日志, 实际=${auditOverdue.body.data.total}`);
    console.log(`   ✅ 逾期审计日志: ${auditOverdue.body.data.total} 条`);

    // 检查样本领用出库的审计日志
    const auditOutbound = await api('/api/audit-log?action_type=outbound&page_size=50', { cookie: ADMIN_CURR });
    const borrowOutboundLogs = auditOutbound.body.data.list.filter(l =>
      l.after_value_parsed && l.after_value_parsed.status === 'borrowed'
    );
    assert(borrowOutboundLogs.length >= 4, `应至少有4条领用出库审计日志, 实际=${borrowOutboundLogs.length}`);
    console.log(`   ✅ 样本领用出库审计日志: ${borrowOutboundLogs.length} 条`);

    // ========== 16. 重启验证 ==========
    console.log('\n[16] 重启验证：领用数据持久化');

    const beforeRestartList = await api('/api/borrowings', { cookie: ADMIN_CURR });
    const beforeCount = beforeRestartList.body.data.length;
    console.log(`   重启前领用单数: ${beforeCount}`);

    console.log('   正在重启服务器...');
    await stopServer();
    await sleep(2000);
    await startServer();
    await sleep(1000);

    const relogin = await api('/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin123' }
    });
    if (!relogin.body || !relogin.body.success) throw new Error('重启后登录失败');
    const COOKIE_AFTER = relogin.setCookie;
    console.log('   ✅ 重启后登录成功');

    const afterRestartList = await api('/api/borrowings', { cookie: COOKIE_AFTER });
    assert(afterRestartList.body.data.length === beforeCount,
      `重启后领用单数应=${beforeCount}, 实际=${afterRestartList.body.data.length}`);
    console.log(`   ✅ 重启后领用数据完整（${afterRestartList.body.data.length}条）`);

    // 验证已归还的领用单重启后状态依然正确
    const returnedAfterRestart = await api(`/api/borrowings/${BORROW_ID_1}`, { cookie: COOKIE_AFTER });
    assert(returnedAfterRestart.body.data.status === 'returned', '重启后已归还领用单状态应保持');
    console.log('   ✅ 重启后已归还领用单状态保持不变');

    // 验证样本状态重启后也保持
    const sampleAfterRestart = await api(`/api/samples/${sampleIds[0]}`, { cookie: COOKIE_AFTER });
    assert(sampleAfterRestart.body.data.status === 'in_storage', '重启后完好归还的样本应在库');
    const scrappedAfterRestart = await api(`/api/samples/${sampleIds[1]}`, { cookie: COOKIE_AFTER });
    assert(scrappedAfterRestart.body.data.status === 'scrapped', '重启后损坏归还的样本应报废');
    console.log('   ✅ 重启后样本状态保持不变');

    // ========== 17. 未登录访问验证 ==========
    console.log('\n[17] 未登录访问验证');
    await api('/api/auth/logout', { method: 'POST', cookie: COOKIE_AFTER });

    const noAuth1 = await api('/api/borrowings', {});
    assert(noAuth1.body && noAuth1.body.needLogin, '未登录访问领用列表应被拒绝');
    console.log('   ✅ 未登录访问领用列表被拒绝');

    const noAuth2 = await api('/api/borrowings', {
      method: 'POST', body: { sample_barcode: 'X', expected_return_date: '2026-01-01', purpose: 'test' }
    });
    assert(noAuth2.body && noAuth2.body.needLogin, '未登录创建领用单应被拒绝');
    console.log('   ✅ 未登录创建领用单被拒绝');

    const noAuth3 = await api('/api/borrowings/overdue', {});
    assert(noAuth3.body && noAuth3.body.needLogin, '未登录访问逾期清单应被拒绝');
    console.log('   ✅ 未登录访问逾期清单被拒绝');

    // ========== 验收结论 ==========
    console.log('\n========== 验收结论 ==========');
    console.log('✅ POST /api/borrowings: 创建领用单（草稿状态）');
    console.log('✅ GET /api/borrowings: 领用单列表查询（含样本信息）');
    console.log('✅ GET /api/borrowings/:id: 领用单详情查询（含样本详情）');
    console.log('✅ PUT /api/borrowings/:id/borrow: 确认借出（草稿→已借出，联动样本状态）');
    console.log('✅ PUT /api/borrowings/:id/return: 归还样本（已借出/逾期→已归还）');
    console.log('✅ 归还完好：样本回到在库并指定库位');
    console.log('✅ 归还损坏：样本联动标记为报废');
    console.log('✅ 归还遗失：样本联动标记为丢失');
    console.log('✅ 同一条码样本还在外借中不能重复领用');
    console.log('✅ 生命周期：草稿→已借出→已归还/逾期');
    console.log('✅ 逾期自动检测与标记');
    console.log('✅ GET /api/borrowings/overdue: 逾期清单接口');
    console.log('✅ 普通用户只能看自己的领用记录，管理员能看全部');
    console.log('✅ 审计日志：创建/确认借出/归还/逾期全流程可追踪');
    console.log('✅ 重启后数据不丢失');
    console.log('✅ 未登录访问被拒绝');
    console.log('\n🎉 样本领用与归还模块 验收通过！');

  } catch (e) {
    console.error('\n❌ 验收失败:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await stopServer();
  }
}

main();
