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

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
    console.log('========== 指定领用人功能 专项验收 ==========\n');

    clearDatabase();
    await startServer();
    await sleep(300);

    // 先 admin 登录，获取用户 ID
    const { user: adminUser } = await login('admin', 'admin123');
    const ADMIN_ID = adminUser.id;
    console.log(`[1] admin 登录 (id=${ADMIN_ID})`);

    // 获取用户信息（manager 也是 admin 角色，warehouse 是普通用户）
    const { user: whUser } = await login('warehouse', 'wh123');
    const WH_ID = whUser.id;
    const WH_NAME = whUser.real_name;
    console.log(`    warehouse 登录 (id=${WH_ID}, name=${WH_NAME}, role=${whUser.role})`);

    const { user: mgrUser } = await login('manager', 'mgr123');
    const MGR_ID = mgrUser.id;
    const MGR_NAME = mgrUser.real_name;
    console.log(`    manager 登录 (id=${MGR_ID}, name=${MGR_NAME}, role=${mgrUser.role})`);

    // 重新切回 admin
    const adminSession = await login('admin', 'admin123');

    // 选库位
    const locs = await api('/api/locations', { cookie: adminSession.cookie });
    const cooledLocs = (locs.body.data || []).filter(l => l.zone_id === 1);
    const LOC_ID_1 = cooledLocs[0].id;
    const LOC_CODE_1 = cooledLocs[0].code;
    console.log(`    选库位: ${LOC_CODE_1}(ID=${LOC_ID_1})`);

    const TS = Date.now().toString(36);
    const BATCH_NO = 'BWR-TEST-' + TS;

    // 准备样本
    console.log('\n[2] 登记并入库 3 个测试样本');
    const barcodes = [];
    const sampleIds = [];
    for (let i = 0; i < 3; i++) {
      const bc = `${BATCH_NO}-S${i + 1}`;
      barcodes.push(bc);
      const r = await api('/api/samples', {
        method: 'POST', cookie: adminSession.cookie,
        body: { barcode: bc, batch_no: BATCH_NO, name: `样本${i + 1}`, required_zone_id: 1 }
      });
      assert(r.body.success, `样本${i + 1}登记失败: ${r.body.error}`);
      sampleIds.push(r.body.data.id);
    }
    const ib = await api('/api/samples/batch/inbound', {
      method: 'POST', cookie: adminSession.cookie,
      body: { items: sampleIds.map(sid => ({ sample_id: sid, location_id: LOC_ID_1 })), remark: '指定领用人测试' }
    });
    assert(ib.body.success, `批量入库失败: ${ib.body.error}`);
    console.log('   ✅ 3 个样本已入库');

    const futureDate = new Date(Date.now() + 7 * 86400000).toISOString().substring(0, 10);

    // ========== 3. 管理员替 warehouse 建领用单 ==========
    console.log('\n[3] 管理员替 warehouse 用户建领用单');
    const createForWh = await api('/api/borrowings', {
      method: 'POST', cookie: adminSession.cookie,
      body: {
        sample_barcode: barcodes[0],
        expected_return_date: futureDate,
        purpose: '管理员代建-仓库领用',
        borrower_id: WH_ID
      }
    });
    assert(createForWh.body.success, `管理员替人建领用单失败: ${createForWh.body.error}`);
    const BORROW_ID_1 = createForWh.body.data.id;
    const BORROW_NO_1 = createForWh.body.data.borrowing_no;

    // admin 查详情，验证 borrower
    const detail1 = await api(`/api/borrowings/${BORROW_ID_1}`, { cookie: adminSession.cookie });
    assert(detail1.body.data.borrower_id === WH_ID,
      `borrower_id 应为${WH_ID}，实际=${detail1.body.data.borrower_id}`);
    assert(detail1.body.data.borrower_name === WH_NAME,
      `borrower_name 应为${WH_NAME}，实际=${detail1.body.data.borrower_name}`);
    console.log(`   ✅ 领用单 ${BORROW_NO_1} 领用人正确：${WH_NAME}(id=${WH_ID})`);

    // ========== 4. 管理员替 manager 建领用单 ==========
    console.log('\n[4] 管理员替 manager 用户建领用单');
    const createForMgr = await api('/api/borrowings', {
      method: 'POST', cookie: adminSession.cookie,
      body: {
        sample_barcode: barcodes[1],
        expected_return_date: futureDate,
        purpose: '管理员代建-经理领用',
        borrower_id: MGR_ID
      }
    });
    assert(createForMgr.body.success, `管理员替manager建领用单失败: ${createForMgr.body.error}`);
    const BORROW_ID_2 = createForMgr.body.data.id;
    const BORROW_NO_2 = createForMgr.body.data.borrowing_no;

    const detail2 = await api(`/api/borrowings/${BORROW_ID_2}`, { cookie: adminSession.cookie });
    assert(detail2.body.data.borrower_id === MGR_ID,
      `borrower_id 应为${MGR_ID}，实际=${detail2.body.data.borrower_id}`);
    assert(detail2.body.data.borrower_name === MGR_NAME,
      `borrower_name 应为${MGR_NAME}，实际=${detail2.body.data.borrower_name}`);
    console.log(`   ✅ 领用人正确：${MGR_NAME}(id=${MGR_ID})`);

    // ========== 5. 传无效 borrower_id 报错 ==========
    console.log('\n[5] 管理员传无效 borrower_id 应报错');
    const invalidCreate = await api('/api/borrowings', {
      method: 'POST', cookie: adminSession.cookie,
      body: {
        sample_barcode: barcodes[2],
        expected_return_date: futureDate,
        purpose: '无效用户测试',
        borrower_id: 99999
      }
    });
    assert(!invalidCreate.body.success, '传无效 borrower_id 应失败');
    assert(invalidCreate.body.error && invalidCreate.body.error.includes('不存在'),
      `错误信息应提示用户不存在，实际: ${invalidCreate.body.error}`);
    console.log('   ✅ 无效 borrower_id 正确报错');

    // ========== 6. 普通用户传 borrower_id 被忽略 ==========
    console.log('\n[6] 普通用户传 borrower_id 应被忽略（强制用自己）');

    const whSession = await login('warehouse', 'wh123');

    const whCreateWithId = await api('/api/borrowings', {
      method: 'POST', cookie: whSession.cookie,
      body: {
        sample_barcode: barcodes[2],
        expected_return_date: futureDate,
        purpose: '普通用户传borrower_id测试',
        borrower_id: ADMIN_ID
      }
    });
    assert(whCreateWithId.body.success, '普通用户创建领用单应成功（忽略borrower_id）');
    const BORROW_ID_3 = whCreateWithId.body.data.id;

    const detail3 = await api(`/api/borrowings/${BORROW_ID_3}`, { cookie: whSession.cookie });
    assert(detail3.body.data.borrower_id === WH_ID,
      `普通用户传了 borrower_id 也应用自己的 id，应为${WH_ID}，实际=${detail3.body.data.borrower_id}`);
    console.log('   ✅ 普通用户传 borrower_id 被忽略，领用人仍为自己');

    // ========== 7. 权限隔离：普通用户只能看自己的 ==========
    console.log('\n[7] 权限隔离验证：普通用户只能看自己的领用单');

    const whList = await api('/api/borrowings', { cookie: whSession.cookie });
    const whOnlyOwn = whList.body.data.every(b => b.borrower_id === WH_ID);
    assert(whOnlyOwn, 'warehouse 作为普通用户只能看到自己的领用单');
    console.log(`   ✅ warehouse 只能看到自己的领用单（${whList.body.data.length}条，全部是自己的）`);

    // admin 能看到全部
    const adminBackSession = await login('admin', 'admin123');
    const adminList = await api('/api/borrowings', { cookie: adminBackSession.cookie });
    assert(adminList.body.data.length >= 3, `admin 应能看到全部领用单（应>=3条，实际=${adminList.body.data.length}条）`);
    console.log(`   ✅ admin 能看到全部领用单（${adminList.body.data.length}条）`);

    // ========== 8. 代建领用单完整链路 ==========
    console.log('\n[8] 代建领用单完整链路（借出→归还→样本联动→库位恢复）');

    const adminSession2 = await login('admin', 'admin123');

    // admin 替 warehouse 确认借出
    const borrowRes = await api(`/api/borrowings/${BORROW_ID_1}/borrow`, {
      method: 'PUT', cookie: adminSession2.cookie,
      body: { remark: 'admin代确认借出' }
    });
    assert(borrowRes.body.success, `admin代确认借出失败: ${borrowRes.body.error}`);
    console.log('   ✅ admin 替 warehouse 确认借出成功');

    const afterBorrow = await api(`/api/samples/${sampleIds[0]}`, { cookie: adminSession2.cookie });
    assert(afterBorrow.body.data.status === 'borrowed', '借出后样本状态应为borrowed');
    console.log('   ✅ 样本状态联动：已借出');

    // warehouse 自己归还（完好）
    const whSession2 = await login('warehouse', 'wh123');
    const returnRes = await api(`/api/borrowings/${BORROW_ID_1}/return`, {
      method: 'PUT', cookie: whSession2.cookie,
      body: {
        return_location_id: LOC_ID_1,
        sample_condition: '完好',
        return_remark: '仓库人员自己归还'
      }
    });
    assert(returnRes.body.success, `warehouse归还失败: ${returnRes.body.error}`);
    console.log('   ✅ warehouse 自己归还成功');

    const afterReturn = await api(`/api/samples/${sampleIds[0]}`, { cookie: adminSession2.cookie });
    assert(afterReturn.body.data.status === 'in_storage', '归还后样本应回到在库');
    assert(afterReturn.body.data.current_location_id === LOC_ID_1, '归还后样本应在指定库位');
    console.log('   ✅ 样本回到在库，库位正确');

    // ========== 9. 审计日志中领用人信息正确 ==========
    console.log('\n[9] 审计日志验证（领用人信息正确）');

    const adminSession3 = await login('admin', 'admin123');
    const auditCreate = await api('/api/audit-log?action_type=borrowing_create&page_size=50', { cookie: adminSession3.cookie });
    assert(auditCreate.body.success, '查询审计日志失败');

    const borrow1Logs = auditCreate.body.data.list.filter(l =>
      l.object_type === 'sample_borrowing' && l.object_id === String(BORROW_ID_1)
    );
    assert(borrow1Logs.length >= 1, '应至少有1条领用创建审计日志');

    const logAfter = borrow1Logs[0].after_value_parsed || JSON.parse(borrow1Logs[0].after_value);
    assert(logAfter.borrower_id === WH_ID,
      `审计日志中 borrower_id 应为${WH_ID}，实际=${logAfter.borrower_id}`);
    assert(logAfter.borrower_name === WH_NAME,
      `审计日志中 borrower_name 应为${WH_NAME}，实际=${logAfter.borrower_name}`);
    console.log('   ✅ 审计日志中领用人信息正确');

    // ========== 10. 逾期链路（代建→借出→逾期） ==========
    console.log('\n[10] 代建领用单的逾期检测');

    const adminSession4 = await login('admin', 'admin123');

    // 登记入库一个新样本
    const overdueBarcode = `${BATCH_NO}-S9`;
    const overdueSample = await api('/api/samples', {
      method: 'POST', cookie: adminSession4.cookie,
      body: { barcode: overdueBarcode, batch_no: BATCH_NO, name: '逾期测试样本', required_zone_id: 1 }
    });
    assert(overdueSample.body.success, '逾期测试样本登记失败');

    await api('/api/samples/batch/inbound', {
      method: 'POST', cookie: adminSession4.cookie,
      body: { items: [{ sample_id: overdueSample.body.data.id, location_id: LOC_ID_1 }], remark: '逾期测试' }
    });

    const pastDate = new Date(Date.now() - 3 * 86400000).toISOString().substring(0, 10);
    const overdueCreate = await api('/api/borrowings', {
      method: 'POST', cookie: adminSession4.cookie,
      body: {
        sample_barcode: overdueBarcode,
        expected_return_date: pastDate,
        purpose: '代建逾期测试',
        borrower_id: WH_ID
      }
    });
    assert(overdueCreate.body.success, '代建逾期领用单应成功');
    const OVERDUE_BORROW_ID = overdueCreate.body.data.id;

    // 确认借出
    await api(`/api/borrowings/${OVERDUE_BORROW_ID}/borrow`, {
      method: 'PUT', cookie: adminSession4.cookie
    });

    // warehouse 看自己的逾期清单
    const whSession3 = await login('warehouse', 'wh123');
    const whOverdue = await api('/api/borrowings/overdue', { cookie: whSession3.cookie });
    const found = whOverdue.body.data.find(b => b.id === OVERDUE_BORROW_ID);
    assert(found, 'warehouse 应在逾期清单中看到代建的领用单');
    assert(found.borrower_id === WH_ID, '逾期清单中 borrower_id 应正确');
    console.log('   ✅ 代建领用单逾期检测正常，warehouse 能看到自己的逾期');

    // ========== 11. 重启后数据不丢 ==========
    console.log('\n[11] 重启验证：代建领用单数据持久化');

    const adminSession5 = await login('admin', 'admin123');
    const beforeRestart = await api('/api/borrowings', { cookie: adminSession5.cookie });
    const beforeCount = beforeRestart.body.data.length;
    console.log(`   重启前领用单数: ${beforeCount}`);

    console.log('   正在重启服务器...');
    await stopServer();
    await sleep(2000);
    await startServer();
    await sleep(1000);

    const restartAdmin = await login('admin', 'admin123');
    const afterRestart = await api('/api/borrowings', { cookie: restartAdmin.cookie });
    assert(afterRestart.body.data.length === beforeCount,
      `重启后领用单数应=${beforeCount}, 实际=${afterRestart.body.data.length}`);

    const borrow1After = await api(`/api/borrowings/${BORROW_ID_1}`, { cookie: restartAdmin.cookie });
    assert(borrow1After.body.data.borrower_id === WH_ID,
      `重启后 borrower_id 应保持=${WH_ID}`);
    assert(borrow1After.body.data.borrower_name === WH_NAME,
      `重启后 borrower_name 应保持=${WH_NAME}`);
    console.log('   ✅ 重启后代建数据完整，领用人信息正确');

    // ========== 12. 不传 borrower_id 默认用自己 ==========
    console.log('\n[12] 不传 borrower_id 时默认用当前用户');

    const adminSession6 = await login('admin', 'admin123');

    // 再入库一个样本
    const defBarcode = `${BATCH_NO}-S10`;
    const defSample = await api('/api/samples', {
      method: 'POST', cookie: adminSession6.cookie,
      body: { barcode: defBarcode, batch_no: BATCH_NO, name: '默认领用人测试样本', required_zone_id: 1 }
    });
    await api('/api/samples/batch/inbound', {
      method: 'POST', cookie: adminSession6.cookie,
      body: { items: [{ sample_id: defSample.body.data.id, location_id: LOC_ID_1 }] }
    });

    const defaultCreate = await api('/api/borrowings', {
      method: 'POST', cookie: adminSession6.cookie,
      body: {
        sample_barcode: defBarcode,
        expected_return_date: futureDate,
        purpose: '默认领用人测试'
      }
    });
    assert(defaultCreate.body.success, '不传borrower_id应创建成功');
    const DEF_BORROW_ID = defaultCreate.body.data.id;

    const defDetail = await api(`/api/borrowings/${DEF_BORROW_ID}`, { cookie: adminSession6.cookie });
    assert(defDetail.body.data.borrower_id === ADMIN_ID,
      `不传 borrower_id 时应用当前用户 id，应为${ADMIN_ID}，实际=${defDetail.body.data.borrower_id}`);
    console.log('   ✅ 不传 borrower_id 时，默认用当前用户');

    // ========== 验收结论 ==========
    console.log('\n========== 验收结论 ==========');
    console.log('✅ 管理员可通过 borrower_id 指定领用人');
    console.log('✅ 指定领用人时校验用户存在，无效 ID 报错');
    console.log('✅ 普通用户传 borrower_id 被忽略，强制用自己');
    console.log('✅ 不传 borrower_id 时默认用当前用户');
    console.log('✅ 代建领用单 borrower_id/borrower_name 写入正确');
    console.log('✅ 权限隔离：普通用户只能看自己的，管理员能看全部');
    console.log('✅ 代建领用单完整链路：借出→归还→样本状态联动→库位恢复');
    console.log('✅ 代建领用单逾期检测正常');
    console.log('✅ 审计日志中领用人信息正确');
    console.log('✅ 重启后数据不丢失');
    console.log('\n🎉 指定领用人功能 专项验收通过！');

  } catch (e) {
    console.error('\n❌ 验收失败:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await stopServer();
  }
}

main();
