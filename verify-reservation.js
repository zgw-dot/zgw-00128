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
    console.log('========== 样本预约模块 验收 ==========\n');

    clearDatabase();
    await startServer();
    await sleep(300);

    // ========== 1. admin 登录 ==========
    console.log('[1] admin 登录');
    const login = await api('/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin123' }
    });
    if (!login.body || !login.body.success) throw new Error('登录失败: ' + JSON.stringify(login.body));
    const ADMIN_COOKIE = login.setCookie;
    console.log('   ✅ admin 登录成功');

    // 选库位
    const locs = await api('/api/locations', { cookie: ADMIN_COOKIE });
    const cooledLocs = (locs.body.data || []).filter(l => l.zone_id === 1);
    const LOC_ID_1 = cooledLocs[0].id;
    console.log(`   选库位: ${cooledLocs[0].code}(ID=${LOC_ID_1})`);

    const TS = Date.now().toString(36);
    const BATCH_NO = 'RSV-TEST-' + TS;

    // ========== 2. 登记并入库 6 个样本 ==========
    console.log('\n[2] 登记并入库 6 个样本，批次=' + BATCH_NO);
    const itemNames = ['样本A', '样本B', '样本C', '样本D', '样本E', '样本F'];
    const sampleIds = [];

    for (let i = 0; i < itemNames.length; i++) {
      const r = await api('/api/samples', {
        method: 'POST', cookie: ADMIN_COOKIE,
        body: {
          barcode: `${BATCH_NO}-S${i + 1}`,
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
      body: { items: inboundItems, remark: '预约测试-入库' }
    });
    if (!ib.body.success) throw new Error('批量入库失败: ' + ib.body.error);
    assert(ib.body.data.success === 6, `应入库6条, 实际=${ib.body.data.success}`);
    console.log('   ✅ 6 条样本已入库');

    // ========== 3. 创建预约单（草稿） ==========
    console.log('\n[3] 创建预约单（草稿状态）');
    const now = new Date();
    const startTime = new Date(now.getTime() + 3600000).toISOString().replace('T', ' ').substring(0, 19);
    const endTime = new Date(now.getTime() + 7200000).toISOString().replace('T', ' ').substring(0, 19);

    const createRes = await api('/api/reservations', {
      method: 'POST', cookie: ADMIN_COOKIE,
      body: {
        batch_no: BATCH_NO,
        quantity: 3,
        start_time: startTime,
        end_time: endTime,
        remark: '验收测试-创建预约'
      }
    });
    if (!createRes.body.success) throw new Error('创建预约失败: ' + createRes.body.error);
    const RESERVATION_ID_1 = createRes.body.data.id;
    const RESERVATION_NO_1 = createRes.body.data.reservation_no;
    console.log(`   ✅ 预约单创建成功: ${RESERVATION_NO_1}(ID=${RESERVATION_ID_1})`);

    // ========== 4. 查询预约单列表 ==========
    console.log('\n[4] 查询预约单列表');
    const listRes = await api('/api/reservations', { cookie: ADMIN_COOKIE });
    assert(listRes.body.success, '查询预约列表失败');
    assert(listRes.body.data.length === 1, `应返回1条预约, 实际=${listRes.body.data.length}`);
    assert(listRes.body.data[0].status === 'draft', '状态应为draft');
    assert(listRes.body.data[0].status_label === '草稿', '状态标签应为"草稿"');
    assert(listRes.body.data[0].batch_no === BATCH_NO, '批次号不匹配');
    assert(listRes.body.data[0].quantity === 3, '数量应为3');
    assert(listRes.body.data[0].available_stock === 6, '在库数应为6');
    console.log('   ✅ 预约单列表查询正确（状态=草稿，在库=6）');

    // ========== 5. 查询预约单详情 ==========
    console.log('\n[5] 查询预约单详情');
    const detailRes = await api(`/api/reservations/${RESERVATION_ID_1}`, { cookie: ADMIN_COOKIE });
    assert(detailRes.body.success, '查询预约详情失败');
    assert(detailRes.body.data.reservation_no === RESERVATION_NO_1, '预约单号不匹配');
    assert(detailRes.body.data.available_stock === 6, '在库数应为6');
    console.log('   ✅ 预约单详情正确（在库=6）');

    // ========== 6. 同批次同时段冲突检测 ==========
    console.log('\n[6] 同批次同时段冲突检测');
    const conflictCreate = await api('/api/reservations', {
      method: 'POST', cookie: ADMIN_COOKIE,
      body: {
        batch_no: BATCH_NO,
        quantity: 2,
        start_time: startTime,
        end_time: endTime,
        remark: '冲突预约'
      }
    });
    assert(!conflictCreate.body.success, '相同时段应拒绝创建');
    assert(conflictCreate.body.conflicts && conflictCreate.body.conflicts.length > 0, '应返回冲突列表');
    console.log('   ✅ 相同时段创建被拒绝，返回冲突预约');

    // 部分重叠也冲突
    const overlapStart = new Date(now.getTime() + 5400000).toISOString().replace('T', ' ').substring(0, 19);
    const overlapEnd = new Date(now.getTime() + 9000000).toISOString().replace('T', ' ').substring(0, 19);
    const overlapCreate = await api('/api/reservations', {
      method: 'POST', cookie: ADMIN_COOKIE,
      body: {
        batch_no: BATCH_NO,
        quantity: 1,
        start_time: overlapStart,
        end_time: overlapEnd,
        remark: '部分重叠'
      }
    });
    assert(!overlapCreate.body.success, '部分重叠时段应拒绝');
    console.log('   ✅ 部分重叠时段创建被拒绝');

    // 不重叠时段可以创建
    const freeStart = new Date(now.getTime() + 86400000).toISOString().replace('T', ' ').substring(0, 19);
    const freeEnd = new Date(now.getTime() + 90000000).toISOString().replace('T', ' ').substring(0, 19);
    const freeCreate = await api('/api/reservations', {
      method: 'POST', cookie: ADMIN_COOKIE,
      body: {
        batch_no: BATCH_NO,
        quantity: 2,
        start_time: freeStart,
        end_time: freeEnd,
        remark: '不重叠预约'
      }
    });
    assert(freeCreate.body.success, '不重叠时段应允许创建: ' + (freeCreate.body.error || ''));
    const RESERVATION_ID_2 = freeCreate.body.data.id;
    console.log('   ✅ 不重叠时段创建成功');

    // ========== 7. 冲突检测接口 ==========
    console.log('\n[7] 冲突检测接口');
    const conflictApi = await api(`/api/reservations/conflicts?batch_no=${encodeURIComponent(BATCH_NO)}&start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`, { cookie: ADMIN_COOKIE });
    assert(conflictApi.body.success, '冲突检测接口失败');
    assert(conflictApi.body.data.length >= 1, '应返回至少1条冲突预约');
    console.log(`   ✅ 冲突检测返回 ${conflictApi.body.data.length} 条冲突预约`);

    // ========== 8. 确认预约（校验在库数量） ==========
    console.log('\n[8] 确认预约');
    const confirmRes = await api(`/api/reservations/${RESERVATION_ID_1}/confirm`, {
      method: 'PUT', cookie: ADMIN_COOKIE,
      body: { remark: '验收测试-确认' }
    });
    if (!confirmRes.body.success) throw new Error('确认预约失败: ' + confirmRes.body.error);
    console.log('   ✅ 预约确认成功');

    // 验证状态
    const confirmedDetail = await api(`/api/reservations/${RESERVATION_ID_1}`, { cookie: ADMIN_COOKIE });
    assert(confirmedDetail.body.data.status === 'confirmed', '确认后状态应为confirmed');
    assert(confirmedDetail.body.data.confirmed_at, '确认时间不应为空');
    console.log('   ✅ 确认后状态=已确认，确认时间已记录');

    // ========== 9. 使用预约（联动样本状态） ==========
    console.log('\n[9] 使用预约（联动样本状态）');
    const useRes = await api(`/api/reservations/${RESERVATION_ID_1}/use`, {
      method: 'PUT', cookie: ADMIN_COOKIE,
      body: { remark: '验收测试-使用' }
    });
    if (!useRes.body.success) throw new Error('使用预约失败: ' + useRes.body.error);
    assert(useRes.body.data.used_count === 3, `应使用3条样本, 实际=${useRes.body.data.used_count}`);
    console.log('   ✅ 预约使用成功，标记 3 条样本为已预约出库');

    // 验证样本状态
    const samplesAfter = await api(`/api/samples?batch_no=${encodeURIComponent(BATCH_NO)}`, { cookie: ADMIN_COOKIE });
    const reservedOutboundSamples = samplesAfter.body.data.filter(s => s.status === 'reserved_outbound');
    const inStorageSamples = samplesAfter.body.data.filter(s => s.status === 'in_storage');
    assert(reservedOutboundSamples.length === 3, `应有3条已预约出库样本, 实际=${reservedOutboundSamples.length}`);
    assert(inStorageSamples.length === 3, `应剩3条在库样本, 实际=${inStorageSamples.length}`);
    console.log(`   ✅ 样本状态联动正确：3条已预约出库，3条在库`);

    // 验证预约单状态
    const usedDetail = await api(`/api/reservations/${RESERVATION_ID_1}`, { cookie: ADMIN_COOKIE });
    assert(usedDetail.body.data.status === 'used', '使用后状态应为used');
    assert(usedDetail.body.data.used_at, '使用时间不应为空');
    console.log('   ✅ 使用后状态=已使用，使用时间已记录');

    // ========== 10. 取消预约 ==========
    console.log('\n[10] 取消预约（第二个预约单）');
    const cancelRes = await api(`/api/reservations/${RESERVATION_ID_2}/cancel`, {
      method: 'PUT', cookie: ADMIN_COOKIE,
      body: { remark: '验收测试-取消' }
    });
    if (!cancelRes.body.success) throw new Error('取消预约失败: ' + cancelRes.body.error);
    console.log('   ✅ 预约取消成功');

    const cancelledDetail = await api(`/api/reservations/${RESERVATION_ID_2}`, { cookie: ADMIN_COOKIE });
    assert(cancelledDetail.body.data.status === 'cancelled', '取消后状态应为cancelled');
    assert(cancelledDetail.body.data.cancelled_at, '取消时间不应为空');
    console.log('   ✅ 取消后状态=已取消，取消时间已记录');

    // ========== 11. 生命周期校验：已使用不能再次操作 ==========
    console.log('\n[11] 生命周期校验：已使用不能再次确认/使用/取消');
    const reconfirm = await api(`/api/reservations/${RESERVATION_ID_1}/confirm`, {
      method: 'PUT', cookie: ADMIN_COOKIE
    });
    assert(!reconfirm.body.success, '已使用的预约不应能再次确认');
    console.log('   ✅ 已使用预约再次确认被拒绝');

    const reuse = await api(`/api/reservations/${RESERVATION_ID_1}/use`, {
      method: 'PUT', cookie: ADMIN_COOKIE
    });
    assert(!reuse.body.success, '已使用的预约不应能再次使用');
    console.log('   ✅ 已使用预约再次使用被拒绝');

    const recancel = await api(`/api/reservations/${RESERVATION_ID_1}/cancel`, {
      method: 'PUT', cookie: ADMIN_COOKIE
    });
    assert(!recancel.body.success, '已使用的预约不应能取消');
    console.log('   ✅ 已使用预约取消被拒绝');

    // ========== 12. 普通用户权限：只能看自己的预约 ==========
    console.log('\n[12] 普通用户权限验证');

    // 先创建一个 warehouse 用户登录的预约
    const whLogin = await api('/api/auth/login', {
      method: 'POST', body: { username: 'warehouse', password: 'wh123' }
    });
    if (!whLogin.body || !whLogin.body.success) throw new Error('warehouse 登录失败');
    const WH_COOKIE = whLogin.setCookie;
    console.log('   warehouse 登录成功');

    // warehouse 创建预约
    const whResStart = new Date(now.getTime() + 172800000).toISOString().replace('T', ' ').substring(0, 19);
    const whResEnd = new Date(now.getTime() + 176400000).toISOString().replace('T', ' ').substring(0, 19);
    const whCreateRes = await api('/api/reservations', {
      method: 'POST', cookie: WH_COOKIE,
      body: {
        batch_no: BATCH_NO,
        quantity: 1,
        start_time: whResStart,
        end_time: whResEnd,
        remark: '库管员预约'
      }
    });
    assert(whCreateRes.body.success, 'warehouse 创建预约失败: ' + (whCreateRes.body.error || ''));
    const WH_RES_ID = whCreateRes.body.data.id;
    console.log('   ✅ warehouse 创建预约成功');

    // warehouse 查看列表：只能看到自己的
    const whList = await api('/api/reservations', { cookie: WH_COOKIE });
    assert(whList.body.success, 'warehouse 查询列表失败');
    const whOwnReservations = whList.body.data.filter(r => r.reserver_id !== whLogin.body.data.id);
    assert(whOwnReservations.length === 0, `warehouse 不应看到别人的预约, 实际看到${whOwnReservations.length}条`);
    console.log(`   ✅ warehouse 只能看到自己的预约（${whList.body.data.length}条）`);

    // warehouse 不能看别人的预约详情
    const whOtherDetail = await api(`/api/reservations/${RESERVATION_ID_1}`, { cookie: WH_COOKIE });
    assert(!whOtherDetail.body.success, 'warehouse 不应看到admin的预约详情');
    assert(whOtherDetail.body.error && whOtherDetail.body.error.includes('无权'), '应返回无权提示');
    console.log('   ✅ warehouse 无权查看别人的预约详情');

    // 重新以 admin 登录，验证admin能看到全部预约
    const adminRelogin = await api('/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin123' }
    });
    if (!adminRelogin.body || !adminRelogin.body.success) throw new Error('admin 重新登录失败');
    const ADMIN_COOKIE2 = adminRelogin.setCookie;

    const adminList = await api('/api/reservations', { cookie: ADMIN_COOKIE2 });
    assert(adminList.body.data.length >= 3, `admin 应能看到全部预约, 实际=${adminList.body.data.length}`);
    console.log(`   ✅ admin 能看到全部预约（${adminList.body.data.length}条）`);

    // 后续步骤用 admin 身份
    const ADMIN_CURR = ADMIN_COOKIE2;

    // ========== 13. 确认预约时在库数量不足 ==========
    console.log('\n[13] 确认预约时在库数量不足校验');

    // 当前只剩 3 条在库，创建一个预约 5 条的
    const shortStart = new Date(now.getTime() + 259200000).toISOString().replace('T', ' ').substring(0, 19);
    const shortEnd = new Date(now.getTime() + 262800000).toISOString().replace('T', ' ').substring(0, 19);
    const shortCreate = await api('/api/reservations', {
      method: 'POST', cookie: ADMIN_CURR,
      body: {
        batch_no: BATCH_NO,
        quantity: 5,
        start_time: shortStart,
        end_time: shortEnd,
        remark: '数量不足测试'
      }
    });
    assert(shortCreate.body.success, '创建预约应成功（草稿不校验数量）');
    const SHORT_RES_ID = shortCreate.body.data.id;
    console.log('   ✅ 草稿预约创建成功（不校验数量）');

    // 确认时校验在库数量
    const shortConfirm = await api(`/api/reservations/${SHORT_RES_ID}/confirm`, {
      method: 'PUT', cookie: ADMIN_CURR
    });
    assert(!shortConfirm.body.success, '在库数量不足时应拒绝确认');
    assert(shortConfirm.body.error && shortConfirm.body.error.includes('在库数量不足'), '应提示在库数量不足');
    assert(shortConfirm.body.available_stock === 3, '在库数应为3');
    assert(shortConfirm.body.required_quantity === 5, '预约数应为5');
    console.log('   ✅ 在库数量不足时确认被拒绝（在库=3，需要=5）');

    // ========== 14. 过期自动取消 ==========
    console.log('\n[14] 过期自动取消');
    // 创建一个已过期的预约
    const pastStart = new Date(now.getTime() - 7200000).toISOString().replace('T', ' ').substring(0, 19);
    const pastEnd = new Date(now.getTime() - 3600000).toISOString().replace('T', ' ').substring(0, 19);
    const pastCreate = await api('/api/reservations', {
      method: 'POST', cookie: ADMIN_CURR,
      body: {
        batch_no: BATCH_NO,
        quantity: 1,
        start_time: pastStart,
        end_time: pastEnd,
        remark: '已过期预约'
      }
    });
    assert(pastCreate.body.success, '创建过期时段预约应成功（创建时不检查是否过期）');
    const PAST_RES_ID = pastCreate.body.data.id;
    console.log('   ✅ 已过期时段预约创建成功');

    // 确认时应检测过期
    const pastConfirm = await api(`/api/reservations/${PAST_RES_ID}/confirm`, {
      method: 'PUT', cookie: ADMIN_CURR
    });
    assert(!pastConfirm.body.success, '过期预约不应能确认');
    assert(pastConfirm.body.error && pastConfirm.body.error.includes('过期'), '应提示已过期');
    console.log('   ✅ 过期预约确认被拒绝');

    // 查询列表时触发自动过期
    const listAfterExpire = await api('/api/reservations', { cookie: ADMIN_CURR });
    const expiredRes = listAfterExpire.body.data.find(r => r.id === PAST_RES_ID);
    assert(expiredRes && expiredRes.status === 'expired', '过期预约应被自动标记为expired');
    console.log('   ✅ 查询列表时过期预约自动标记为"已过期"');

    // ========== 15. 审计日志验证 ==========
    console.log('\n[15] 审计日志验证');
    const auditCreate = await api('/api/audit-log?action_type=reservation_create&page_size=50', { cookie: ADMIN_CURR });
    assert(auditCreate.body.success, '查询审计日志失败');
    assert(auditCreate.body.data.total >= 3, `应至少有3条创建预约审计日志, 实际=${auditCreate.body.data.total}`);
    console.log(`   ✅ 创建预约审计日志: ${auditCreate.body.data.total} 条`);

    const auditConfirm = await api('/api/audit-log?action_type=reservation_confirm&page_size=50', { cookie: ADMIN_CURR });
    assert(auditConfirm.body.data.total >= 1, '应至少有1条确认预约审计日志');
    console.log(`   ✅ 确认预约审计日志: ${auditConfirm.body.data.total} 条`);

    const auditUse = await api('/api/audit-log?action_type=reservation_use&page_size=50', { cookie: ADMIN_CURR });
    assert(auditUse.body.data.total >= 1, '应至少有1条使用预约审计日志');
    console.log(`   ✅ 使用预约审计日志: ${auditUse.body.data.total} 条`);

    const auditCancel = await api('/api/audit-log?action_type=reservation_cancel&page_size=50', { cookie: ADMIN_CURR });
    assert(auditCancel.body.data.total >= 1, '应至少有1条取消预约审计日志');
    console.log(`   ✅ 取消预约审计日志: ${auditCancel.body.data.total} 条`);

    const auditExpire = await api('/api/audit-log?action_type=reservation_expire&page_size=50', { cookie: ADMIN_CURR });
    assert(auditExpire.body.data.total >= 1, '应至少有1条过期预约审计日志');
    console.log(`   ✅ 过期预约审计日志: ${auditExpire.body.data.total} 条`);

    // 检查样本预约出库的审计日志
    const auditOutbound = await api('/api/audit-log?action_type=outbound&page_size=50', { cookie: ADMIN_CURR });
    const reservationOutboundLogs = auditOutbound.body.data.list.filter(l =>
      l.after_value_parsed && l.after_value_parsed.status === 'reserved_outbound'
    );
    assert(reservationOutboundLogs.length >= 3, `应至少有3条预约出库审计日志, 实际=${reservationOutboundLogs.length}`);
    console.log(`   ✅ 样本预约出库审计日志: ${reservationOutboundLogs.length} 条`);

    // ========== 16. 重启验证 ==========
    console.log('\n[16] 重启验证：预约数据持久化');

    const beforeRestartList = await api('/api/reservations', { cookie: ADMIN_CURR });
    const beforeCount = beforeRestartList.body.data.length;
    console.log(`   重启前预约单数: ${beforeCount}`);

    console.log('   正在重启服务器...');
    await stopServer();
    await sleep(2000);
    await startServer();
    await sleep(1000);

    // 重新登录
    const relogin = await api('/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin123' }
    });
    if (!relogin.body || !relogin.body.success) throw new Error('重启后登录失败');
    const COOKIE_AFTER = relogin.setCookie;
    console.log('   ✅ 重启后登录成功');

    const afterRestartList = await api('/api/reservations', { cookie: COOKIE_AFTER });
    assert(afterRestartList.body.data.length === beforeCount,
      `重启后预约数应=${beforeCount}, 实际=${afterRestartList.body.data.length}`);
    console.log(`   ✅ 重启后预约数据完整（${afterRestartList.body.data.length}条）`);

    // 验证已使用的预约单重启后状态依然正确
    const usedAfterRestart = await api(`/api/reservations/${RESERVATION_ID_1}`, { cookie: COOKIE_AFTER });
    assert(usedAfterRestart.body.data.status === 'used', '重启后已使用预约状态应保持');
    console.log('   ✅ 重启后已使用预约状态保持不变');

    // 验证样本状态重启后也保持
    const samplesAfterRestart = await api(`/api/samples?status=reserved_outbound`, { cookie: COOKIE_AFTER });
    assert(samplesAfterRestart.body.data.length === 3, `重启后应保持3条已预约出库样本, 实际=${samplesAfterRestart.body.data.length}`);
    console.log('   ✅ 重启后样本状态保持不变（3条已预约出库）');

    // ========== 17. 未登录访问验证 ==========
    console.log('\n[17] 未登录访问验证');
    await api('/api/auth/logout', { method: 'POST', cookie: COOKIE_AFTER });

    const noAuth1 = await api('/api/reservations', {});
    assert(noAuth1.body && noAuth1.body.needLogin, '未登录访问预约列表应被拒绝');
    console.log('   ✅ 未登录访问预约列表被拒绝');

    const noAuth2 = await api('/api/reservations', {
      method: 'POST', body: { batch_no: 'X', quantity: 1, start_time: '2026-01-01 00:00:00', end_time: '2026-01-02 00:00:00' }
    });
    assert(noAuth2.body && noAuth2.body.needLogin, '未登录创建预约应被拒绝');
    console.log('   ✅ 未登录创建预约被拒绝');

    const noAuth3 = await api('/api/reservations/conflicts?batch_no=X&start_time=2026-01-01&end_time=2026-01-02', {});
    assert(noAuth3.body && noAuth3.body.needLogin, '未登录冲突检测应被拒绝');
    console.log('   ✅ 未登录冲突检测被拒绝');

    // ========== 验收结论 ==========
    console.log('\n========== 验收结论 ==========');
    console.log('✅ POST /api/reservations: 创建预约单（草稿状态）');
    console.log('✅ 同批次同时段冲突检测：创建时拒绝，返回冲突列表');
    console.log('✅ GET /api/reservations/conflicts: 冲突检测接口');
    console.log('✅ GET /api/reservations: 预约列表查询（含在库数量）');
    console.log('✅ GET /api/reservations/:id: 预约详情查询');
    console.log('✅ PUT /api/reservations/:id/confirm: 确认预约（校验在库数量）');
    console.log('✅ PUT /api/reservations/:id/use: 使用预约（联动样本状态→已预约出库）');
    console.log('✅ PUT /api/reservations/:id/cancel: 取消预约');
    console.log('✅ 生命周期：草稿→已确认→已使用/已取消/已过期');
    console.log('✅ 过期预约自动取消');
    console.log('✅ 普通用户只能看自己的预约，管理员能看全部');
    console.log('✅ 审计日志：创建/确认/使用/取消/过期全流程可追踪');
    console.log('✅ 重启后数据不丢失');
    console.log('✅ 未登录访问被拒绝');
    console.log('\n🎉 样本预约模块 验收通过！');

  } catch (e) {
    console.error('\n❌ 验收失败:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await stopServer();
  }
}

main();
