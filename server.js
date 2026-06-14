const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const { initDatabase, queryAll, queryOne, run, runExec, runTransaction, runInTx, getLastInsertIdInTx, insertAuditLog, insertAuditLogInTx, getUserZoneIds } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const STATUS_LABELS = {
  pending: '待入库',
  in_storage: '在库',
  outbound: '已出库',
  scrapped: '已报废',
  reserved_outbound: '已预约出库',
  borrowed: '已借出',
  lost: '已丢失'
};

const ACTION_LABELS = {
  register: '登记',
  inbound: '入库',
  transfer: '转移',
  outbound: '出库',
  scrapped: '报废',
  temp_exception: '温控异常',
  reverse_transfer: '撤销转移',
  reverse_scrapped: '撤销报废',
  inventory_correction: '盘点纠错',
  reserved_outbound: '预约出库',
  borrow_out: '领用出库',
  borrow_return: '领用归还'
};

const RESERVATION_STATUS_LABELS = {
  draft: '草稿',
  confirmed: '已确认',
  used: '已使用',
  cancelled: '已取消',
  expired: '已过期'
};

const BORROWING_STATUS_LABELS = {
  draft: '草稿',
  borrowed: '已借出',
  returned: '已归还',
  overdue: '逾期'
};

const INVENTORY_STATUS_LABELS = {
  draft: '草稿',
  processing: '处理中',
  completed: '已完成',
  cancelled: '已取消'
};

const DISCREPANCY_TYPE_LABELS = {
  extra: '多扫（台账无此样本）',
  missing: '漏扫（台账有但未扫到）',
  mislocated: '库位不一致',
  outbound_scanned: '已出库样本被扫到',
  not_in_target: '不在盘点范围内'
};

const DISCREPANCY_STATUS_LABELS = {
  pending: '待处理',
  processing: '处理中',
  resolved: '已解决',
  ignored: '已忽略'
};

const ROLE_LABELS = {
  admin: '管理员',
  warehouse: '库管员',
  viewer: '只读用户'
};

const AUDIT_ACTION_LABELS = {
  login: '登录',
  logout: '登出',
  inbound: '入库',
  transfer: '转移',
  outbound: '出库',
  scrap: '报废',
  inventory_import: '盘点导入',
  batch_import: '批量导入',
  correction: '纠错',
  reverse: '撤销',
  threshold_setting: '阈值设置',
  batch_transition: '批量状态变更',
  reservation_create: '创建预约',
  reservation_confirm: '确认预约',
  reservation_use: '使用预约',
  reservation_cancel: '取消预约',
  reservation_expire: '预约过期',
  borrowing_create: '创建领用',
  borrowing_borrow: '确认借出',
  borrowing_return: '归还样本',
  borrowing_overdue: '领用逾期'
};

const AUDIT_OBJECT_LABELS = {
  sample: '样本',
  inventory_order: '盘点单',
  discrepancy: '差异记录',
  timeline: '操作记录',
  user: '用户',
  sample_import_batch: '导入批次',
  inventory_config: '库存配置',
  item_threshold: '物品阈值',
  sample_reservation: '样本预约',
  sample_borrowing: '样本领用'
};

let currentUser = null;

const batchTransitionLocks = new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const realIp = req.headers['x-real-ip'];
  if (realIp) return realIp;
  const ip = req.connection.remoteAddress || req.socket.remoteAddress ||
    (req.connection.socket ? req.connection.socket.remoteAddress : null);
  if (ip && ip.startsWith('::ffff:')) return ip.substring(7);
  if (ip === '::1') return '127.0.0.1';
  return ip || 'unknown';
}

function addAuditLog(req, actionType, objectType, objectId, beforeValue, afterValue, remark) {
  const ip = getClientIp(req);
  const opId = currentUser ? currentUser.id : null;
  const opName = currentUser ? (currentUser.real_name || currentUser.username) : null;
  try {
    insertAuditLog({
      operator_id: opId,
      operator_name: opName,
      ip_address: ip,
      action_type: actionType,
      object_type: objectType,
      object_id: objectId,
      before_value: beforeValue,
      after_value: afterValue,
      remark: remark
    });
  } catch (e) {
    console.error('写入审计日志失败:', e.message);
  }
}

function addAuditLogInTx(req, actionType, objectType, objectId, beforeValue, afterValue, remark) {
  const ip = getClientIp(req);
  const opId = currentUser ? currentUser.id : null;
  const opName = currentUser ? (currentUser.real_name || currentUser.username) : null;
  insertAuditLogInTx({
    operator_id: opId,
    operator_name: opName,
    ip_address: ip,
    action_type: actionType,
    object_type: objectType,
    object_id: objectId,
    before_value: beforeValue,
    after_value: afterValue,
    remark: remark
  });
}

function getLocationOccupancy(locationId) {
  const row = queryOne(
    'SELECT COUNT(*) as cnt FROM samples WHERE current_location_id = ? AND status = ?',
    [locationId, 'in_storage']
  );
  return row ? row.cnt : 0;
}

function getLocationWithZone(locationId) {
  return queryOne(`
    SELECT sl.*, tz.name as zone_name, tz.min_temp, tz.max_temp
    FROM storage_locations sl
    LEFT JOIN temperature_zones tz ON sl.zone_id = tz.id
    WHERE sl.id = ?
  `, [locationId]);
}

function getSampleWithDetails(sampleId) {
  return queryOne(`
    SELECT s.*,
      sl.code as location_code, sl.name as location_name,
      tz.name as zone_name,
      rz.name as required_zone_name
    FROM samples s
    LEFT JOIN storage_locations sl ON s.current_location_id = sl.id
    LEFT JOIN temperature_zones tz ON sl.zone_id = tz.id
    LEFT JOIN temperature_zones rz ON s.required_zone_id = rz.id
    WHERE s.id = ?
  `, [sampleId]);
}

function getSampleByBarcode(barcode) {
  return queryOne(`
    SELECT s.*,
      sl.code as location_code, sl.name as location_name,
      tz.name as zone_name,
      rz.name as required_zone_name
    FROM samples s
    LEFT JOIN storage_locations sl ON s.current_location_id = sl.id
    LEFT JOIN temperature_zones tz ON sl.zone_id = tz.id
    LEFT JOIN temperature_zones rz ON s.required_zone_id = rz.id
    WHERE s.barcode = ?
  `, [barcode]);
}

function getSampleTimeline(sampleId) {
  return queryAll(`
    SELECT st.*,
      sl_from.code as from_code, sl_from.name as from_name,
      sl_to.code as to_code, sl_to.name as to_name
    FROM sample_timeline st
    LEFT JOIN storage_locations sl_from ON st.from_location_id = sl_from.id
    LEFT JOIN storage_locations sl_to ON st.to_location_id = sl_to.id
    WHERE st.sample_id = ?
    ORDER BY st.created_at ASC, st.id ASC
  `, [sampleId]);
}

function addTimeline(sampleId, actionType, fromLocation, toLocation, temperature, remark, operator) {
  return run(`
    INSERT INTO sample_timeline
    (sample_id, action_type, from_location_id, to_location_id, temperature, remark, operator)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [sampleId, actionType, fromLocation, toLocation, temperature, remark, operator]);
}

function addTimelineInTx(sampleId, actionType, fromLocation, toLocation, temperature, remark, operator) {
  return runInTx(`
    INSERT INTO sample_timeline
    (sample_id, action_type, from_location_id, to_location_id, temperature, remark, operator)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [sampleId, actionType, fromLocation, toLocation, temperature, remark, operator]);
}

function requireAuth(req, res, next) {
  if (!currentUser) {
    return res.json({ success: false, error: '请先登录', needLogin: true });
  }
  req.user = currentUser;
  next();
}

function requireAdmin(req, res, next) {
  if (!currentUser) {
    return res.json({ success: false, error: '请先登录', needLogin: true });
  }
  if (currentUser.role !== 'admin') {
    return res.json({ success: false, error: '需要管理员权限', forbidden: true });
  }
  req.user = currentUser;
  next();
}

function requireWrite(req, res, next) {
  if (!currentUser) {
    return res.json({ success: false, error: '请先登录', needLogin: true });
  }
  if (currentUser.role === 'viewer') {
    return res.json({ success: false, error: '只读用户无写入权限', forbidden: true });
  }
  req.user = currentUser;
  next();
}

function getAccessibleZoneIds() {
  if (!currentUser) return [];
  if (currentUser.role === 'admin') return null; // null 表示全部可访问
  return getUserZoneIds(currentUser.id);
}

function canAccessZone(zoneId) {
  if (!currentUser) return false;
  if (currentUser.role === 'admin') return true;
  if (zoneId == null) return false;
  const allowed = getUserZoneIds(currentUser.id);
  return allowed.includes(parseInt(zoneId));
}

function canAccessLocation(locationId) {
  if (!currentUser) return false;
  if (currentUser.role === 'admin') return true;
  if (!locationId) return false;
  const loc = queryOne('SELECT zone_id FROM storage_locations WHERE id = ?', [locationId]);
  if (!loc) return false;
  return canAccessZone(loc.zone_id);
}

function canAccessSample(sampleId) {
  if (!currentUser) return false;
  if (currentUser.role === 'admin') return true;
  if (!sampleId) return false;
  const sample = queryOne('SELECT current_location_id, required_zone_id, status FROM samples WHERE id = ?', [sampleId]);
  if (!sample) return false;
  if (sample.current_location_id) {
    return canAccessLocation(sample.current_location_id);
  }
  if (sample.required_zone_id) {
    return canAccessZone(sample.required_zone_id);
  }
  return false;
}

function generateOrderNo() {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `PD${dateStr}${random}`;
}

function parseInventoryCSV(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length === 0) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const barcodeIdx = headers.findIndex(h => h.includes('条码') || h.includes('barcode'));
  const locationIdx = headers.findIndex(h => h.includes('库位') || h.includes('location') || h.includes('位置'));
  const timeIdx = headers.findIndex(h => h.includes('时间') || h.includes('time') || h.includes('scan'));

  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    if (cols.length === 0 || !cols[0]) continue;

    const item = {
      barcode: barcodeIdx >= 0 ? cols[barcodeIdx] : cols[0],
      scanned_location_code: locationIdx >= 0 ? cols[locationIdx] : '',
      scan_time: timeIdx >= 0 ? cols[timeIdx] : ''
    };
    if (item.barcode) {
      results.push(item);
    }
  }
  return results;
}

function getExpectedSamplesForInventory(order) {
  let sql = `
    SELECT s.id, s.barcode, s.status, s.current_location_id, sl.code as location_code
    FROM samples s
    LEFT JOIN storage_locations sl ON s.current_location_id = sl.id
    WHERE s.status = 'in_storage'
  `;
  const params = [];

  if (order.type === 'zone' && order.zone_id) {
    sql += ' AND EXISTS (SELECT 1 FROM storage_locations sl2 WHERE sl2.id = s.current_location_id AND sl2.zone_id = ?)';
    params.push(order.zone_id);
  } else if (order.type === 'location' && order.location_id) {
    sql += ' AND s.current_location_id = ?';
    params.push(order.location_id);
  }

  return queryAll(sql, params);
}

function performInventoryMatch(orderId) {
  const order = queryOne('SELECT * FROM inventory_orders WHERE id = ?', [orderId]);
  if (!order) return null;

  const scannedItems = queryAll('SELECT * FROM inventory_items WHERE inventory_order_id = ?', [orderId]);
  const expectedSamples = getExpectedSamplesForInventory(order);

  const scannedBarcodes = new Set(scannedItems.map(i => i.barcode));
  const expectedBarcodes = new Set(expectedSamples.map(s => s.barcode));
  const sampleMap = {};
  expectedSamples.forEach(s => { sampleMap[s.barcode] = s; });

  let matched = 0, extra = 0, missing = 0, mislocated = 0, outboundScanned = 0;

  runTransaction(() => {
    runInTx('DELETE FROM inventory_discrepancies WHERE inventory_order_id = ?', [orderId]);

    scannedItems.forEach(item => {
      const sample = sampleMap[item.barcode];
      if (!sample) {
        const existingSample = queryOne('SELECT * FROM samples WHERE barcode = ?', [item.barcode]);
        if (existingSample) {
          if (existingSample.status === 'outbound') {
            runInTx(`
              UPDATE inventory_items SET match_status = 'mismatch', discrepancy_type = 'outbound_scanned',
              discrepancy_note = ?, sample_id = ?
              WHERE id = ?
            `, ['已出库样本被扫到', existingSample.id, item.id]);
            runInTx(`
              INSERT INTO inventory_discrepancies
              (inventory_order_id, inventory_item_id, sample_id, barcode, type, description,
               old_status, old_location_id, status)
              VALUES (?, ?, ?, ?, 'outbound_scanned', ?, ?, ?, 'pending')
            `, [orderId, item.id, existingSample.id, item.barcode,
                `已出库样本被扫到，当前状态：${STATUS_LABELS[existingSample.status] || existingSample.status}`,
                existingSample.status, existingSample.current_location_id]);
            outboundScanned++;
          } else if (!expectedBarcodes.has(item.barcode)) {
            runInTx(`
              UPDATE inventory_items SET match_status = 'mismatch', discrepancy_type = 'not_in_target',
              discrepancy_note = ?, sample_id = ?
              WHERE id = ?
            `, ['样本不在盘点范围内', existingSample.id, item.id]);
            runInTx(`
              INSERT INTO inventory_discrepancies
              (inventory_order_id, inventory_item_id, sample_id, barcode, type, description,
               old_status, old_location_id, status)
              VALUES (?, ?, ?, ?, 'not_in_target', ?, ?, ?, 'pending')
            `, [orderId, item.id, existingSample.id, item.barcode,
                '样本不在本次盘点的温区/库位范围内',
                existingSample.status, existingSample.current_location_id]);
            extra++;
          }
        } else {
          runInTx(`
            UPDATE inventory_items SET match_status = 'mismatch', discrepancy_type = 'extra',
            discrepancy_note = ? WHERE id = ?
          `, ['台账无此样本', item.id]);
          runInTx(`
            INSERT INTO inventory_discrepancies
            (inventory_order_id, inventory_item_id, barcode, type, description, status)
            VALUES (?, ?, ?, 'extra', ?, 'pending')
          `, [orderId, item.id, item.barcode, '多扫：台账中无此条码记录']);
          extra++;
        }
        return;
      }

      if (item.scanned_location_code && sample.location_code &&
          item.scanned_location_code !== sample.location_code) {
        runInTx(`
          UPDATE inventory_items SET match_status = 'mismatch', discrepancy_type = 'mislocated',
          discrepancy_note = ?, sample_id = ?, expected_location_id = ?, expected_location_code = ?
          WHERE id = ?
        `, [`库位不一致：期望${sample.location_code}，实际${item.scanned_location_code}`,
            sample.id, sample.current_location_id, sample.location_code, item.id]);
        runInTx(`
          INSERT INTO inventory_discrepancies
          (inventory_order_id, inventory_item_id, sample_id, barcode, type, description,
           old_status, old_location_id, new_location_id, status)
          VALUES (?, ?, ?, ?, 'mislocated', ?, ?, ?, (SELECT id FROM storage_locations WHERE code = ?), 'pending')
        `, [orderId, item.id, sample.id, item.barcode,
            `库位不一致：台账位置${sample.location_code}，扫码位置${item.scanned_location_code}`,
            sample.status, sample.current_location_id, item.scanned_location_code]);
        mislocated++;
      } else {
        runInTx(`
          UPDATE inventory_items SET match_status = 'matched', sample_id = ?,
          expected_location_id = ?, expected_location_code = ?
          WHERE id = ?
        `, [sample.id, sample.current_location_id, sample.location_code, item.id]);
        matched++;
      }
    });

    expectedSamples.forEach(sample => {
      if (!scannedBarcodes.has(sample.barcode)) {
        runInTx(`
          INSERT INTO inventory_items
          (inventory_order_id, barcode, sample_id, expected_location_id, expected_location_code,
           match_status, discrepancy_type, discrepancy_note)
          VALUES (?, ?, ?, ?, ?, 'mismatch', 'missing', ?)
        `, [orderId, sample.barcode, sample.id, sample.current_location_id, sample.location_code, '漏扫：台账有但未扫到']);
        const itemId = getLastInsertIdTx();
        runInTx(`
          INSERT INTO inventory_discrepancies
          (inventory_order_id, inventory_item_id, sample_id, barcode, type, description,
           old_status, old_location_id, status)
          VALUES (?, ?, ?, ?, 'missing', ?, ?, ?, 'pending')
        `, [orderId, itemId, sample.id, sample.barcode,
            '漏扫：台账中存在但扫码数据中未找到',
            sample.status, sample.current_location_id]);
        missing++;
      }
    });

    runInTx(`
      UPDATE inventory_orders SET
        status = 'processing',
        total_expected = ?,
        total_scanned = ?,
        total_matched = ?,
        total_extra = ?,
        total_missing = ?,
        total_mislocated = ?,
        total_outbound_scanned = ?,
        updated_at = datetime('now','localtime')
      WHERE id = ?
    `, [expectedSamples.length, scannedItems.length, matched, extra, missing, mislocated, outboundScanned, orderId]);
  });

  return queryOne('SELECT * FROM inventory_orders WHERE id = ?', [orderId]);
}

function getLastInsertIdTx() {
  return getLastInsertIdInTx();
}

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ success: false, error: '用户名和密码必填' });
  }
  const user = queryOne('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
  if (!user) {
    addAuditLog(req, 'login', 'user', username, null, null, '登录失败：用户名或密码错误');
    return res.json({ success: false, error: '用户名或密码错误' });
  }
  currentUser = {
    id: user.id,
    username: user.username,
    role: user.role,
    real_name: user.real_name,
    role_label: ROLE_LABELS[user.role] || user.role,
    zone_ids: getUserZoneIds(user.id)
  };
  addAuditLog(req, 'login', 'user', user.id,
    null,
    { id: user.id, username: user.username, role: user.role, real_name: user.real_name },
    '登录成功');
  res.json({ success: true, data: currentUser });
});

app.post('/api/auth/logout', (req, res) => {
  const userId = currentUser ? currentUser.id : null;
  const userName = currentUser ? (currentUser.real_name || currentUser.username) : null;
  const userData = currentUser ? { ...currentUser } : null;
  addAuditLog(req, 'logout', 'user', userId,
    userData,
    null,
    userName ? `${userName} 登出` : '登出');
  currentUser = null;
  res.json({ success: true });
});

app.get('/api/auth/current', (req, res) => {
  res.json({ success: true, data: currentUser });
});

app.get('/api/users', requireAdmin, (req, res) => {
  const users = queryAll('SELECT id, username, role, real_name, created_at, updated_at FROM users ORDER BY id');
  users.forEach(u => {
    u.role_label = ROLE_LABELS[u.role] || u.role;
  });
  res.json({ success: true, data: users });
});

app.get('/api/zones', (req, res) => {
  const accessibleZones = getAccessibleZoneIds();
  let zones = queryAll('SELECT * FROM temperature_zones ORDER BY id');
  if (accessibleZones !== null) {
    zones = zones.filter(z => accessibleZones.includes(z.id));
  }
  res.json({ success: true, data: zones });
});

app.post('/api/zones', (req, res) => {
  const { name, min_temp, max_temp, description } = req.body;
  if (!name || min_temp === undefined || max_temp === undefined) {
    return res.json({ success: false, error: '温区名称和温度范围必填' });
  }
  try {
    const info = run(`
      INSERT INTO temperature_zones (name, min_temp, max_temp, description)
      VALUES (?, ?, ?, ?)
    `, [name, min_temp, max_temp, description || '']);
    res.json({ success: true, data: { id: info.lastInsertRowid } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.put('/api/zones/:id', (req, res) => {
  const { id } = req.params;
  const { name, min_temp, max_temp, description } = req.body;
  try {
    run(`
      UPDATE temperature_zones SET name=?, min_temp=?, max_temp=?, description=?,
      updated_at=datetime('now','localtime') WHERE id=?
    `, [name, min_temp, max_temp, description || '', id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.delete('/api/zones/:id', (req, res) => {
  const { id } = req.params;
  const inUse = queryOne('SELECT COUNT(*) as cnt FROM storage_locations WHERE zone_id=?', [id]).cnt;
  if (inUse > 0) {
    return res.json({ success: false, error: '该温区下还有库位，无法删除' });
  }
  run('DELETE FROM temperature_zones WHERE id=?', [id]);
  res.json({ success: true });
});

app.get('/api/locations', (req, res) => {
  const accessibleZones = getAccessibleZoneIds();
  let sql = `
    SELECT sl.*, tz.name as zone_name, tz.min_temp, tz.max_temp
    FROM storage_locations sl
    LEFT JOIN temperature_zones tz ON sl.zone_id = tz.id
    WHERE 1=1
  `;
  const params = [];
  if (accessibleZones !== null) {
    if (accessibleZones.length === 0) {
      return res.json({ success: true, data: [] });
    }
    sql += ' AND sl.zone_id IN (' + accessibleZones.map(() => '?').join(',') + ')';
    params.push(...accessibleZones);
  }
  sql += ' ORDER BY sl.code';
  const locations = queryAll(sql, params);
  locations.forEach(loc => {
    loc.occupancy = getLocationOccupancy(loc.id);
  });
  res.json({ success: true, data: locations });
});

app.post('/api/locations', (req, res) => {
  const { code, name, zone_id, capacity, description } = req.body;
  if (!code || !name || !zone_id) {
    return res.json({ success: false, error: '库位编码、名称、所属温区必填' });
  }
  try {
    const info = run(`
      INSERT INTO storage_locations (code, name, zone_id, capacity, description)
      VALUES (?, ?, ?, ?, ?)
    `, [code, name, zone_id, capacity || 10, description || '']);
    res.json({ success: true, data: { id: info.lastInsertRowid } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.put('/api/locations/:id', (req, res) => {
  const { id } = req.params;
  const { code, name, zone_id, capacity, description } = req.body;
  try {
    run(`
      UPDATE storage_locations SET code=?, name=?, zone_id=?, capacity=?, description=?,
      updated_at=datetime('now','localtime') WHERE id=?
    `, [code, name, zone_id, capacity, description || '', id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.delete('/api/locations/:id', (req, res) => {
  const { id } = req.params;
  const inUse = queryOne(
    'SELECT COUNT(*) as cnt FROM samples WHERE current_location_id=? AND status=?',
    [id, 'in_storage']
  ).cnt;
  if (inUse > 0) {
    return res.json({ success: false, error: '该库位还有样本在库，无法删除' });
  }
  run('DELETE FROM storage_locations WHERE id=?', [id]);
  res.json({ success: true });
});

app.get('/api/samples', (req, res) => {
  const { keyword, status } = req.query;
  let sql = `
    SELECT s.*,
      sl.code as location_code, sl.name as location_name,
      tz.name as zone_name,
      rz.name as required_zone_name
    FROM samples s
    LEFT JOIN storage_locations sl ON s.current_location_id = sl.id
    LEFT JOIN temperature_zones tz ON sl.zone_id = tz.id
    LEFT JOIN temperature_zones rz ON s.required_zone_id = rz.id
    WHERE 1=1
  `;
  const params = [];
  if (keyword) {
    sql += ' AND (s.barcode LIKE ? OR s.batch_no LIKE ? OR s.name LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (status && status !== 'all') {
    sql += ' AND s.status = ?';
    params.push(status);
  }
  const accessibleZones = getAccessibleZoneIds();
  if (accessibleZones !== null) {
    if (accessibleZones.length === 0) {
      return res.json({ success: true, data: [] });
    }
    sql += ' AND (s.required_zone_id IN (' + accessibleZones.map(() => '?').join(',') + ')' +
      ' OR EXISTS (SELECT 1 FROM storage_locations sl2 WHERE sl2.id = s.current_location_id AND sl2.zone_id IN (' + accessibleZones.map(() => '?').join(',') + ')))';
    params.push(...accessibleZones, ...accessibleZones);
  }
  sql += ' ORDER BY s.id DESC';
  const samples = queryAll(sql, params);

  samples.forEach(s => {
    s.status_label = STATUS_LABELS[s.status] || s.status;
    s.has_warning = false;
    s.warning_msg = '';
    if (s.status === 'in_storage' && s.required_zone_id && s.location_code) {
      const loc = getLocationWithZone(s.current_location_id);
      if (loc && loc.zone_id !== s.required_zone_id) {
        s.has_warning = true;
        s.warning_msg = `温区不匹配: 应放${s.required_zone_name}，当前${s.zone_name}`;
      }
    }
  });

  res.json({ success: true, data: samples });
});

app.get('/api/samples/barcode/:barcode', (req, res) => {
  const sample = getSampleByBarcode(req.params.barcode);
  if (!sample) {
    return res.json({ success: false, error: '样本不存在' });
  }
  sample.status_label = STATUS_LABELS[sample.status] || sample.status;
  sample.timeline = getSampleTimeline(sample.id);
  sample.timeline.forEach(t => {
    t.action_label = ACTION_LABELS[t.action_type] || t.action_type;
  });
  res.json({ success: true, data: sample });
});

app.get('/api/samples/:id', (req, res) => {
  const sample = getSampleWithDetails(req.params.id);
  if (!sample) {
    return res.json({ success: false, error: '样本不存在' });
  }
  sample.status_label = STATUS_LABELS[sample.status] || sample.status;
  sample.timeline = getSampleTimeline(sample.id);
  sample.timeline.forEach(t => {
    t.action_label = ACTION_LABELS[t.action_type] || t.action_type;
  });
  res.json({ success: true, data: sample });
});

app.post('/api/samples', requireWrite, (req, res) => {
  const { barcode, batch_no, name, required_zone_id, operator } = req.body;
  if (!barcode || !batch_no) {
    return res.json({ success: false, error: '条码和批次号必填' });
  }
  if (required_zone_id && !canAccessZone(required_zone_id)) {
    return res.json({ success: false, error: '无权操作该温区的样本', forbidden: true });
  }
  const existing = queryOne('SELECT id FROM samples WHERE barcode=?', [barcode]);
  if (existing) {
    return res.json({ success: false, error: '条码已存在，不能重复登记' });
  }
  try {
    const info = run(`
      INSERT INTO samples (barcode, batch_no, name, required_zone_id, status)
      VALUES (?, ?, ?, ?, 'pending')
    `, [barcode, batch_no, name || '', required_zone_id || null]);
    addTimeline(info.lastInsertRowid, 'register', null, null, null, '样本信息登记', operator || 'system');
    res.json({ success: true, data: { id: info.lastInsertRowid } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/samples/batch/inbound', requireWrite, (req, res) => {
  const { items, remark } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.json({ success: false, error: '批量入库数据为空' });
  }
  const results = { success: 0, failed: 0, errors: [] };
  const operator = currentUser.real_name || currentUser.username;

  try {
    runTransaction(() => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const { sample_id, location_id } = item;

        if (!sample_id || !location_id) {
          throw new Error(`第${i + 1}条: sample_id 和 location_id 必填`);
        }

        if (!canAccessSample(sample_id)) {
          throw new Error(`第${i + 1}条: 无权操作该样本(样本ID=${sample_id})`);
        }
        if (!canAccessLocation(location_id)) {
          throw new Error(`第${i + 1}条: 无权操作该库位所属温区(库位ID=${location_id})`);
        }

        const sample = queryOne('SELECT * FROM samples WHERE id=?', [sample_id]);
        if (!sample) throw new Error(`第${i + 1}条: 样本不存在(ID=${sample_id})`);
        if (sample.status === 'scrapped') throw new Error(`第${i + 1}条: 样本已报废，无法操作(条码=${sample.barcode})`);
        if (sample.status === 'in_storage') throw new Error(`第${i + 1}条: 样本已在库，不能重复入库(条码=${sample.barcode})`);

        const loc = getLocationWithZone(location_id);
        if (!loc) throw new Error(`第${i + 1}条: 库位不存在(ID=${location_id})`);

        const occupancy = getLocationOccupancy(location_id);
        if (occupancy >= loc.capacity) throw new Error(`第${i + 1}条: 库位已满(库位=${loc.code}, 容量${loc.capacity})`);

        if (sample.required_zone_id && loc.zone_id !== sample.required_zone_id) {
          throw new Error(`第${i + 1}条: 温区不匹配，样本应放指定温区，当前库位属于${loc.zone_name}(条码=${sample.barcode})`);
        }

        const beforeSample = { ...sample };
        runInTx(`UPDATE samples SET status='in_storage', current_location_id=?, updated_at=datetime('now','localtime') WHERE id=?`, [location_id, sample_id]);
        addTimelineInTx(sample_id, 'inbound', null, location_id, null, remark || '', operator);
        addAuditLogInTx(req, 'inbound', 'sample', sample_id,
          { status: beforeSample.status, current_location_id: beforeSample.current_location_id },
          { status: 'in_storage', current_location_id: location_id, location_code: loc.code },
          remark || `批量入库到 ${loc.code}`);
        results.success++;
      }
    });
    res.json({ success: true, data: results });
  } catch (e) {
    results.errors.push(e.message);
    results.failed = items.length - results.success;
    res.json({ success: false, error: e.message, data: results, rollback: true });
  }
});

app.post('/api/samples/batch/transfer', requireWrite, (req, res) => {
  const { items, remark } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.json({ success: false, error: '批量转移数据为空' });
  }
  const results = { success: 0, failed: 0, errors: [] };
  const operator = currentUser.real_name || currentUser.username;

  try {
    runTransaction(() => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const { sample_id, to_location_id } = item;

        if (!sample_id || !to_location_id) {
          throw new Error(`第${i + 1}条: sample_id 和 to_location_id 必填`);
        }

        if (!canAccessSample(sample_id)) {
          throw new Error(`第${i + 1}条: 无权操作该样本(样本ID=${sample_id})`);
        }
        if (!canAccessLocation(to_location_id)) {
          throw new Error(`第${i + 1}条: 无权操作目标库位所属温区(库位ID=${to_location_id})`);
        }

        const sample = queryOne('SELECT * FROM samples WHERE id=?', [sample_id]);
        if (!sample) throw new Error(`第${i + 1}条: 样本不存在(ID=${sample_id})`);
        if (sample.status !== 'in_storage') throw new Error(`第${i + 1}条: 样本不在库中，无法转移(条码=${sample.barcode})`);
        if (sample.current_location_id === to_location_id) throw new Error(`第${i + 1}条: 目标库位与当前相同(条码=${sample.barcode})`);

        const toLoc = getLocationWithZone(to_location_id);
        if (!toLoc) throw new Error(`第${i + 1}条: 目标库位不存在(ID=${to_location_id})`);

        const occupancy = getLocationOccupancy(to_location_id);
        if (occupancy >= toLoc.capacity) throw new Error(`第${i + 1}条: 目标库位已满(库位=${toLoc.code}, 容量${toLoc.capacity})`);

        if (sample.required_zone_id && toLoc.zone_id !== sample.required_zone_id) {
          throw new Error(`第${i + 1}条: 温区不匹配，目标库位属于${toLoc.zone_name}(条码=${sample.barcode})`);
        }

        const fromId = sample.current_location_id;
        const fromLoc = getLocationWithZone(fromId);

        runInTx(`UPDATE samples SET current_location_id=?, updated_at=datetime('now','localtime') WHERE id=?`, [to_location_id, sample_id]);
        addTimelineInTx(sample_id, 'transfer', fromId, to_location_id, null, remark || '', operator);
        addAuditLogInTx(req, 'transfer', 'sample', sample_id,
          { current_location_id: fromId, location_code: fromLoc ? fromLoc.code : null },
          { current_location_id: to_location_id, location_code: toLoc.code },
          remark || `批量转移: ${fromLoc ? fromLoc.code : '未知'} → ${toLoc.code}`);
        results.success++;
      }
    });
    res.json({ success: true, data: results });
  } catch (e) {
    results.errors.push(e.message);
    results.failed = items.length - results.success;
    res.json({ success: false, error: e.message, data: results, rollback: true });
  }
});

app.post('/api/samples/batch/outbound', requireWrite, (req, res) => {
  const { items, remark } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.json({ success: false, error: '批量出库数据为空' });
  }
  const results = { success: 0, failed: 0, errors: [] };
  const operator = currentUser.real_name || currentUser.username;

  try {
    runTransaction(() => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const { sample_id } = item;

        if (!sample_id) {
          throw new Error(`第${i + 1}条: sample_id 必填`);
        }

        if (!canAccessSample(sample_id)) {
          throw new Error(`第${i + 1}条: 无权操作该样本(样本ID=${sample_id})`);
        }

        const sample = queryOne('SELECT * FROM samples WHERE id=?', [sample_id]);
        if (!sample) throw new Error(`第${i + 1}条: 样本不存在(ID=${sample_id})`);
        if (sample.status !== 'in_storage') throw new Error(`第${i + 1}条: 样本未入库或已出库(条码=${sample.barcode})`);

        const fromId = sample.current_location_id;
        const fromLoc = getLocationWithZone(fromId);

        runInTx(`UPDATE samples SET status='outbound', current_location_id=NULL, updated_at=datetime('now','localtime') WHERE id=?`, [sample_id]);
        addTimelineInTx(sample_id, 'outbound', fromId, null, null, remark || '', operator);
        addAuditLogInTx(req, 'outbound', 'sample', sample_id,
          { status: sample.status, current_location_id: fromId, location_code: fromLoc ? fromLoc.code : null },
          { status: 'outbound', current_location_id: null },
          remark || `批量出库: ${fromLoc ? fromLoc.code : '未知'}`);
        results.success++;
      }
    });
    res.json({ success: true, data: results });
  } catch (e) {
    results.errors.push(e.message);
    results.failed = items.length - results.success;
    res.json({ success: false, error: e.message, data: results, rollback: true });
  }
});

app.post('/api/samples/:id/inbound', requireWrite, (req, res) => {
  const { id } = req.params;
  const { location_id, operator, remark } = req.body;
  if (!location_id) {
    return res.json({ success: false, error: '请选择入库库位' });
  }
  if (!canAccessLocation(location_id)) {
    return res.json({ success: false, error: '无权操作该库位所属温区', forbidden: true });
  }
  const sample = queryOne('SELECT * FROM samples WHERE id=?', [id]);
  if (!sample) {
    return res.json({ success: false, error: '样本不存在' });
  }
  if (!canAccessSample(id)) {
    return res.json({ success: false, error: '无权操作该样本', forbidden: true });
  }
  if (sample.status === 'scrapped') {
    return res.json({ success: false, error: '样本已报废，无法操作' });
  }
  if (sample.status === 'in_storage') {
    return res.json({ success: false, error: '样本已在库，不能重复入库，请使用转移功能' });
  }
  const loc = getLocationWithZone(location_id);
  if (!loc) {
    return res.json({ success: false, error: '库位不存在' });
  }
  const occupancy = getLocationOccupancy(location_id);
  if (occupancy >= loc.capacity) {
    return res.json({ success: false, error: `库位已满（容量${loc.capacity}），无法入库` });
  }
  if (sample.required_zone_id && loc.zone_id !== sample.required_zone_id) {
    return res.json({ success: false, error: `温区不匹配：样本应放指定温区，当前库位属于${loc.zone_name}`, warning: true });
  }

  const beforeSample = { ...sample };
  const targetLoc = loc;
  try {
    runTransaction(() => {
      runInTx(`
        UPDATE samples SET status='in_storage', current_location_id=?,
        updated_at=datetime('now','localtime') WHERE id=?
      `, [location_id, id]);
      addTimelineInTx(id, 'inbound', null, location_id, null, remark || '', operator || 'system');
      addAuditLogInTx(req, 'inbound', 'sample', id,
        { status: beforeSample.status, current_location_id: beforeSample.current_location_id },
        { status: 'in_storage', current_location_id: location_id, location_code: targetLoc.code },
        remark || `入库到 ${targetLoc.code}`);
    });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/samples/:id/transfer', requireWrite, (req, res) => {
  const { id } = req.params;
  const { to_location_id, operator, remark } = req.body;
  if (!to_location_id) {
    return res.json({ success: false, error: '请选择目标库位' });
  }
  if (!canAccessLocation(to_location_id)) {
    return res.json({ success: false, error: '无权操作目标库位所属温区', forbidden: true });
  }
  const sample = queryOne('SELECT * FROM samples WHERE id=?', [id]);
  if (!sample) {
    return res.json({ success: false, error: '样本不存在' });
  }
  if (!canAccessSample(id)) {
    return res.json({ success: false, error: '无权操作该样本', forbidden: true });
  }
  if (sample.status === 'scrapped') {
    return res.json({ success: false, error: '样本已报废，无法转移' });
  }
  if (sample.status !== 'in_storage') {
    return res.json({ success: false, error: '样本不在库中，无法转移，请先入库' });
  }
  if (sample.current_location_id === to_location_id) {
    return res.json({ success: false, error: '目标库位与当前相同，无需转移' });
  }
  const toLoc = getLocationWithZone(to_location_id);
  if (!toLoc) {
    return res.json({ success: false, error: '目标库位不存在' });
  }
  const occupancy = getLocationOccupancy(to_location_id);
  if (occupancy >= toLoc.capacity) {
    return res.json({ success: false, error: `目标库位已满（容量${toLoc.capacity}），无法转入` });
  }
  if (sample.required_zone_id && toLoc.zone_id !== sample.required_zone_id) {
    return res.json({ success: false, error: `温区不匹配：样本应放指定温区，目标库位属于${toLoc.zone_name}`, warning: true });
  }

  const fromId = sample.current_location_id;
  const fromLoc = getLocationWithZone(fromId);
  const beforeTransfer = { ...sample };
  try {
    runTransaction(() => {
      runInTx(`
        UPDATE samples SET current_location_id=?,
        updated_at=datetime('now','localtime') WHERE id=?
      `, [to_location_id, id]);
      addTimelineInTx(id, 'transfer', fromId, to_location_id, null, remark || '', operator || 'system');
      addAuditLogInTx(req, 'transfer', 'sample', id,
        { current_location_id: fromId, location_code: fromLoc ? fromLoc.code : null },
        { current_location_id: to_location_id, location_code: toLoc.code },
        remark || `从 ${fromLoc ? fromLoc.code : '未知'} 转移到 ${toLoc.code}`);
    });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/samples/:id/outbound', requireWrite, (req, res) => {
  const { id } = req.params;
  const { operator, remark } = req.body;
  const sample = queryOne('SELECT * FROM samples WHERE id=?', [id]);
  if (!sample) {
    return res.json({ success: false, error: '样本不存在' });
  }
  if (!canAccessSample(id)) {
    return res.json({ success: false, error: '无权操作该样本', forbidden: true });
  }
  if (sample.status === 'scrapped') {
    return res.json({ success: false, error: '样本已报废，无法出库' });
  }
  if (sample.status !== 'in_storage') {
    return res.json({ success: false, error: '样本未入库或已出库，无法执行出库操作' });
  }

  const fromId = sample.current_location_id;
  const fromLoc = getLocationWithZone(fromId);
  const beforeOutbound = { ...sample };
  try {
    runTransaction(() => {
      runInTx(`
        UPDATE samples SET status='outbound', current_location_id=NULL,
        updated_at=datetime('now','localtime') WHERE id=?
      `, [id]);
      addTimelineInTx(id, 'outbound', fromId, null, null, remark || '', operator || 'system');
      addAuditLogInTx(req, 'outbound', 'sample', id,
        { status: beforeOutbound.status, current_location_id: fromId, location_code: fromLoc ? fromLoc.code : null },
        { status: 'outbound', current_location_id: null },
        remark || `从 ${fromLoc ? fromLoc.code : '未知'} 出库`);
    });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/samples/:id/scrap', requireWrite, (req, res) => {
  const { id } = req.params;
  const { operator, remark } = req.body;
  const sample = queryOne('SELECT * FROM samples WHERE id=?', [id]);
  if (!sample) {
    return res.json({ success: false, error: '样本不存在' });
  }
  if (!canAccessSample(id)) {
    return res.json({ success: false, error: '无权操作该样本', forbidden: true });
  }
  if (sample.status === 'scrapped') {
    return res.json({ success: false, error: '样本已报废' });
  }

  const fromId = sample.current_location_id;
  const fromLoc = getLocationWithZone(fromId);
  const beforeScrap = { ...sample };
  try {
    runTransaction(() => {
      runInTx(`
        UPDATE samples SET status='scrapped', current_location_id=NULL,
        updated_at=datetime('now','localtime') WHERE id=?
      `, [id]);
      addTimelineInTx(id, 'scrapped', fromId, null, null, remark || '样本报废', operator || 'system');
      addAuditLogInTx(req, 'scrap', 'sample', id,
        { status: beforeScrap.status, current_location_id: fromId, location_code: fromLoc ? fromLoc.code : null },
        { status: 'scrapped', current_location_id: null },
        remark || '样本报废');
    });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/samples/:id/temp-exception', requireWrite, (req, res) => {
  const { id } = req.params;
  const { temperature, remark, operator } = req.body;
  if (temperature === undefined || temperature === null || temperature === '') {
    return res.json({ success: false, error: '请填写异常温度值' });
  }
  const sample = queryOne('SELECT * FROM samples WHERE id=?', [id]);
  if (!sample) {
    return res.json({ success: false, error: '样本不存在' });
  }
  if (!canAccessSample(id)) {
    return res.json({ success: false, error: '无权操作该样本', forbidden: true });
  }
  const locId = sample.current_location_id;
  addTimeline(id, 'temp_exception', locId, locId, temperature, remark || '', operator || 'system');
  res.json({ success: true });
});

app.get('/api/samples/export/csv', (req, res) => {
  const samples = queryAll(`
    SELECT s.barcode, s.batch_no, s.name, s.status,
      rz.name as required_zone,
      sl.code as location_code, sl.name as location_name,
      tz.name as current_zone,
      s.created_at, s.updated_at
    FROM samples s
    LEFT JOIN storage_locations sl ON s.current_location_id = sl.id
    LEFT JOIN temperature_zones tz ON sl.zone_id = tz.id
    LEFT JOIN temperature_zones rz ON s.required_zone_id = rz.id
    ORDER BY s.id DESC
  `);

  const header = ['条码','批次号','名称','状态','要求温区','库位编码','库位名称','当前温区','创建时间','更新时间'];
  const statusMap = { pending: '待入库', in_storage: '在库', outbound: '已出库', scrapped: '已报废', reserved_outbound: '已预约出库' };
  const lines = [header.join(',')];
  samples.forEach(s => {
    lines.push([
      `"${s.barcode || ''}"`,
      `"${s.batch_no || ''}"`,
      `"${s.name || ''}"`,
      `"${statusMap[s.status] || s.status}"`,
      `"${s.required_zone || ''}"`,
      `"${s.location_code || ''}"`,
      `"${s.location_name || ''}"`,
      `"${s.current_zone || ''}"`,
      `"${s.created_at || ''}"`,
      `"${s.updated_at || ''}"`
    ].join(','));
  });
  const csv = '\ufeff' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="samples_${Date.now()}.csv"`);
  res.send(csv);
});

app.post('/api/samples/import/csv', requireAdmin, (req, res) => {
  const { rows, operator } = req.body;
  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    return res.json({ success: false, error: '导入数据为空', data: { errors: [], results: [] } });
  }

  const ip = getClientIp(req);
  const opId = currentUser ? currentUser.id : null;
  const opName = currentUser ? (currentUser.real_name || currentUser.username) : null;
  const allZones = queryAll('SELECT id, name FROM temperature_zones');
  const zoneNameMap = {};
  allZones.forEach(z => { zoneNameMap[z.name] = z.id; });

  const validationErrors = [];
  const csvBarcodes = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const barcode = ((row.barcode || row['条码']) || '').trim();
    const batch_no = ((row.batch_no || row['批次'] || row['批次号']) || '').trim();
    const name = ((row.name || row['名称']) || '').trim();
    const zoneName = ((row.required_zone || row['要求温区'] || row['温区']) || '').trim();

    if (!barcode) {
      validationErrors.push({ row_number: i + 1, barcode: '', batch_no, name, required_zone: zoneName, error: '条码不能为空' });
      continue;
    }
    if (!batch_no) {
      validationErrors.push({ row_number: i + 1, barcode, batch_no: '', name, required_zone: zoneName, error: '批次不能为空' });
      continue;
    }
    if (queryOne('SELECT id FROM samples WHERE barcode=?', [barcode])) {
      validationErrors.push({ row_number: i + 1, barcode, batch_no, name, required_zone: zoneName, error: `条码 ${barcode} 与库中已有样本重复` });
      continue;
    }
    if (csvBarcodes.has(barcode)) {
      validationErrors.push({ row_number: i + 1, barcode, batch_no, name, required_zone: zoneName, error: `条码 ${barcode} 在本批次内重复` });
      continue;
    }
    csvBarcodes.add(barcode);

    if (zoneName && !zoneNameMap[zoneName]) {
      validationErrors.push({ row_number: i + 1, barcode, batch_no, name, required_zone: zoneName, error: `要求温区"${zoneName}"在温区表中不存在` });
      continue;
    }
  }

  if (validationErrors.length > 0) {
    const batchInfo = run(`
      INSERT INTO sample_import_batches
      (total_rows, success_count, failed_count, status, operator_id, operator_name, ip_address, remark)
      VALUES (?, 0, ?, 'failed', ?, ?, ?, ?)
    `, [rows.length, validationErrors.length, opId, opName, ip, `批量导入失败: ${validationErrors.length}条校验不通过，整批回滚`]);
    const batchId = batchInfo.lastInsertRowid;

    validationErrors.forEach(err => {
      run(`
        INSERT INTO sample_import_results
        (batch_id, row_number, barcode, batch_no, name, required_zone, status, failure_reason)
        VALUES (?, ?, ?, ?, ?, ?, 'failed', ?)
      `, [batchId, err.row_number, err.barcode, err.batch_no, err.name, err.required_zone, err.error]);

      insertAuditLog({
        operator_id: opId,
        operator_name: opName,
        ip_address: ip,
        action_type: 'batch_import',
        object_type: 'sample',
        object_id: err.barcode || `row_${err.row_number}`,
        before_value: null,
        after_value: {
          row_number: err.row_number,
          barcode: err.barcode,
          batch_no: err.batch_no,
          name: err.name,
          required_zone: err.required_zone,
          status: 'failed',
          failure_reason: err.error
        },
        remark: `批量导入失败: ${err.error}`
      });
    });

    insertAuditLog({
      operator_id: opId,
      operator_name: opName,
      ip_address: ip,
      action_type: 'batch_import',
      object_type: 'sample_import_batch',
      object_id: String(batchId),
      before_value: null,
      after_value: {
        total_rows: rows.length,
        success_count: 0,
        failed_count: validationErrors.length,
        status: 'failed',
        first_error: validationErrors[0].error
      },
      remark: `批量导入整批失败: 共${rows.length}条，${validationErrors.length}条校验不通过，整批回滚`
    });

    const importResults = validationErrors.map(err => ({
      row_number: err.row_number,
      barcode: err.barcode,
      batch_no: err.batch_no,
      name: err.name,
      required_zone: err.required_zone,
      status: 'failed',
      failure_reason: err.error
    }));

    return res.json({
      success: false,
      error: `导入失败: ${validationErrors[0].error}，整批已回滚`,
      data: {
        batch_id: batchId,
        total: rows.length,
        success: 0,
        failed: validationErrors.length,
        results: importResults,
        errors: importResults,
        rollback: true
      }
    });
  }

  let batchId = null;
  const results = [];

  try {
    runTransaction(() => {
      const batchInfo = runInTx(`
        INSERT INTO sample_import_batches
        (total_rows, success_count, failed_count, status, operator_id, operator_name, ip_address, remark)
        VALUES (?, 0, 0, 'processing', ?, ?, ?, ?)
      `, [rows.length, opId, opName, ip, `批量导入${rows.length}条样本`]);
      batchId = batchInfo.lastInsertRowid;

      let successCount = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const barcode = ((row.barcode || row['条码']) || '').trim();
        const batch_no = ((row.batch_no || row['批次'] || row['批次号']) || '').trim();
        const name = ((row.name || row['名称']) || '').trim();
        const zoneName = ((row.required_zone || row['要求温区'] || row['温区']) || '').trim();
        const zoneId = zoneName ? zoneNameMap[zoneName] : null;

        const info = runInTx(`
          INSERT INTO samples (barcode, batch_no, name, required_zone_id, status)
          VALUES (?, ?, ?, ?, 'pending')
        `, [barcode, batch_no, name, zoneId]);

        addTimelineInTx(info.lastInsertRowid, 'register', null, null, null, '批量导入登记', operator || opName || 'system');

        runInTx(`
          INSERT INTO sample_import_results
          (batch_id, row_number, barcode, batch_no, name, required_zone, status, sample_id)
          VALUES (?, ?, ?, ?, ?, ?, 'success', ?)
        `, [batchId, i + 1, barcode, batch_no, name, zoneName, info.lastInsertRowid]);

        insertAuditLogInTx({
          operator_id: opId,
          operator_name: opName,
          ip_address: ip,
          action_type: 'batch_import',
          object_type: 'sample',
          object_id: String(info.lastInsertRowid),
          before_value: null,
          after_value: {
            row_number: i + 1,
            barcode,
            batch_no,
            name,
            required_zone: zoneName,
            required_zone_id: zoneId,
            status: 'success',
            sample_id: info.lastInsertRowid
          },
          remark: `批量导入成功: 条码${barcode}`
        });

        results.push({ row_number: i + 1, barcode, status: 'success', sample_id: info.lastInsertRowid });
        successCount++;
      }

      runInTx(`
        UPDATE sample_import_batches
        SET success_count = ?, failed_count = 0, status = 'success',
            updated_at = datetime('now','localtime')
        WHERE id = ?
      `, [successCount, batchId]);

      insertAuditLogInTx({
        operator_id: opId,
        operator_name: opName,
        ip_address: ip,
        action_type: 'batch_import',
        object_type: 'sample_import_batch',
        object_id: String(batchId),
        before_value: null,
        after_value: {
          total_rows: rows.length,
          success_count: successCount,
          failed_count: 0,
          status: 'success'
        },
        remark: `批量导入完成: 共${rows.length}条，全部成功`
      });
    });

    res.json({
      success: true,
      data: {
        batch_id: batchId,
        total: rows.length,
        success: results.length,
        failed: 0,
        results,
        errors: []
      }
    });
  } catch (e) {
    res.json({
      success: false,
      error: `导入失败: ${e.message}，整批已回滚`,
      data: {
        batch_id: batchId,
        total: rows.length,
        success: 0,
        failed: rows.length,
        results: [],
        errors: [],
        rollback: true
      }
    });
  }
});

app.get('/api/samples/import/batches', requireAdmin, (req, res) => {
  const batches = queryAll(`
    SELECT sib.*,
      (SELECT COUNT(*) FROM sample_import_results sir WHERE sir.batch_id = sib.id AND sir.status = 'success') as success_count,
      (SELECT COUNT(*) FROM sample_import_results sir WHERE sir.batch_id = sib.id AND sir.status = 'failed') as failed_count
    FROM sample_import_batches sib
    ORDER BY sib.id DESC
  `);
  res.json({ success: true, data: batches });
});

app.get('/api/samples/import/batches/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const batch = queryOne('SELECT * FROM sample_import_batches WHERE id = ?', [id]);
  if (!batch) {
    return res.json({ success: false, error: '导入批次不存在' });
  }
  const results = queryAll(
    'SELECT * FROM sample_import_results WHERE batch_id = ? ORDER BY row_number',
    [id]
  );
  res.json({ success: true, data: { batch, results } });
});

app.get('/api/samples/import/batches/:id/export/csv', requireAdmin, (req, res) => {
  const { id } = req.params;
  const batch = queryOne('SELECT * FROM sample_import_batches WHERE id = ?', [id]);
  if (!batch) {
    return res.json({ success: false, error: '导入批次不存在' });
  }
  const results = queryAll(
    'SELECT row_number, barcode, batch_no, name, required_zone, status, failure_reason FROM sample_import_results WHERE batch_id = ? ORDER BY row_number',
    [id]
  );

  const header = ['原始行号', '条码', '批次', '名称', '要求温区', '导入状态', '失败原因'];
  const statusMap = { success: '成功', failed: '失败' };
  const lines = [header.join(',')];
  results.forEach(r => {
    lines.push([
      r.row_number,
      `"${r.barcode || ''}"`,
      `"${r.batch_no || ''}"`,
      `"${r.name || ''}"`,
      `"${r.required_zone || ''}"`,
      `"${statusMap[r.status] || r.status}"`,
      `"${r.failure_reason || ''}"`
    ].join(','));
  });

  const csv = '\ufeff' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import_batch_${id}_${Date.now()}.csv"`);
  res.send(csv);
});

app.get('/api/dashboard/stats', (req, res) => {
  const total = queryOne('SELECT COUNT(*) as cnt FROM samples').cnt;
  const inStorage = queryOne("SELECT COUNT(*) as cnt FROM samples WHERE status='in_storage'").cnt;
  const pending = queryOne("SELECT COUNT(*) as cnt FROM samples WHERE status='pending'").cnt;
  const outbound = queryOne("SELECT COUNT(*) as cnt FROM samples WHERE status='outbound'").cnt;
  const scrapped = queryOne("SELECT COUNT(*) as cnt FROM samples WHERE status='scrapped'").cnt;
  const reservedOutbound = queryOne("SELECT COUNT(*) as cnt FROM samples WHERE status='reserved_outbound'").cnt;

  const tempExceptions = queryOne(
    "SELECT COUNT(*) as cnt FROM sample_timeline WHERE action_type='temp_exception'"
  ).cnt;

  const zoneMismatch = queryOne(`
    SELECT COUNT(*) as cnt FROM samples s
    INNER JOIN storage_locations sl ON s.current_location_id = sl.id
    WHERE s.status='in_storage' AND s.required_zone_id IS NOT NULL
      AND sl.zone_id != s.required_zone_id
  `).cnt;

  const allLocations = queryAll(`
    SELECT sl.*, tz.name as zone_name
    FROM storage_locations sl
    LEFT JOIN temperature_zones tz ON sl.zone_id = tz.id
  `);
  const fullLocations = allLocations.map(loc => {
    loc.occupancy = getLocationOccupancy(loc.id);
    return loc;
  }).filter(loc => loc.occupancy >= loc.capacity);

  const recentRisks = queryAll(`
    SELECT s.*, sl.code as location_code, tz.name as zone_name,
      rz.name as required_zone_name,
      (SELECT COUNT(*) FROM sample_timeline st WHERE st.sample_id=s.id AND st.action_type='temp_exception') as exception_count
    FROM samples s
    LEFT JOIN storage_locations sl ON s.current_location_id = sl.id
    LEFT JOIN temperature_zones tz ON sl.zone_id = tz.id
    LEFT JOIN temperature_zones rz ON s.required_zone_id = rz.id
    WHERE s.status='in_storage' AND (
      (s.required_zone_id IS NOT NULL AND sl.zone_id != s.required_zone_id)
      OR EXISTS (SELECT 1 FROM sample_timeline st WHERE st.sample_id=s.id AND st.action_type='temp_exception')
    )
    ORDER BY s.updated_at DESC
    LIMIT 50
  `);

  res.json({
    success: true,
    data: {
      total, inStorage, pending, outbound, scrapped, reservedOutbound,
      tempExceptions, zoneMismatch,
      fullLocations,
      recentRisks
    }
  });
});

// 获取默认低库存阈值
app.get('/api/inventory/config/threshold', requireAuth, (req, res) => {
  try {
    const config = queryOne("SELECT config_value FROM inventory_config WHERE config_key = 'default_low_stock_threshold'");
    const threshold = config ? parseInt(config.config_value) : 10;
    res.json({ success: true, data: { default_threshold: threshold } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 设置默认低库存阈值
app.put('/api/inventory/config/threshold', requireAdmin, (req, res) => {
  const { threshold } = req.body;
  if (threshold === undefined || threshold === null || isNaN(threshold)) {
    return res.json({ success: false, error: '阈值不能为空且必须是数字' });
  }
  const thresholdNum = parseInt(threshold);
  if (thresholdNum < 0) {
    return res.json({ success: false, error: '阈值不能为负数' });
  }
  try {
    const beforeConfig = queryOne("SELECT config_value FROM inventory_config WHERE config_key = 'default_low_stock_threshold'");
    const beforeValue = beforeConfig ? parseInt(beforeConfig.config_value) : null;

    run(`
      INSERT INTO inventory_config (config_key, config_value, updated_at)
      VALUES ('default_low_stock_threshold', ?, datetime('now','localtime'))
      ON CONFLICT(config_key) DO UPDATE SET
        config_value = excluded.config_value,
        updated_at = datetime('now','localtime')
    `, [String(thresholdNum)]);

    addAuditLog(req, 'threshold_setting', 'inventory_config', 'default_low_stock_threshold',
      { default_threshold: beforeValue },
      { default_threshold: thresholdNum },
      `设置默认低库存阈值: ${beforeValue} → ${thresholdNum}`);

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 获取物品阈值
app.get('/api/inventory/item-threshold', requireAuth, (req, res) => {
  try {
    const { item_name } = req.query;
    let sql = 'SELECT * FROM item_threshold';
    const params = [];
    if (item_name) {
      sql += ' WHERE item_name = ?';
      params.push(item_name);
    }
    sql += ' ORDER BY item_name';
    const rows = queryAll(sql, params);
    res.json({ success: true, data: rows });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 设置物品阈值
app.put('/api/inventory/item-threshold', requireAdmin, (req, res) => {
  const { item_name, threshold } = req.body;
  if (!item_name) {
    return res.json({ success: false, error: '物品名称必填' });
  }
  if (threshold === undefined || threshold === null || isNaN(threshold)) {
    return res.json({ success: false, error: '阈值不能为空且必须是数字' });
  }
  const thresholdNum = parseInt(threshold);
  if (thresholdNum < 0) {
    return res.json({ success: false, error: '阈值不能为负数' });
  }
  try {
    const beforeItem = queryOne('SELECT threshold FROM item_threshold WHERE item_name = ?', [item_name]);
    const beforeValue = beforeItem ? beforeItem.threshold : null;

    run(`
      INSERT INTO item_threshold (item_name, threshold, updated_at)
      VALUES (?, ?, datetime('now','localtime'))
      ON CONFLICT(item_name) DO UPDATE SET
        threshold = excluded.threshold,
        updated_at = datetime('now','localtime')
    `, [item_name, thresholdNum]);

    addAuditLog(req, 'threshold_setting', 'item_threshold', item_name,
      { item_name, threshold: beforeValue },
      { item_name, threshold: thresholdNum },
      beforeValue !== null
        ? `设置物品"${item_name}"阈值: ${beforeValue} → ${thresholdNum}`
        : `新增物品"${item_name}"阈值: ${thresholdNum}`);

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 删除物品阈值
app.delete('/api/inventory/item-threshold/:item_name', requireAdmin, (req, res) => {
  const { item_name } = req.params;
  try {
    const beforeItem = queryOne('SELECT threshold FROM item_threshold WHERE item_name = ?', [item_name]);
    if (!beforeItem) {
      return res.json({ success: false, error: '物品阈值不存在' });
    }
    run('DELETE FROM item_threshold WHERE item_name = ?', [item_name]);

    addAuditLog(req, 'threshold_setting', 'item_threshold', item_name,
      { item_name, threshold: beforeItem.threshold },
      null,
      `删除物品"${item_name}"阈值`);

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 低库存预警查询
app.get('/api/inventory/low-stock', requireAuth, (req, res) => {
  try {
    const defaultConfig = queryOne("SELECT config_value FROM inventory_config WHERE config_key = 'default_low_stock_threshold'");
    const defaultThreshold = defaultConfig ? parseInt(defaultConfig.config_value) : 10;

    const accessibleZones = getAccessibleZoneIds();
    let zoneCondition = '';
    const params = [];

    if (accessibleZones !== null) {
      if (accessibleZones.length === 0) {
        return res.json({ success: true, data: [] });
      }
      zoneCondition = ' AND (s.required_zone_id IN (' + accessibleZones.map(() => '?').join(',') + ')' +
        ' OR EXISTS (SELECT 1 FROM storage_locations sl2 WHERE sl2.id = s.current_location_id AND sl2.zone_id IN (' + accessibleZones.map(() => '?').join(',') + ')))';
      params.push(...accessibleZones, ...accessibleZones);
    }

    const sql = `
      SELECT
        s.name,
        s.batch_no,
        COUNT(*) as stock_count,
        COALESCE(it.threshold, ?) as threshold,
        MAX(s.updated_at) as last_updated_at
      FROM samples s
      LEFT JOIN item_threshold it ON s.name = it.item_name
      WHERE s.status = 'in_storage'
      ${zoneCondition}
      GROUP BY s.name, s.batch_no
      HAVING COUNT(*) < COALESCE(it.threshold, ?)
      ORDER BY s.name, s.batch_no
    `;

    const allParams = [defaultThreshold, ...params, defaultThreshold];
    const rows = queryAll(sql, allParams);

    res.json({
      success: true,
      data: {
        default_threshold: defaultThreshold,
        items: rows
      }
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/inventory', requireAuth, (req, res) => {
  const { keyword, status } = req.query;
  let sql = `
    SELECT io.*,
      tz.name as zone_name,
      sl.code as location_code, sl.name as location_name
    FROM inventory_orders io
    LEFT JOIN temperature_zones tz ON io.zone_id = tz.id
    LEFT JOIN storage_locations sl ON io.location_id = sl.id
    WHERE 1=1
  `;
  const params = [];
  if (keyword) {
    sql += ' AND (io.order_no LIKE ? OR io.title LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (status && status !== 'all') {
    sql += ' AND io.status = ?';
    params.push(status);
  }
  const accessibleZones = getAccessibleZoneIds();
  if (accessibleZones !== null) {
    if (accessibleZones.length === 0) {
      return res.json({ success: true, data: [] });
    }
    sql += ' AND (io.zone_id IN (' + accessibleZones.map(() => '?').join(',') + ')' +
      ' OR io.location_id IN (SELECT sl.id FROM storage_locations sl WHERE sl.zone_id IN (' + accessibleZones.map(() => '?').join(',') + '))' +
      ' OR (io.zone_id IS NULL AND io.location_id IS NULL))';
    params.push(...accessibleZones, ...accessibleZones);
  }
  sql += ' ORDER BY io.id DESC';
  const orders = queryAll(sql, params);
  orders.forEach(o => {
    o.status_label = INVENTORY_STATUS_LABELS[o.status] || o.status;
  });
  res.json({ success: true, data: orders });
});

app.get('/api/inventory/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const order = queryOne(`
    SELECT io.*,
      tz.name as zone_name,
      sl.code as location_code, sl.name as location_name
    FROM inventory_orders io
    LEFT JOIN temperature_zones tz ON io.zone_id = tz.id
    LEFT JOIN storage_locations sl ON io.location_id = sl.id
    WHERE io.id = ?
  `, [id]);
  if (!order) {
    return res.json({ success: false, error: '盘点单不存在' });
  }
  order.status_label = INVENTORY_STATUS_LABELS[order.status] || order.status;

  const items = queryAll(`
    SELECT ii.*, s.batch_no, s.name, s.status as sample_status
    FROM inventory_items ii
    LEFT JOIN samples s ON ii.sample_id = s.id
    WHERE ii.inventory_order_id = ?
    ORDER BY ii.id
  `, [id]);
  items.forEach(i => {
    i.status_label = i.match_status === 'matched' ? '匹配' :
                     i.match_status === 'mismatch' ? '不匹配' : '待处理';
    if (i.discrepancy_type) {
      i.discrepancy_type_label = DISCREPANCY_TYPE_LABELS[i.discrepancy_type] || i.discrepancy_type;
    }
  });

  const discrepancies = queryAll(`
    SELECT id.*,
      sl_old.code as old_location_code, sl_old.name as old_location_name,
      sl_new.code as new_location_code, sl_new.name as new_location_name,
      s.batch_no, s.name
    FROM inventory_discrepancies id
    LEFT JOIN storage_locations sl_old ON id.old_location_id = sl_old.id
    LEFT JOIN storage_locations sl_new ON id.new_location_id = sl_new.id
    LEFT JOIN samples s ON id.sample_id = s.id
    WHERE id.inventory_order_id = ?
    ORDER BY id.id
  `, [id]);
  discrepancies.forEach(d => {
    d.type_label = DISCREPANCY_TYPE_LABELS[d.type] || d.type;
    d.status_label = DISCREPANCY_STATUS_LABELS[d.status] || d.status;
    if (d.old_status) {
      d.old_status_label = STATUS_LABELS[d.old_status] || d.old_status;
    }
    if (d.new_status) {
      d.new_status_label = STATUS_LABELS[d.new_status] || d.new_status;
    }
  });

  res.json({ success: true, data: { order, items, discrepancies } });
});

app.post('/api/inventory', requireWrite, (req, res) => {
  const { title, type, zone_id, location_id, remark } = req.body;
  if (!title || !type) {
    return res.json({ success: false, error: '盘点标题和类型必填' });
  }
  if (type === 'zone' && !zone_id) {
    return res.json({ success: false, error: '按温区盘点时请选择温区' });
  }
  if (type === 'location' && !location_id) {
    return res.json({ success: false, error: '按库位盘点时请选择库位' });
  }
  if (type === 'zone' && zone_id && !canAccessZone(zone_id)) {
    return res.json({ success: false, error: '无权操作该温区的盘点单', forbidden: true });
  }
  if (type === 'location' && location_id && !canAccessLocation(location_id)) {
    return res.json({ success: false, error: '无权操作该库位所属温区的盘点单', forbidden: true });
  }

  const orderNo = generateOrderNo();
  try {
    const info = run(`
      INSERT INTO inventory_orders
      (order_no, title, type, zone_id, location_id, status, operator, operator_id, remark)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)
    `, [orderNo, title, type, zone_id || null, location_id || null,
        currentUser.real_name || currentUser.username, currentUser.id, remark || '']);
    res.json({ success: true, data: { id: info.lastInsertRowid, order_no: orderNo } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/inventory/:id/import', requireWrite, (req, res) => {
  const { id } = req.params;
  const { csv_text, rows } = req.body;

  const order = queryOne('SELECT * FROM inventory_orders WHERE id = ?', [id]);
  if (!order) {
    return res.json({ success: false, error: '盘点单不存在' });
  }
  if (order.status === 'completed') {
    return res.json({ success: false, error: '盘点单已完成，不能再导入' });
  }

  let items = [];
  if (csv_text) {
    items = parseInventoryCSV(csv_text);
  } else if (rows && Array.isArray(rows)) {
    items = rows.map(r => ({
      barcode: (r.barcode || '').trim(),
      scanned_location_code: (r.scanned_location_code || r.location_code || '').trim(),
      scan_time: r.scan_time || ''
    })).filter(r => r.barcode);
  }

  if (items.length === 0) {
    return res.json({ success: false, error: '没有有效的扫码数据' });
  }

  const barcodes = new Set();
  const duplicates = [];
  const uniqueItems = [];
  items.forEach((item, idx) => {
    if (barcodes.has(item.barcode)) {
      duplicates.push(`第${idx + 1}行: 条码 ${item.barcode} 重复，已跳过`);
    } else {
      barcodes.add(item.barcode);
      uniqueItems.push(item);
    }
  });

  try {
    runTransaction(() => {
      runInTx('DELETE FROM inventory_items WHERE inventory_order_id = ?', [id]);
      runInTx('DELETE FROM inventory_discrepancies WHERE inventory_order_id = ?', [id]);

      uniqueItems.forEach(item => {
        runInTx(`
          INSERT INTO inventory_items
          (inventory_order_id, barcode, scanned_location_code, scan_time, match_status)
          VALUES (?, ?, ?, ?, 'pending')
        `, [id, item.barcode, item.scanned_location_code, item.scan_time || null]);
      });

      runInTx(`
        UPDATE inventory_orders SET
          total_scanned = ?,
          updated_at = datetime('now','localtime')
        WHERE id = ?
      `, [uniqueItems.length, id]);
    });

    const result = performInventoryMatch(id);
    addAuditLog(req, 'inventory_import', 'inventory_order', id,
      null,
      {
        imported: uniqueItems.length,
        duplicates: duplicates.length,
        total_expected: result ? result.total_expected : 0,
        total_matched: result ? result.total_matched : 0,
        total_missing: result ? result.total_missing : 0,
        total_mislocated: result ? result.total_mislocated : 0
      },
      `盘点导入 ${uniqueItems.length} 条扫码数据${duplicates.length > 0 ? `，跳过 ${duplicates.length} 条重复` : ''}`);
    res.json({
      success: true,
      data: {
        imported: uniqueItems.length,
        duplicates: duplicates.length,
        duplicate_notes: duplicates,
        order: result
      }
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/inventory/:id/complete', requireWrite, (req, res) => {
  const { id } = req.params;
  const order = queryOne('SELECT * FROM inventory_orders WHERE id = ?', [id]);
  if (!order) {
    return res.json({ success: false, error: '盘点单不存在' });
  }
  if (order.status === 'completed') {
    return res.json({ success: false, error: '盘点单已完成' });
  }

  try {
    run(`
      UPDATE inventory_orders SET
        status = 'completed',
        completed_at = datetime('now','localtime'),
        updated_at = datetime('now','localtime')
      WHERE id = ?
    `, [id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/inventory/:id/export/csv', requireAuth, (req, res) => {
  const { id } = req.params;
  const orderData = queryOne(`
    SELECT io.*,
      tz.name as zone_name,
      sl.code as location_code
    FROM inventory_orders io
    LEFT JOIN temperature_zones tz ON io.zone_id = tz.id
    LEFT JOIN storage_locations sl ON io.location_id = sl.id
    WHERE io.id = ?
  `, [id]);
  if (!orderData) {
    return res.json({ success: false, error: '盘点单不存在' });
  }

  const items = queryAll(`
    SELECT ii.*, s.batch_no, s.name, s.status as sample_status
    FROM inventory_items ii
    LEFT JOIN samples s ON ii.sample_id = s.id
    WHERE ii.inventory_order_id = ?
    ORDER BY ii.id
  `, [id]);

  const discrepancies = queryAll(`
    SELECT id.*,
      sl_old.code as old_location_code,
      sl_new.code as new_location_code
    FROM inventory_discrepancies id
    LEFT JOIN storage_locations sl_old ON id.old_location_id = sl_old.id
    LEFT JOIN storage_locations sl_new ON id.new_location_id = sl_new.id
    WHERE id.inventory_order_id = ?
    ORDER BY id.id
  `, [id]);

  const header = ['条码','批次号','名称','扫码库位','台账库位','匹配状态','差异类型','差异说明','处理状态','处理人','处理时间','处理原因'];
  const statusMap = { pending: '待入库', in_storage: '在库', outbound: '已出库', scrapped: '已报废', reserved_outbound: '已预约出库' };
  const matchMap = { matched: '匹配', mismatch: '不匹配', pending: '待处理' };
  const dispStatusMap = { pending: '待处理', processing: '处理中', resolved: '已解决', ignored: '已忽略' };

  const dispMap = {};
  discrepancies.forEach(d => {
    dispMap[d.inventory_item_id] = d;
  });

  const lines = [header.join(',')];
  items.forEach(item => {
    const d = dispMap[item.id];
    lines.push([
      `"${item.barcode || ''}"`,
      `"${item.batch_no || ''}"`,
      `"${item.name || ''}"`,
      `"${item.scanned_location_code || ''}"`,
      `"${item.expected_location_code || ''}"`,
      `"${matchMap[item.match_status] || item.match_status}"`,
      `"${item.discrepancy_type ? (DISCREPANCY_TYPE_LABELS[item.discrepancy_type] || item.discrepancy_type) : ''}"`,
      `"${item.discrepancy_note || ''}"`,
      `"${d ? (dispStatusMap[d.status] || d.status) : ''}"`,
      `"${d ? (d.handler || '') : ''}"`,
      `"${d ? (d.handled_at || '') : ''}"`,
      `"${d ? (d.handler_remark || '') : ''}"`
    ].join(','));
  });

  const csv = '\ufeff' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="inventory_${orderData.order_no}_${Date.now()}.csv"`);
  res.send(csv);
});

app.post('/api/discrepancies/:id/note', requireWrite, (req, res) => {
  const { id } = req.params;
  const { remark } = req.body;

  const disp = queryOne('SELECT * FROM inventory_discrepancies WHERE id = ?', [id]);
  if (!disp) {
    return res.json({ success: false, error: '差异记录不存在' });
  }

  try {
    run(`
      UPDATE inventory_discrepancies SET
        handler_remark = COALESCE(handler_remark, '') || ?,
        handler = ?,
        handler_id = ?,
        status = 'processing',
        updated_at = datetime('now','localtime')
      WHERE id = ?
    `, [`${currentUser.real_name || currentUser.username}: ${remark || ''}\n`,
        currentUser.real_name || currentUser.username, currentUser.id, id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/discrepancies/:id/resolve', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { action, new_location_id, new_status, remark } = req.body;

  const disp = queryOne('SELECT * FROM inventory_discrepancies WHERE id = ?', [id]);
  if (!disp) {
    return res.json({ success: false, error: '差异记录不存在' });
  }

  if (disp.status === 'resolved') {
    return res.json({ success: false, error: '该差异已处理，不能重复操作' });
  }

  try {
    if (action === 'correct_location' && disp.sample_id && new_location_id) {
      const sample = queryOne('SELECT * FROM samples WHERE id = ?', [disp.sample_id]);
      if (!sample) {
        return res.json({ success: false, error: '样本不存在' });
      }
      if (sample.status !== 'in_storage') {
        return res.json({ success: false, error: '样本不在库，无法修正位置' });
      }

      const newLoc = getLocationWithZone(new_location_id);
      if (!newLoc) {
        return res.json({ success: false, error: '目标库位不存在' });
      }

      const oldLocId = sample.current_location_id;
      const oldLoc = getLocationWithZone(oldLocId);
      const beforeSample = { ...sample };

      runTransaction(() => {
        runInTx(`
          UPDATE samples SET
            current_location_id = ?,
            updated_at = datetime('now','localtime')
          WHERE id = ?
        `, [new_location_id, disp.sample_id]);

        addTimelineInTx(disp.sample_id, 'inventory_correction', oldLocId, new_location_id,
          null, `盘点纠错：${remark || '修正库位位置'}`,
          currentUser.real_name || currentUser.username);

        runInTx(`
          UPDATE inventory_discrepancies SET
            status = 'resolved',
            handler = ?,
            handler_id = ?,
            handled_at = datetime('now','localtime'),
            handler_remark = COALESCE(handler_remark, '') || ?,
            updated_at = datetime('now','localtime')
          WHERE id = ?
        `, [currentUser.real_name || currentUser.username, currentUser.id,
            `${currentUser.real_name || currentUser.username}: 位置已修正\n`, id]);

        addAuditLogInTx(req, 'correction', 'discrepancy', id,
          {
            sample_id: disp.sample_id,
            barcode: disp.barcode,
            discrepancy_type: disp.type,
            old_location_id: oldLocId,
            old_location_code: oldLoc ? oldLoc.code : null,
            sample_status: beforeSample.status
          },
          {
            sample_id: disp.sample_id,
            status: 'resolved',
            new_location_id: new_location_id,
            new_location_code: newLoc.code
          },
          `盘点纠错：修正样本位置，从 ${oldLoc ? oldLoc.code : '未知'} 到 ${newLoc.code}${remark ? '，备注：' + remark : ''}`);
      });
    } else if (action === 'ignore') {
      run(`
        UPDATE inventory_discrepancies SET
          status = 'ignored',
          handler = ?,
          handler_id = ?,
          handled_at = datetime('now','localtime'),
          handler_remark = COALESCE(handler_remark, '') || ?,
          updated_at = datetime('now','localtime')
        WHERE id = ?
      `, [currentUser.real_name || currentUser.username, currentUser.id,
          `${currentUser.real_name || currentUser.username}: 忽略，原因：${remark || '无'}\n`, id]);
      addAuditLog(req, 'correction', 'discrepancy', id,
        { status: disp.status, type: disp.type, barcode: disp.barcode },
        { status: 'ignored', handler: currentUser.real_name || currentUser.username },
        `盘点纠错：忽略差异，原因：${remark || '无'}`);
    } else if (action === 'register_extra' && disp.type === 'extra') {
      const existing = queryOne('SELECT id FROM samples WHERE barcode = ?', [disp.barcode]);
      if (existing) {
        return res.json({ success: false, error: '条码已存在，不能重复登记' });
      }
      const batchNo = req.body.batch_no || 'PD-BATCH-' + Date.now();
      const sampleName = req.body.name || '盘点补登样本';
      runTransaction(() => {
        const info = runInTx(`
          INSERT INTO samples (barcode, batch_no, name, status)
          VALUES (?, ?, ?, 'pending')
        `, [disp.barcode, batchNo, sampleName]);
        addTimelineInTx(info.lastInsertRowid, 'register', null, null,
          null, `盘点补登：${remark || '多扫样本补登'}`,
          currentUser.real_name || currentUser.username);
        runInTx(`
          UPDATE inventory_discrepancies SET
            status = 'resolved',
            sample_id = ?,
            handler = ?,
            handler_id = ?,
            handled_at = datetime('now','localtime'),
            handler_remark = COALESCE(handler_remark, '') || ?,
            updated_at = datetime('now','localtime')
          WHERE id = ?
        `, [info.lastInsertRowid,
            currentUser.real_name || currentUser.username, currentUser.id,
            `${currentUser.real_name || currentUser.username}: 已补登样本\n`, id]);
        addAuditLogInTx(req, 'correction', 'discrepancy', id,
          { status: disp.status, type: disp.type, barcode: disp.barcode },
          {
            status: 'resolved',
            sample_id: info.lastInsertRowid,
            barcode: disp.barcode,
            batch_no: batchNo,
            name: sampleName
          },
          `盘点纠错：补登样本 ${disp.barcode}${remark ? '，备注：' + remark : ''}`);
      });
    } else {
      return res.json({ success: false, error: '无效的处理操作' });
    }

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/discrepancies', requireAuth, (req, res) => {
  const { sample_id, barcode, status, inventory_order_id } = req.query;
  let sql = `
    SELECT id.*,
      io.order_no, io.title,
      sl_old.code as old_location_code, sl_old.name as old_location_name,
      sl_new.code as new_location_code, sl_new.name as new_location_name,
      s.batch_no, s.name as sample_name, s.status as sample_status
    FROM inventory_discrepancies id
    LEFT JOIN inventory_orders io ON id.inventory_order_id = io.id
    LEFT JOIN storage_locations sl_old ON id.old_location_id = sl_old.id
    LEFT JOIN storage_locations sl_new ON id.new_location_id = sl_new.id
    LEFT JOIN samples s ON id.sample_id = s.id
    WHERE 1=1
  `;
  const params = [];
  if (sample_id) {
    sql += ' AND id.sample_id = ?';
    params.push(sample_id);
  }
  if (barcode) {
    sql += ' AND id.barcode LIKE ?';
    params.push(`%${barcode}%`);
  }
  if (status && status !== 'all') {
    sql += ' AND id.status = ?';
    params.push(status);
  }
  if (inventory_order_id) {
    sql += ' AND id.inventory_order_id = ?';
    params.push(inventory_order_id);
  }
  sql += ' ORDER BY id.id DESC';
  const items = queryAll(sql, params);
  items.forEach(d => {
    d.type_label = DISCREPANCY_TYPE_LABELS[d.type] || d.type;
    d.status_label = DISCREPANCY_STATUS_LABELS[d.status] || d.status;
  });
  res.json({ success: true, data: items });
});

app.get('/api/samples/:id/reversable-actions', requireAdmin, (req, res) => {
  const { id } = req.params;
  const timeline = queryAll(`
    SELECT st.*,
      sl_from.code as from_code, sl_from.name as from_name,
      sl_to.code as to_code, sl_to.name as to_name
    FROM sample_timeline st
    LEFT JOIN storage_locations sl_from ON st.from_location_id = sl_from.id
    LEFT JOIN storage_locations sl_to ON st.to_location_id = sl_to.id
    WHERE st.sample_id = ?
      AND st.action_type IN ('transfer', 'scrapped')
      AND NOT EXISTS (SELECT 1 FROM action_reversals ar WHERE ar.original_timeline_id = st.id)
    ORDER BY st.id DESC
    LIMIT 5
  `, [id]);
  timeline.forEach(t => {
    t.action_label = ACTION_LABELS[t.action_type] || t.action_type;
  });
  res.json({ success: true, data: timeline });
});

app.post('/api/samples/:id/reverse/:timelineId', requireAdmin, (req, res) => {
  const { id, timelineId } = req.params;
  const { reason, remark } = req.body;

  if (!reason) {
    return res.json({ success: false, error: '请填写撤销原因' });
  }

  const original = queryOne('SELECT * FROM sample_timeline WHERE id = ? AND sample_id = ?', [timelineId, id]);
  if (!original) {
    return res.json({ success: false, error: '原操作记录不存在' });
  }

  const alreadyReversed = queryOne('SELECT id FROM action_reversals WHERE original_timeline_id = ?', [timelineId]);
  if (alreadyReversed) {
    return res.json({ success: false, error: '该操作已被撤销，不能重复撤销' });
  }

  if (original.action_type !== 'transfer' && original.action_type !== 'scrapped') {
    return res.json({ success: false, error: '只能撤销转移或报废操作' });
  }

  const sample = queryOne('SELECT * FROM samples WHERE id = ?', [id]);
  if (!sample) {
    return res.json({ success: false, error: '样本不存在' });
  }

  if (original.action_type === 'transfer') {
    if (sample.status !== 'in_storage') {
      return res.json({ success: false, error: '样本已出库或报废，无法撤销转移' });
    }
    if (sample.current_location_id !== original.to_location_id) {
      return res.json({ success: false, error: '样本位置已变更，无法撤销该次转移' });
    }

    const fromLoc = getLocationWithZone(original.from_location_id);
    if (!fromLoc) {
      return res.json({ success: false, error: '原位置不存在，无法撤销' });
    }

    const occupancy = getLocationOccupancy(original.from_location_id);
    if (occupancy >= fromLoc.capacity) {
      return res.json({ success: false, error: `原位置已满（容量${fromLoc.capacity}），无法撤销` });
    }

    try {
      let reversalTimelineId = null;
      const revFromLoc = getLocationWithZone(original.to_location_id);
      const revToLoc = getLocationWithZone(original.from_location_id);
      runTransaction(() => {
        runInTx(`
          UPDATE samples SET
            current_location_id = ?,
            updated_at = datetime('now','localtime')
          WHERE id = ?
        `, [original.from_location_id, id]);

        const tl = addTimelineInTx(id, 'reverse_transfer', original.to_location_id, original.from_location_id,
          null, `撤销转移：${reason}${remark ? ' - ' + remark : ''}`,
          currentUser.real_name || currentUser.username);
        reversalTimelineId = tl.lastInsertRowid;

        runInTx(`
          INSERT INTO action_reversals
          (original_timeline_id, sample_id, original_action_type, reversed_by, reversed_by_id,
           reason, reversal_remark, reversal_timeline_id)
          VALUES (?, ?, 'transfer', ?, ?, ?, ?, ?)
        `, [timelineId, id,
            currentUser.real_name || currentUser.username, currentUser.id,
            reason, remark || '', reversalTimelineId]);

        addAuditLogInTx(req, 'reverse', 'timeline', timelineId,
          {
            sample_id: id,
            original_action: 'transfer',
            from_location_id: original.to_location_id,
            from_location_code: revFromLoc ? revFromLoc.code : null
          },
          {
            sample_id: id,
            reversal_action: 'reverse_transfer',
            to_location_id: original.from_location_id,
            to_location_code: revToLoc ? revToLoc.code : null,
            reversal_timeline_id: reversalTimelineId
          },
          `撤销转移：从 ${revFromLoc ? revFromLoc.code : '未知'} 回退到 ${revToLoc ? revToLoc.code : '未知'}，原因：${reason}${remark ? ' - ' + remark : ''}`);
      });
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  } else if (original.action_type === 'scrapped') {
    if (sample.status !== 'scrapped') {
      return res.json({ success: false, error: '样本当前不是报废状态，无法撤销报废' });
    }
    if (!original.from_location_id) {
      return res.json({ success: false, error: '原位置信息丢失，无法撤销报废' });
    }

    const fromLoc = getLocationWithZone(original.from_location_id);
    if (!fromLoc) {
      return res.json({ success: false, error: '原位置不存在，无法撤销' });
    }

    const occupancy = getLocationOccupancy(original.from_location_id);
    if (occupancy >= fromLoc.capacity) {
      return res.json({ success: false, error: `原位置已满（容量${fromLoc.capacity}），无法撤销` });
    }

    try {
      let reversalTimelineId = null;
      const scrapRestoreLoc = getLocationWithZone(original.from_location_id);
      runTransaction(() => {
        runInTx(`
          UPDATE samples SET
            status = 'in_storage',
            current_location_id = ?,
            updated_at = datetime('now','localtime')
          WHERE id = ?
        `, [original.from_location_id, id]);

        const tl = addTimelineInTx(id, 'reverse_scrapped', null, original.from_location_id,
          null, `撤销报废：${reason}${remark ? ' - ' + remark : ''}`,
          currentUser.real_name || currentUser.username);
        reversalTimelineId = tl.lastInsertRowid;

        runInTx(`
          INSERT INTO action_reversals
          (original_timeline_id, sample_id, original_action_type, reversed_by, reversed_by_id,
           reason, reversal_remark, reversal_timeline_id)
          VALUES (?, ?, 'scrapped', ?, ?, ?, ?, ?)
        `, [timelineId, id,
            currentUser.real_name || currentUser.username, currentUser.id,
            reason, remark || '', reversalTimelineId]);

        addAuditLogInTx(req, 'reverse', 'timeline', timelineId,
          {
            sample_id: id,
            original_action: 'scrapped',
            status: 'scrapped'
          },
          {
            sample_id: id,
            reversal_action: 'reverse_scrapped',
            status: 'in_storage',
            location_id: original.from_location_id,
            location_code: scrapRestoreLoc ? scrapRestoreLoc.code : null,
            reversal_timeline_id: reversalTimelineId
          },
          `撤销报废：恢复到 ${scrapRestoreLoc ? scrapRestoreLoc.code : '未知'}，原因：${reason}${remark ? ' - ' + remark : ''}`);
      });
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  } else {
    res.json({ success: false, error: '不支持的撤销操作类型' });
  }
});

app.get('/api/history/search', requireAuth, (req, res) => {
  const { barcode, batch_no, inventory_order_id, start_date, end_date } = req.query;

  let samples = [];
  if (barcode) {
    samples = queryAll(`
      SELECT s.*, sl.code as location_code, tz.name as zone_name
      FROM samples s
      LEFT JOIN storage_locations sl ON s.current_location_id = sl.id
      LEFT JOIN temperature_zones tz ON sl.zone_id = tz.id
      WHERE s.barcode LIKE ?
      ORDER BY s.id DESC
    `, [`%${barcode}%`]);
  } else if (batch_no) {
    samples = queryAll(`
      SELECT s.*, sl.code as location_code, tz.name as zone_name
      FROM samples s
      LEFT JOIN storage_locations sl ON s.current_location_id = sl.id
      LEFT JOIN temperature_zones tz ON sl.zone_id = tz.id
      WHERE s.batch_no LIKE ?
      ORDER BY s.id DESC
    `, [`%${batch_no}%`]);
  }

  samples.forEach(s => {
    s.status_label = STATUS_LABELS[s.status] || s.status;
    s.timeline = getSampleTimeline(s.id);
    s.timeline.forEach(t => {
      t.action_label = ACTION_LABELS[t.action_type] || t.action_type;
    });

    s.discrepancies = queryAll(`
      SELECT id.*, io.order_no, io.title
      FROM inventory_discrepancies id
      LEFT JOIN inventory_orders io ON id.inventory_order_id = io.id
      WHERE id.sample_id = ?
      ORDER BY id.id DESC
    `, [s.id]);
    s.discrepancies.forEach(d => {
      d.type_label = DISCREPANCY_TYPE_LABELS[d.type] || d.type;
      d.status_label = DISCREPANCY_STATUS_LABELS[d.status] || d.status;
    });

    s.reversals = queryAll(`
      SELECT ar.*,
        ot.action_type as original_action,
        rt.action_type as reversal_action,
        ot.created_at as original_time,
        rt.created_at as reversal_time
      FROM action_reversals ar
      LEFT JOIN sample_timeline ot ON ar.original_timeline_id = ot.id
      LEFT JOIN sample_timeline rt ON ar.reversal_timeline_id = rt.id
      WHERE ar.sample_id = ?
      ORDER BY ar.id DESC
    `, [s.id]);
  });

  let orders = [];
  if (inventory_order_id) {
    orders = queryAll(`
      SELECT io.*, tz.name as zone_name, sl.code as location_code
      FROM inventory_orders io
      LEFT JOIN temperature_zones tz ON io.zone_id = tz.id
      LEFT JOIN storage_locations sl ON io.location_id = sl.id
      WHERE io.order_no LIKE ? OR io.id = ?
      ORDER BY io.id DESC
    `, [`%${inventory_order_id}%`, isNaN(inventory_order_id) ? 0 : parseInt(inventory_order_id)]);
  } else if (start_date || end_date) {
    let sql = `
      SELECT io.*, tz.name as zone_name, sl.code as location_code
      FROM inventory_orders io
      LEFT JOIN temperature_zones tz ON io.zone_id = tz.id
      LEFT JOIN storage_locations sl ON io.location_id = sl.id
      WHERE 1=1
    `;
    const params = [];
    if (start_date) {
      sql += ' AND date(io.created_at) >= date(?)';
      params.push(start_date);
    }
    if (end_date) {
      sql += ' AND date(io.created_at) <= date(?)';
      params.push(end_date);
    }
    sql += ' ORDER BY io.id DESC LIMIT 100';
    orders = queryAll(sql, params);
  }

  orders.forEach(o => {
    o.status_label = INVENTORY_STATUS_LABELS[o.status] || o.status;
  });

  res.json({
    success: true,
    data: {
      samples,
      inventory_orders: orders
    }
  });
});

function buildAuditLogQuery(req, forExport = false) {
  const { operator, action_type, start_date, end_date, object_type, keyword, page, page_size, from, to, operator_id } = req.query;

  let sql = `
    SELECT al.*,
      u.username as operator_username
    FROM audit_log al
    LEFT JOIN users u ON al.operator_id = u.id
    WHERE 1=1
  `;
  const params = [];

  if (operator) {
    sql += ' AND (al.operator_name LIKE ? OR u.username LIKE ?)';
    params.push(`%${operator}%`, `%${operator}%`);
  }
  if (operator_id) {
    sql += ' AND al.operator_id = ?';
    params.push(parseInt(operator_id));
  }
  if (action_type && action_type !== 'all') {
    sql += ' AND al.action_type = ?';
    params.push(action_type);
  }
  if (object_type && object_type !== 'all') {
    sql += ' AND al.object_type = ?';
    params.push(object_type);
  }
  if (from) {
    sql += ' AND al.created_at >= ?';
    params.push(from);
  }
  if (to) {
    sql += ' AND al.created_at <= ?';
    params.push(to);
  }
  if (start_date) {
    sql += ' AND date(al.created_at) >= date(?)';
    params.push(start_date);
  }
  if (end_date) {
    sql += ' AND date(al.created_at) <= date(?)';
    params.push(end_date);
  }
  if (keyword) {
    sql += ' AND (al.remark LIKE ? OR al.object_id LIKE ? OR al.before_value LIKE ? OR al.after_value LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  if (forExport) {
    sql += ' ORDER BY al.id DESC';
    return { sql, params };
  }

  const pageNum = parseInt(page) || 1;
  const size = parseInt(page_size) || 20;
  const offset = (pageNum - 1) * size;

  const countSql = `SELECT COUNT(*) as total FROM (${sql}) AS sub`;
  const total = queryOne(countSql, params) ? queryOne(countSql, params).total : 0;

  sql += ' ORDER BY al.id DESC LIMIT ? OFFSET ?';
  params.push(size, offset);

  return { sql, params, total, page: pageNum, page_size: size };
}

function formatAuditLogRows(rows) {
  return rows.map(r => {
    const result = { ...r };
    result.action_label = AUDIT_ACTION_LABELS[r.action_type] || r.action_type;
    result.object_label = AUDIT_OBJECT_LABELS[r.object_type] || r.object_type;
    try {
      result.before_value_parsed = r.before_value ? JSON.parse(r.before_value) : null;
    } catch { result.before_value_parsed = null; }
    try {
      result.after_value_parsed = r.after_value ? JSON.parse(r.after_value) : null;
    } catch { result.after_value_parsed = null; }
    return result;
  });
}

app.get('/api/audit-log', requireAdmin, (req, res) => {
  try {
    const query = buildAuditLogQuery(req, false);
    const rows = queryAll(query.sql, query.params);
    const formatted = formatAuditLogRows(rows);
    res.json({
      success: true,
      data: {
        list: formatted,
        total: query.total,
        page: query.page,
        page_size: query.page_size
      }
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/audit-log/export/csv', requireAdmin, (req, res) => {
  try {
    const query = buildAuditLogQuery(req, true);
    const rows = queryAll(query.sql, query.params);
    const formatted = formatAuditLogRows(rows);

    const header = [
      '时间', '操作人', 'IP地址', '操作类型', '操作对象', '对象ID',
      '操作前值', '操作后值', '备注'
    ];
    const lines = [header.join(',')];

    formatted.forEach(r => {
      let beforeVal = '';
      let afterVal = '';
      try {
        if (r.before_value) {
          beforeVal = typeof r.before_value_parsed === 'object' && r.before_value_parsed
            ? JSON.stringify(r.before_value_parsed) : r.before_value;
        }
      } catch {}
      try {
        if (r.after_value) {
          afterVal = typeof r.after_value_parsed === 'object' && r.after_value_parsed
            ? JSON.stringify(r.after_value_parsed) : r.after_value;
        }
      } catch {}

      lines.push([
        `"${r.created_at || ''}"`,
        `"${r.operator_name || ''}"`,
        `"${r.ip_address || ''}"`,
        `"${r.action_label || r.action_type || ''}"`,
        `"${r.object_label || r.object_type || ''}"`,
        `"${r.object_id || ''}"`,
        `"${beforeVal.replace(/"/g, '""')}"`,
        `"${afterVal.replace(/"/g, '""')}"`,
        `"${(r.remark || '').replace(/"/g, '""')}"`
      ].join(','));
    });

    const csv = '\ufeff' + lines.join('\r\n');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit_log_${timestamp}.csv"`);
    res.send(csv);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/user-zone-access', requireAdmin, (req, res) => {
  const { user_id } = req.query;
  let sql = 'SELECT uza.*, u.username, u.real_name, tz.name as zone_name FROM user_zone_access uza LEFT JOIN users u ON uza.user_id = u.id LEFT JOIN temperature_zones tz ON uza.zone_id = tz.id WHERE 1=1';
  const params = [];
  if (user_id) {
    sql += ' AND uza.user_id = ?';
    params.push(user_id);
  }
  sql += ' ORDER BY uza.user_id, uza.zone_id';
  res.json({ success: true, data: queryAll(sql, params) });
});

app.post('/api/user-zone-access', requireAdmin, (req, res) => {
  const { user_id, zone_id } = req.body;
  if (!user_id || !zone_id) {
    return res.json({ success: false, error: 'user_id 和 zone_id 必填' });
  }
  try {
    run('INSERT OR IGNORE INTO user_zone_access (user_id, zone_id) VALUES (?, ?)', [user_id, zone_id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/batches/summary', requireAuth, (req, res) => {
  try {
    const { batch_no } = req.query;
    let sql = `
      SELECT
        s.batch_no,
        COUNT(*) AS total,
        SUM(CASE WHEN s.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN s.status = 'in_storage' THEN 1 ELSE 0 END) AS in_storage_count,
        SUM(CASE WHEN s.status = 'outbound' THEN 1 ELSE 0 END) AS outbound_count,
        SUM(CASE WHEN s.status = 'scrapped' THEN 1 ELSE 0 END) AS scrapped_count,
        MIN(s.created_at) AS first_registered_at,
        MAX(s.updated_at) AS last_operated_at
      FROM samples s
    `;
    const params = [];
    const conditions = [];
    if (batch_no) {
      conditions.push('s.batch_no = ?');
      params.push(batch_no);
    }
    const accessibleZones = getAccessibleZoneIds();
    if (accessibleZones !== null) {
      if (accessibleZones.length === 0) {
        return res.json({ success: true, data: [] });
      }
      conditions.push('(s.required_zone_id IN (' + accessibleZones.map(() => '?').join(',') + ')' +
        ' OR EXISTS (SELECT 1 FROM storage_locations sl2 WHERE sl2.id = s.current_location_id AND sl2.zone_id IN (' + accessibleZones.map(() => '?').join(',') + ')))');
      params.push(...accessibleZones, ...accessibleZones);
    }
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' GROUP BY s.batch_no ORDER BY s.batch_no';
    const rows = queryAll(sql, params);
    res.json({ success: true, data: rows });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 批量状态变更
app.post('/api/batches/:batchNo/transition', requireWrite, (req, res) => {
  const { batchNo } = req.params;
  const { from_status, to_status, remark, location_id } = req.body;

  if (!from_status || !to_status) {
    return res.json({ success: false, error: 'from_status 和 to_status 必填' });
  }

  const validStatuses = ['pending', 'in_storage', 'outbound', 'scrapped', 'reserved_outbound'];
  if (!validStatuses.includes(from_status)) {
    return res.json({ success: false, error: `无效的源状态: ${from_status}` });
  }
  if (!validStatuses.includes(to_status)) {
    return res.json({ success: false, error: `无效的目标状态: ${to_status}` });
  }
  if (from_status === to_status) {
    return res.json({ success: false, error: '源状态和目标状态不能相同' });
  }

  // 并发控制：检查是否有正在进行的同批次变更
  if (batchTransitionLocks.has(batchNo)) {
    return res.status(409).json({
      success: false,
      error: '该批次正在进行批量状态变更，请稍后再试',
      conflict: true
    });
  }

  // 加锁
  batchTransitionLocks.set(batchNo, true);

  try {
    const operator = currentUser.real_name || currentUser.username;
    let changedCount = 0;
    let failedCount = 0;
    const errors = [];

    // 先查询该批次源状态的样本列表
    const samples = queryAll(`
      SELECT s.*, sl.code as location_code
      FROM samples s
      LEFT JOIN storage_locations sl ON s.current_location_id = sl.id
      WHERE s.batch_no = ? AND s.status = ?
    `, [batchNo, from_status]);

    if (samples.length === 0) {
      batchTransitionLocks.delete(batchNo);
      return res.json({
        success: true,
        data: {
          changed: 0,
          failed: 0,
          errors: [],
          remark: '该批次没有符合源状态的记录'
        }
      });
    }

    // 权限检查
    const accessibleZones = getAccessibleZoneIds();
    if (accessibleZones !== null) {
      for (const sample of samples) {
        if (!canAccessSample(sample.id)) {
          failedCount++;
          errors.push(`样本 ${sample.barcode}: 无操作权限`);
        }
      }
      if (failedCount > 0 && failedCount === samples.length) {
        batchTransitionLocks.delete(batchNo);
        return res.json({
          success: false,
          error: '所有样本均无操作权限',
          data: { changed: 0, failed: failedCount, errors }
        });
      }
    }

    // 如果目标状态是 in_storage 且指定了 location_id，验证库位
    if (to_status === 'in_storage' && location_id) {
      const loc = getLocationWithZone(location_id);
      if (!loc) {
        batchTransitionLocks.delete(batchNo);
        return res.json({ success: false, error: '目标库位不存在' });
      }
      if (!canAccessLocation(location_id)) {
        batchTransitionLocks.delete(batchNo);
        return res.json({ success: false, error: '无权操作目标库位所属温区', forbidden: true });
      }
      const occupancy = getLocationOccupancy(location_id);
      const targetSamples = samples.filter(s => canAccessSample(s.id));
      if (occupancy + targetSamples.length -
          samples.filter(s => s.status === 'in_storage' && s.current_location_id === location_id).length
          > loc.capacity) {
        batchTransitionLocks.delete(batchNo);
        return res.json({ success: false, error: `目标库位容量不足（容量${loc.capacity}）` });
      }
    }

    runTransaction(() => {
      for (const sample of samples) {
        if (accessibleZones !== null && !canAccessSample(sample.id)) {
          continue;
        }

        const beforeSample = { ...sample };

        // 构建更新 SQL
        let updateSql = `
          UPDATE samples SET
            status = ?,
            updated_at = datetime('now','localtime')
        `;
        const updateParams = [to_status];

        // 根据目标状态处理库位
        if (to_status === 'outbound' || to_status === 'scrapped') {
          updateSql += ', current_location_id = NULL';
        } else if (to_status === 'in_storage' && location_id) {
          updateSql += ', current_location_id = ?';
          updateParams.push(location_id);
        }

        updateSql += ' WHERE id = ?';
        updateParams.push(sample.id);

        runInTx(updateSql, updateParams);

        // 记录时间线
        let actionType = 'transfer';
        if (to_status === 'in_storage') actionType = 'inbound';
        else if (to_status === 'outbound') actionType = 'outbound';
        else if (to_status === 'scrapped') actionType = 'scrapped';
        else if (to_status === 'pending') actionType = 'register';

        const fromLocId = sample.current_location_id;
        const toLocId = (to_status === 'in_storage' && location_id) ? location_id :
                        (to_status === 'in_storage' ? sample.current_location_id : null);

        addTimelineInTx(sample.id, actionType, fromLocId, toLocId, null,
          remark || `批量状态变更: ${from_status} → ${to_status}`, operator);

        // 记录审计日志
        addAuditLogInTx(req, 'batch_transition', 'sample', sample.id,
          { status: beforeSample.status, location_id: beforeSample.current_location_id, location_code: beforeSample.location_code },
          { status: to_status, location_id: toLocId },
          `批次 ${batchNo} 批量状态变更: ${from_status} → ${to_status}${remark ? '，备注: ' + remark : ''}`);

        changedCount++;
      }
    });

    // 记录批次级别的审计日志
    addAuditLog(req, 'batch_transition', 'sample_import_batch', batchNo,
      { batch_no: batchNo, from_status, total_samples: samples.length },
      { batch_no: batchNo, to_status, changed: changedCount, failed: failedCount },
      `批次 ${batchNo} 批量状态变更完成: ${from_status} → ${to_status}，成功 ${changedCount} 条，失败 ${failedCount} 条`);

    batchTransitionLocks.delete(batchNo);

    res.json({
      success: true,
      data: {
        changed: changedCount,
        failed: failedCount,
        errors,
        from_status,
        to_status
      }
    });

  } catch (e) {
    batchTransitionLocks.delete(batchNo);
    res.json({ success: false, error: e.message });
  }
});

app.delete('/api/user-zone-access/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  run('DELETE FROM user_zone_access WHERE id = ?', [id]);
  res.json({ success: true });
});

function generateReservationNo() {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `YY${dateStr}${random}`;
}

function expireOverdueReservations() {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const expired = queryAll(`
    SELECT * FROM sample_reservations
    WHERE status IN ('draft', 'confirmed')
    AND end_time < ?
  `, [now]);

  if (expired.length === 0) return 0;

  let count = 0;
  runTransaction(() => {
    for (const r of expired) {
      runInTx(`
        UPDATE sample_reservations
        SET status = 'expired', expired_at = datetime('now','localtime'),
            updated_at = datetime('now','localtime')
        WHERE id = ?
      `, [r.id]);
      insertAuditLogInTx({
        operator_id: null,
        operator_name: 'system',
        ip_address: '127.0.0.1',
        action_type: 'reservation_expire',
        object_type: 'sample_reservation',
        object_id: String(r.id),
        before_value: { reservation_no: r.reservation_no, status: r.status, end_time: r.end_time },
        after_value: { reservation_no: r.reservation_no, status: 'expired' },
        remark: `预约单 ${r.reservation_no} 已过期自动取消（到期时间: ${r.end_time}）`
      });
      count++;
    }
  });
  return count;
}

function checkReservationConflict(batchNo, startTime, endTime, excludeId) {
  let sql = `
    SELECT * FROM sample_reservations
    WHERE batch_no = ?
    AND status IN ('draft', 'confirmed')
    AND start_time < ?
    AND end_time > ?
  `;
  const params = [batchNo, endTime, startTime];
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  return queryAll(sql, params);
}

app.post('/api/reservations', requireAuth, (req, res) => {
  const { batch_no, quantity, start_time, end_time, remark } = req.body;

  if (!batch_no) return res.json({ success: false, error: '批次号必填' });
  if (!quantity || quantity <= 0) return res.json({ success: false, error: '预约数量必须大于0' });
  if (!start_time) return res.json({ success: false, error: '使用开始时间必填' });
  if (!end_time) return res.json({ success: false, error: '使用结束时间必填' });
  if (start_time >= end_time) return res.json({ success: false, error: '开始时间必须早于结束时间' });

  const conflicts = checkReservationConflict(batch_no, start_time, end_time, null);
  if (conflicts.length > 0) {
    return res.json({
      success: false,
      error: `该批次在指定时段已有预约（${conflicts.map(c => c.reservation_no).join(', ')}）`,
      conflicts
    });
  }

  const reservationNo = generateReservationNo();
  try {
    const info = run(`
      INSERT INTO sample_reservations
      (reservation_no, batch_no, quantity, reserver_name, reserver_id, start_time, end_time, status, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)
    `, [reservationNo, batch_no, quantity,
        currentUser.real_name || currentUser.username,
        currentUser.id, start_time, end_time, remark || '']);

    addAuditLog(req, 'reservation_create', 'sample_reservation', String(info.lastInsertRowid),
      null,
      { reservation_no: reservationNo, batch_no, quantity, start_time, end_time, status: 'draft' },
      `创建预约单 ${reservationNo}：批次 ${batch_no}，数量 ${quantity}，时段 ${start_time} ~ ${end_time}`);

    res.json({ success: true, data: { id: info.lastInsertRowid, reservation_no: reservationNo } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/reservations', requireAuth, (req, res) => {
  const { status, batch_no, keyword } = req.query;

  expireOverdueReservations();

  let sql = `
    SELECT sr.*,
      (SELECT COUNT(*) FROM samples s WHERE s.batch_no = sr.batch_no AND s.status = 'in_storage') as available_stock
    FROM sample_reservations sr
    WHERE 1=1
  `;
  const params = [];

  if (currentUser.role !== 'admin') {
    sql += ' AND sr.reserver_id = ?';
    params.push(currentUser.id);
  }

  if (status && status !== 'all') {
    sql += ' AND sr.status = ?';
    params.push(status);
  }
  if (batch_no) {
    sql += ' AND sr.batch_no = ?';
    params.push(batch_no);
  }
  if (keyword) {
    sql += ' AND (sr.reservation_no LIKE ? OR sr.batch_no LIKE ? OR sr.reserver_name LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  sql += ' ORDER BY sr.id DESC';

  const rows = queryAll(sql, params);
  rows.forEach(r => {
    r.status_label = RESERVATION_STATUS_LABELS[r.status] || r.status;
  });

  res.json({ success: true, data: rows });
});

app.get('/api/reservations/conflicts', requireAuth, (req, res) => {
  const { batch_no, start_time, end_time } = req.query;

  if (!batch_no) return res.json({ success: false, error: '批次号必填' });
  if (!start_time) return res.json({ success: false, error: '开始时间必填' });
  if (!end_time) return res.json({ success: false, error: '结束时间必填' });

  const conflicts = checkReservationConflict(batch_no, start_time, end_time, null);
  conflicts.forEach(r => {
    r.status_label = RESERVATION_STATUS_LABELS[r.status] || r.status;
  });

  res.json({ success: true, data: conflicts });
});

app.get('/api/reservations/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const reservation = queryOne('SELECT * FROM sample_reservations WHERE id = ?', [id]);
  if (!reservation) return res.json({ success: false, error: '预约单不存在' });

  if (currentUser.role !== 'admin' && reservation.reserver_id !== currentUser.id) {
    return res.json({ success: false, error: '无权查看此预约单', forbidden: true });
  }

  reservation.status_label = RESERVATION_STATUS_LABELS[reservation.status] || reservation.status;

  const stockRow = queryOne(`
    SELECT COUNT(*) as cnt FROM samples
    WHERE batch_no = ? AND status = 'in_storage'
  `, [reservation.batch_no]);
  reservation.available_stock = stockRow ? stockRow.cnt : 0;

  res.json({ success: true, data: reservation });
});

app.put('/api/reservations/:id/confirm', requireAuth, (req, res) => {
  const { id } = req.params;
  const { remark } = req.body;

  expireOverdueReservations();

  const reservation = queryOne('SELECT * FROM sample_reservations WHERE id = ?', [id]);
  if (!reservation) return res.json({ success: false, error: '预约单不存在' });

  if (currentUser.role !== 'admin' && reservation.reserver_id !== currentUser.id) {
    return res.json({ success: false, error: '无权操作此预约单', forbidden: true });
  }

  if (reservation.status !== 'draft') {
    return res.json({ success: false, error: `预约单当前状态为"${RESERVATION_STATUS_LABELS[reservation.status]}"，只有草稿状态才能确认` });
  }

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  if (reservation.end_time < now) {
    return res.json({ success: false, error: '预约时段已过期，无法确认' });
  }

  const conflicts = checkReservationConflict(reservation.batch_no, reservation.start_time, reservation.end_time, id);
  if (conflicts.length > 0) {
    return res.json({
      success: false,
      error: `该批次在相同时段已有其他预约（${conflicts.map(c => c.reservation_no).join(', ')}）`,
      conflicts
    });
  }

  const stockRow = queryOne(`
    SELECT COUNT(*) as cnt FROM samples
    WHERE batch_no = ? AND status = 'in_storage'
  `, [reservation.batch_no]);
  const availableStock = stockRow ? stockRow.cnt : 0;

  if (availableStock < reservation.quantity) {
    return res.json({
      success: false,
      error: `批次 ${reservation.batch_no} 在库数量不足：需要 ${reservation.quantity}，当前在库 ${availableStock}`,
      available_stock: availableStock,
      required_quantity: reservation.quantity
    });
  }

  const beforeStatus = reservation.status;
  try {
    runTransaction(() => {
      runInTx(`
        UPDATE sample_reservations
        SET status = 'confirmed', confirmed_at = datetime('now','localtime'),
            updated_at = datetime('now','localtime'), remark = COALESCE(remark, '') || ?
        WHERE id = ?
      `, [remark ? ` [确认] ${remark}` : '', id]);
    });

    addAuditLog(req, 'reservation_confirm', 'sample_reservation', String(id),
      { reservation_no: reservation.reservation_no, status: beforeStatus },
      { reservation_no: reservation.reservation_no, status: 'confirmed', available_stock: availableStock, required_quantity: reservation.quantity },
      `确认预约单 ${reservation.reservation_no}：批次 ${reservation.batch_no}，在库 ${availableStock}，预约 ${reservation.quantity}`);

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.put('/api/reservations/:id/use', requireAuth, (req, res) => {
  const { id } = req.params;
  const { remark } = req.body;

  expireOverdueReservations();

  const reservation = queryOne('SELECT * FROM sample_reservations WHERE id = ?', [id]);
  if (!reservation) return res.json({ success: false, error: '预约单不存在' });

  if (currentUser.role !== 'admin' && reservation.reserver_id !== currentUser.id) {
    return res.json({ success: false, error: '无权操作此预约单', forbidden: true });
  }

  if (reservation.status !== 'confirmed') {
    return res.json({ success: false, error: `预约单当前状态为"${RESERVATION_STATUS_LABELS[reservation.status]}"，只有已确认状态才能使用` });
  }

  const stockRow = queryOne(`
    SELECT COUNT(*) as cnt FROM samples
    WHERE batch_no = ? AND status = 'in_storage'
  `, [reservation.batch_no]);
  const availableStock = stockRow ? stockRow.cnt : 0;

  if (availableStock < reservation.quantity) {
    return res.json({
      success: false,
      error: `批次 ${reservation.batch_no} 在库数量不足：需要 ${reservation.quantity}，当前在库 ${availableStock}`,
      available_stock: availableStock,
      required_quantity: reservation.quantity
    });
  }

  const operator = currentUser.real_name || currentUser.username;
  const beforeStatus = reservation.status;
  let usedSampleIds = [];

  try {
    runTransaction(() => {
      const samples = queryAll(`
        SELECT * FROM samples
        WHERE batch_no = ? AND status = 'in_storage'
        ORDER BY id
        LIMIT ?
      `, [reservation.batch_no, reservation.quantity]);

      for (const sample of samples) {
        const beforeSample = { ...sample };
        runInTx(`
          UPDATE samples SET status = 'reserved_outbound', current_location_id = NULL,
          updated_at = datetime('now','localtime')
          WHERE id = ?
        `, [sample.id]);

        addTimelineInTx(sample.id, 'reserved_outbound', sample.current_location_id, null, null,
          `预约出库：预约单 ${reservation.reservation_no}${remark ? ' - ' + remark : ''}`, operator);

        addAuditLogInTx(req, 'outbound', 'sample', String(sample.id),
          { status: beforeSample.status, current_location_id: beforeSample.current_location_id },
          { status: 'reserved_outbound', current_location_id: null, reservation_no: reservation.reservation_no },
          `预约出库：预约单 ${reservation.reservation_no}`);
        usedSampleIds.push(sample.id);
      }

      runInTx(`
        UPDATE sample_reservations
        SET status = 'used', used_at = datetime('now','localtime'),
            updated_at = datetime('now','localtime'), remark = COALESCE(remark, '') || ?
        WHERE id = ?
      `, [remark ? ` [使用] ${remark}` : '', id]);
    });

    addAuditLog(req, 'reservation_use', 'sample_reservation', String(id),
      { reservation_no: reservation.reservation_no, status: beforeStatus },
      { reservation_no: reservation.reservation_no, status: 'used', used_samples: usedSampleIds.length },
      `使用预约单 ${reservation.reservation_no}：标记 ${usedSampleIds.length} 条样本为已预约出库`);

    res.json({ success: true, data: { used_count: usedSampleIds.length } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.put('/api/reservations/:id/cancel', requireAuth, (req, res) => {
  const { id } = req.params;
  const { remark } = req.body;

  const reservation = queryOne('SELECT * FROM sample_reservations WHERE id = ?', [id]);
  if (!reservation) return res.json({ success: false, error: '预约单不存在' });

  if (currentUser.role !== 'admin' && reservation.reserver_id !== currentUser.id) {
    return res.json({ success: false, error: '无权操作此预约单', forbidden: true });
  }

  if (!['draft', 'confirmed'].includes(reservation.status)) {
    return res.json({ success: false, error: `预约单当前状态为"${RESERVATION_STATUS_LABELS[reservation.status]}"，只有草稿或已确认状态才能取消` });
  }

  const beforeStatus = reservation.status;
  try {
    runTransaction(() => {
      runInTx(`
        UPDATE sample_reservations
        SET status = 'cancelled', cancelled_at = datetime('now','localtime'),
            updated_at = datetime('now','localtime'), remark = COALESCE(remark, '') || ?
        WHERE id = ?
      `, [remark ? ` [取消] ${remark}` : '', id]);
    });

    addAuditLog(req, 'reservation_cancel', 'sample_reservation', String(id),
      { reservation_no: reservation.reservation_no, status: beforeStatus },
      { reservation_no: reservation.reservation_no, status: 'cancelled' },
      `取消预约单 ${reservation.reservation_no}${remark ? '：' + remark : ''}`);

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

function generateBorrowingNo() {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `LY${dateStr}${random}`;
}

function markOverdueBorrowings() {
  const today = new Date().toISOString().substring(0, 10);
  const overdue = queryAll(`
    SELECT * FROM sample_borrowings
    WHERE status = 'borrowed'
    AND expected_return_date < ?
  `, [today]);

  if (overdue.length === 0) return 0;

  let count = 0;
  runTransaction(() => {
    for (const b of overdue) {
      runInTx(`
        UPDATE sample_borrowings
        SET status = 'overdue', overdue_marked_at = datetime('now','localtime'),
            updated_at = datetime('now','localtime')
        WHERE id = ?
      `, [b.id]);
      insertAuditLogInTx({
        operator_id: null,
        operator_name: 'system',
        ip_address: '127.0.0.1',
        action_type: 'borrowing_overdue',
        object_type: 'sample_borrowing',
        object_id: String(b.id),
        before_value: { borrowing_no: b.borrowing_no, status: 'borrowed', expected_return_date: b.expected_return_date },
        after_value: { borrowing_no: b.borrowing_no, status: 'overdue' },
        remark: `领用单 ${b.borrowing_no} 已逾期（应还日期: ${b.expected_return_date}）`
      });
      count++;
    }
  });
  return count;
}

app.post('/api/borrowings', requireWrite, (req, res) => {
  const { sample_barcode, expected_return_date, purpose, remark, borrower_id } = req.body;

  if (!sample_barcode) return res.json({ success: false, error: '样本条码必填' });
  if (!expected_return_date) return res.json({ success: false, error: '预计归还日期必填' });

  let targetBorrowerId = currentUser.id;
  let targetBorrowerName = currentUser.real_name || currentUser.username;

  if (borrower_id != null && currentUser.role === 'admin') {
    const borrowerUser = queryOne('SELECT * FROM users WHERE id = ?', [parseInt(borrower_id)]);
    if (!borrowerUser) {
      return res.json({ success: false, error: `指定的领用人不存在（id=${borrower_id}）` });
    }
    targetBorrowerId = borrowerUser.id;
    targetBorrowerName = borrowerUser.real_name || borrowerUser.username;
  }

  const sample = queryOne('SELECT * FROM samples WHERE barcode = ?', [sample_barcode]);
  if (!sample) return res.json({ success: false, error: '样本不存在' });

  if (sample.status !== 'in_storage') {
    return res.json({ success: false, error: `样本当前状态为"${STATUS_LABELS[sample.status] || sample.status}"，只有"在库"状态才能领用` });
  }

  const activeBorrowing = queryOne(`
    SELECT * FROM sample_borrowings
    WHERE sample_barcode = ? AND status IN ('draft', 'borrowed', 'overdue')
  `, [sample_barcode]);
  if (activeBorrowing) {
    return res.json({
      success: false,
      error: `样本 ${sample_barcode} 已有未归还的领用单（${activeBorrowing.borrowing_no}，状态: ${BORROWING_STATUS_LABELS[activeBorrowing.status]}）`,
      existing_borrowing: activeBorrowing
    });
  }

  const borrowingNo = generateBorrowingNo();
  try {
    const info = run(`
      INSERT INTO sample_borrowings
      (borrowing_no, sample_id, sample_barcode, borrower_name, borrower_id,
       expected_return_date, purpose, status, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)
    `, [borrowingNo, sample.id, sample_barcode,
        targetBorrowerName, targetBorrowerId,
        expected_return_date, purpose || '', remark || '']);

    addAuditLog(req, 'borrowing_create', 'sample_borrowing', String(info.lastInsertRowid),
      null,
      { borrowing_no: borrowingNo, sample_barcode, expected_return_date, purpose, status: 'draft',
        borrower_id: targetBorrowerId, borrower_name: targetBorrowerName },
      `创建领用单 ${borrowingNo}：样本 ${sample_barcode}，领用人 ${targetBorrowerName}，预计归还 ${expected_return_date}`);

    res.json({ success: true, data: { id: info.lastInsertRowid, borrowing_no: borrowingNo } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/borrowings', requireAuth, (req, res) => {
  const { status, sample_barcode, keyword } = req.query;

  markOverdueBorrowings();

  let sql = `
    SELECT sb.*,
      s.name as sample_name, s.status as sample_status, s.batch_no,
      sl.code as current_location_code,
      rl.code as return_location_code, rl.name as return_location_name
    FROM sample_borrowings sb
    LEFT JOIN samples s ON sb.sample_id = s.id
    LEFT JOIN storage_locations sl ON s.current_location_id = sl.id
    LEFT JOIN storage_locations rl ON sb.return_location_id = rl.id
    WHERE 1=1
  `;
  const params = [];

  if (currentUser.role !== 'admin') {
    sql += ' AND sb.borrower_id = ?';
    params.push(currentUser.id);
  }

  if (status && status !== 'all') {
    sql += ' AND sb.status = ?';
    params.push(status);
  }
  if (sample_barcode) {
    sql += ' AND sb.sample_barcode LIKE ?';
    params.push(`%${sample_barcode}%`);
  }
  if (keyword) {
    sql += ' AND (sb.borrowing_no LIKE ? OR sb.sample_barcode LIKE ? OR sb.borrower_name LIKE ? OR sb.purpose LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  sql += ' ORDER BY sb.id DESC';

  const rows = queryAll(sql, params);
  rows.forEach(r => {
    r.status_label = BORROWING_STATUS_LABELS[r.status] || r.status;
  });

  res.json({ success: true, data: rows });
});

app.get('/api/borrowings/overdue', requireAuth, (req, res) => {
  markOverdueBorrowings();

  let sql = `
    SELECT sb.*,
      s.name as sample_name, s.status as sample_status, s.batch_no,
      sl.code as current_location_code
    FROM sample_borrowings sb
    LEFT JOIN samples s ON sb.sample_id = s.id
    LEFT JOIN storage_locations sl ON s.current_location_id = sl.id
    WHERE sb.status IN ('borrowed', 'overdue')
    AND sb.expected_return_date < date('now', 'localtime')
  `;
  const params = [];

  if (currentUser.role !== 'admin') {
    sql += ' AND sb.borrower_id = ?';
    params.push(currentUser.id);
  }

  sql += ' ORDER BY sb.expected_return_date ASC';

  const rows = queryAll(sql, params);
  rows.forEach(r => {
    r.status_label = BORROWING_STATUS_LABELS[r.status] || r.status;
  });

  res.json({ success: true, data: rows });
});

app.get('/api/borrowings/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const borrowing = queryOne('SELECT * FROM sample_borrowings WHERE id = ?', [id]);
  if (!borrowing) return res.json({ success: false, error: '领用单不存在' });

  if (currentUser.role !== 'admin' && borrowing.borrower_id !== currentUser.id) {
    return res.json({ success: false, error: '无权查看此领用单', forbidden: true });
  }

  borrowing.status_label = BORROWING_STATUS_LABELS[borrowing.status] || borrowing.status;

  const sample = queryOne(`
    SELECT s.*, sl.code as location_code, sl.name as location_name,
      tz.name as zone_name, rz.name as required_zone_name
    FROM samples s
    LEFT JOIN storage_locations sl ON s.current_location_id = sl.id
    LEFT JOIN temperature_zones tz ON sl.zone_id = tz.id
    LEFT JOIN temperature_zones rz ON s.required_zone_id = rz.id
    WHERE s.id = ?
  `, [borrowing.sample_id]);
  borrowing.sample_detail = sample;

  if (borrowing.return_location_id) {
    const returnLoc = queryOne(`
      SELECT sl.*, tz.name as zone_name
      FROM storage_locations sl
      LEFT JOIN temperature_zones tz ON sl.zone_id = tz.id
      WHERE sl.id = ?
    `, [borrowing.return_location_id]);
    borrowing.return_location_detail = returnLoc;
  }

  res.json({ success: true, data: borrowing });
});

app.put('/api/borrowings/:id/borrow', requireWrite, (req, res) => {
  const { id } = req.params;
  const { remark } = req.body;

  const borrowing = queryOne('SELECT * FROM sample_borrowings WHERE id = ?', [id]);
  if (!borrowing) return res.json({ success: false, error: '领用单不存在' });

  if (currentUser.role !== 'admin' && borrowing.borrower_id !== currentUser.id) {
    return res.json({ success: false, error: '无权操作此领用单', forbidden: true });
  }

  if (borrowing.status !== 'draft') {
    return res.json({ success: false, error: `领用单当前状态为"${BORROWING_STATUS_LABELS[borrowing.status] || borrowing.status}"，只有草稿状态才能确认借出` });
  }

  const sample = queryOne('SELECT * FROM samples WHERE id = ?', [borrowing.sample_id]);
  if (!sample) return res.json({ success: false, error: '关联样本不存在' });
  if (sample.status !== 'in_storage') {
    return res.json({ success: false, error: `样本当前状态为"${STATUS_LABELS[sample.status] || sample.status}"，不是在库状态，无法借出` });
  }

  const activeCheck = queryOne(`
    SELECT * FROM sample_borrowings
    WHERE sample_barcode = ? AND status IN ('draft', 'borrowed', 'overdue') AND id != ?
  `, [borrowing.sample_barcode, id]);
  if (activeCheck) {
    return res.json({ success: false, error: `样本 ${borrowing.sample_barcode} 已有其他未归还的领用单（${activeCheck.borrowing_no}）` });
  }

  const operator = currentUser.real_name || currentUser.username;
  const beforeStatus = borrowing.status;

  try {
    runTransaction(() => {
      const fromLocId = sample.current_location_id;

      runInTx(`
        UPDATE samples SET status = 'borrowed', current_location_id = NULL,
        updated_at = datetime('now','localtime')
        WHERE id = ?
      `, [sample.id]);

      addTimelineInTx(sample.id, 'borrow_out', fromLocId, null, null,
        `领用出库：领用单 ${borrowing.borrowing_no}${remark ? ' - ' + remark : ''}`, operator);

      addAuditLogInTx(req, 'outbound', 'sample', String(sample.id),
        { status: sample.status, current_location_id: fromLocId },
        { status: 'borrowed', current_location_id: null, borrowing_no: borrowing.borrowing_no },
        `领用出库：领用单 ${borrowing.borrowing_no}`);

      runInTx(`
        UPDATE sample_borrowings
        SET status = 'borrowed', borrowed_at = datetime('now','localtime'),
            updated_at = datetime('now','localtime'), remark = COALESCE(remark, '') || ?
        WHERE id = ?
      `, [remark ? ` [确认借出] ${remark}` : '', id]);
    });

    addAuditLog(req, 'borrowing_borrow', 'sample_borrowing', String(id),
      { borrowing_no: borrowing.borrowing_no, status: beforeStatus, sample_barcode: borrowing.sample_barcode },
      { borrowing_no: borrowing.borrowing_no, status: 'borrowed' },
      `确认借出领用单 ${borrowing.borrowing_no}：样本 ${borrowing.sample_barcode}`);

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.put('/api/borrowings/:id/return', requireWrite, (req, res) => {
  const { id } = req.params;
  const { return_location_id, sample_condition, return_remark } = req.body;

  if (!return_location_id) return res.json({ success: false, error: '归还库位必填' });
  if (!sample_condition) return res.json({ success: false, error: '样本状态必填（完好/损坏/遗失）' });

  const validConditions = ['完好', '损坏', '遗失'];
  if (!validConditions.includes(sample_condition)) {
    return res.json({ success: false, error: `样本状态无效，可选值：${validConditions.join('/')}` });
  }

  const borrowing = queryOne('SELECT * FROM sample_borrowings WHERE id = ?', [id]);
  if (!borrowing) return res.json({ success: false, error: '领用单不存在' });

  if (currentUser.role !== 'admin' && borrowing.borrower_id !== currentUser.id) {
    return res.json({ success: false, error: '无权操作此领用单', forbidden: true });
  }

  if (!['borrowed', 'overdue'].includes(borrowing.status)) {
    return res.json({ success: false, error: `领用单当前状态为"${BORROWING_STATUS_LABELS[borrowing.status] || borrowing.status}"，只有已借出或逾期状态才能归还` });
  }

  const sample = queryOne('SELECT * FROM samples WHERE id = ?', [borrowing.sample_id]);
  if (!sample) return res.json({ success: false, error: '关联样本不存在' });

  const returnLoc = getLocationWithZone(return_location_id);
  if (!returnLoc) return res.json({ success: false, error: '归还库位不存在' });
  if (!canAccessLocation(return_location_id)) {
    return res.json({ success: false, error: '无权操作该归还库位所属温区', forbidden: true });
  }

  if (sample_condition === '完好' || sample_condition === '损坏') {
    const occupancy = getLocationOccupancy(return_location_id);
    if (occupancy >= returnLoc.capacity) {
      return res.json({ success: false, error: `归还库位已满（容量${returnLoc.capacity}）` });
    }
    if (sample.required_zone_id && returnLoc.zone_id !== sample.required_zone_id) {
      return res.json({ success: false, error: `温区不匹配：样本应放${sample.required_zone_name || '指定温区'}，归还库位属于${returnLoc.zone_name}`, warning: true });
    }
  }

  const operator = currentUser.real_name || currentUser.username;
  const beforeStatus = borrowing.status;

  try {
    runTransaction(() => {
      let newSampleStatus;
      let newLocationId = null;

      if (sample_condition === '完好') {
        newSampleStatus = 'in_storage';
        newLocationId = return_location_id;
      } else if (sample_condition === '损坏') {
        newSampleStatus = 'scrapped';
        newLocationId = null;
      } else {
        newSampleStatus = 'lost';
        newLocationId = null;
      }

      const beforeSample = { ...sample };
      runInTx(`
        UPDATE samples SET status = ?, current_location_id = ?,
        updated_at = datetime('now','localtime')
        WHERE id = ?
      `, [newSampleStatus, newLocationId, sample.id]);

      let timelineAction = 'borrow_return';
      let timelineRemark = `领用归还：领用单 ${borrowing.borrowing_no}，样本状态=${sample_condition}${return_remark ? ' - ' + return_remark : ''}`;

      if (sample_condition === '损坏') {
        timelineAction = 'scrapped';
        timelineRemark = `领用归还-损坏报废：领用单 ${borrowing.borrowing_no}${return_remark ? ' - ' + return_remark : ''}`;
      } else if (sample_condition === '遗失') {
        timelineRemark = `领用归还-遗失：领用单 ${borrowing.borrowing_no}${return_remark ? ' - ' + return_remark : ''}`;
      }

      addTimelineInTx(sample.id, timelineAction, null, newLocationId, null, timelineRemark, operator);

      addAuditLogInTx(req, sample_condition === '损坏' ? 'scrap' : (sample_condition === '遗失' ? 'outbound' : 'inbound'), 'sample', String(sample.id),
        { status: beforeSample.status, current_location_id: beforeSample.current_location_id },
        { status: newSampleStatus, current_location_id: newLocationId, location_code: returnLoc.code, sample_condition, borrowing_no: borrowing.borrowing_no },
        `领用归还：样本${sample_condition}，领用单 ${borrowing.borrowing_no}`);

      runInTx(`
        UPDATE sample_borrowings
        SET status = 'returned',
            return_location_id = ?,
            return_sample_condition = ?,
            return_remark = ?,
            returned_at = datetime('now','localtime'),
            returned_by = ?,
            returned_by_id = ?,
            updated_at = datetime('now','localtime'),
            remark = COALESCE(remark, '') || ?
        WHERE id = ?
      `, [return_location_id, sample_condition, return_remark || '',
          operator, currentUser.id,
          return_remark ? ` [归还] ${return_remark}` : '', id]);
    });

    addAuditLog(req, 'borrowing_return', 'sample_borrowing', String(id),
      { borrowing_no: borrowing.borrowing_no, status: beforeStatus, sample_barcode: borrowing.sample_barcode },
      { borrowing_no: borrowing.borrowing_no, status: 'returned', sample_condition, return_location_id },
      `归还领用单 ${borrowing.borrowing_no}：样本 ${borrowing.sample_barcode}，状态=${sample_condition}`);

    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`冷链样本追踪系统已启动: http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
