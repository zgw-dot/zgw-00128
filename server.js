const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const { initDatabase, queryAll, queryOne, run, runExec, runTransaction, runInTx } = require('./db');

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
  scrapped: '已报废'
};

const ACTION_LABELS = {
  register: '登记',
  inbound: '入库',
  transfer: '转移',
  outbound: '出库',
  scrapped: '报废',
  temp_exception: '温控异常'
};

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

app.get('/api/zones', (req, res) => {
  const zones = queryAll('SELECT * FROM temperature_zones ORDER BY id');
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
  const locations = queryAll(`
    SELECT sl.*, tz.name as zone_name, tz.min_temp, tz.max_temp
    FROM storage_locations sl
    LEFT JOIN temperature_zones tz ON sl.zone_id = tz.id
    ORDER BY sl.code
  `);
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

app.post('/api/samples', (req, res) => {
  const { barcode, batch_no, name, required_zone_id, operator } = req.body;
  if (!barcode || !batch_no) {
    return res.json({ success: false, error: '条码和批次号必填' });
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

app.post('/api/samples/:id/inbound', (req, res) => {
  const { id } = req.params;
  const { location_id, operator, remark } = req.body;
  if (!location_id) {
    return res.json({ success: false, error: '请选择入库库位' });
  }
  const sample = queryOne('SELECT * FROM samples WHERE id=?', [id]);
  if (!sample) {
    return res.json({ success: false, error: '样本不存在' });
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

  try {
    runTransaction(() => {
      runInTx(`
        UPDATE samples SET status='in_storage', current_location_id=?,
        updated_at=datetime('now','localtime') WHERE id=?
      `, [location_id, id]);
      addTimelineInTx(id, 'inbound', null, location_id, null, remark || '', operator || 'system');
    });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/samples/:id/transfer', (req, res) => {
  const { id } = req.params;
  const { to_location_id, operator, remark } = req.body;
  if (!to_location_id) {
    return res.json({ success: false, error: '请选择目标库位' });
  }
  const sample = queryOne('SELECT * FROM samples WHERE id=?', [id]);
  if (!sample) {
    return res.json({ success: false, error: '样本不存在' });
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
  try {
    runTransaction(() => {
      runInTx(`
        UPDATE samples SET current_location_id=?,
        updated_at=datetime('now','localtime') WHERE id=?
      `, [to_location_id, id]);
      addTimelineInTx(id, 'transfer', fromId, to_location_id, null, remark || '', operator || 'system');
    });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/samples/:id/outbound', (req, res) => {
  const { id } = req.params;
  const { operator, remark } = req.body;
  const sample = queryOne('SELECT * FROM samples WHERE id=?', [id]);
  if (!sample) {
    return res.json({ success: false, error: '样本不存在' });
  }
  if (sample.status === 'scrapped') {
    return res.json({ success: false, error: '样本已报废，无法出库' });
  }
  if (sample.status !== 'in_storage') {
    return res.json({ success: false, error: '样本未入库或已出库，无法执行出库操作' });
  }

  const fromId = sample.current_location_id;
  try {
    runTransaction(() => {
      runInTx(`
        UPDATE samples SET status='outbound', current_location_id=NULL,
        updated_at=datetime('now','localtime') WHERE id=?
      `, [id]);
      addTimelineInTx(id, 'outbound', fromId, null, null, remark || '', operator || 'system');
    });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/samples/:id/scrap', (req, res) => {
  const { id } = req.params;
  const { operator, remark } = req.body;
  const sample = queryOne('SELECT * FROM samples WHERE id=?', [id]);
  if (!sample) {
    return res.json({ success: false, error: '样本不存在' });
  }
  if (sample.status === 'scrapped') {
    return res.json({ success: false, error: '样本已报废' });
  }

  const fromId = sample.current_location_id;
  try {
    runTransaction(() => {
      runInTx(`
        UPDATE samples SET status='scrapped', current_location_id=NULL,
        updated_at=datetime('now','localtime') WHERE id=?
      `, [id]);
      addTimelineInTx(id, 'scrapped', fromId, null, null, remark || '样本报废', operator || 'system');
    });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/samples/:id/temp-exception', (req, res) => {
  const { id } = req.params;
  const { temperature, remark, operator } = req.body;
  if (temperature === undefined || temperature === null || temperature === '') {
    return res.json({ success: false, error: '请填写异常温度值' });
  }
  const sample = queryOne('SELECT * FROM samples WHERE id=?', [id]);
  if (!sample) {
    return res.json({ success: false, error: '样本不存在' });
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
  const statusMap = { pending: '待入库', in_storage: '在库', outbound: '已出库', scrapped: '已报废' };
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

app.post('/api/samples/import/csv', (req, res) => {
  const { rows, operator } = req.body;
  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    return res.json({ success: false, error: '导入数据为空' });
  }
  const results = { success: 0, failed: 0, errors: [] };
  const getZoneByName = (name) => queryOne('SELECT id FROM temperature_zones WHERE name=?', [name]);

  rows.forEach((row, idx) => {
    const barcode = ((row.barcode || row['条码']) || '').trim();
    const batch_no = ((row.batch_no || row['批次号']) || '').trim();
    const name = ((row.name || row['名称']) || '').trim();
    const zoneName = ((row.required_zone || row['要求温区']) || '').trim();
    if (!barcode || !batch_no) {
      results.failed++;
      results.errors.push(`第${idx+1}行: 条码和批次号必填`);
      return;
    }
    if (queryOne('SELECT id FROM samples WHERE barcode=?', [barcode])) {
      results.failed++;
      results.errors.push(`第${idx+1}行: 条码 ${barcode} 已存在，跳过`);
      return;
    }
    let zoneId = null;
    if (zoneName) {
      const z = getZoneByName(zoneName);
      if (z) zoneId = z.id;
    }
    try {
      const info = run(`
        INSERT INTO samples (barcode, batch_no, name, required_zone_id, status)
        VALUES (?, ?, ?, ?, 'pending')
      `, [barcode, batch_no, name, zoneId]);
      addTimeline(info.lastInsertRowid, 'register', null, null, null, '批量导入登记', operator || 'system');
      results.success++;
    } catch (e) {
      results.failed++;
      results.errors.push(`第${idx+1}行: 插入失败 - ${e.message}`);
    }
  });
  res.json({ success: true, data: results });
});

app.get('/api/dashboard/stats', (req, res) => {
  const total = queryOne('SELECT COUNT(*) as cnt FROM samples').cnt;
  const inStorage = queryOne("SELECT COUNT(*) as cnt FROM samples WHERE status='in_storage'").cnt;
  const pending = queryOne("SELECT COUNT(*) as cnt FROM samples WHERE status='pending'").cnt;
  const outbound = queryOne("SELECT COUNT(*) as cnt FROM samples WHERE status='outbound'").cnt;
  const scrapped = queryOne("SELECT COUNT(*) as cnt FROM samples WHERE status='scrapped'").cnt;

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
      total, inStorage, pending, outbound, scrapped,
      tempExceptions, zoneMismatch,
      fullLocations,
      recentRisks
    }
  });
});

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`冷链样本追踪系统已启动: http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
