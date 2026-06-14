const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'tracker.db');

let db = null;
let SQL = null;
let inTransaction = false;

function saveDatabase() {
  if (!db || inTransaction) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  } catch (e) {
    console.error('保存数据库失败:', e);
  }
}

async function initDatabase() {
  SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    try {
      const buf = fs.readFileSync(dbPath);
      db = new SQL.Database(buf);
    } catch (e) {
      console.warn('读取数据库文件失败，将创建新库:', e.message);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  try { db.run(`PRAGMA foreign_keys = ON`); } catch(e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS temperature_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      min_temp REAL NOT NULL,
      max_temp REAL NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS storage_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      zone_id INTEGER NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 10,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT NOT NULL UNIQUE,
      batch_no TEXT NOT NULL,
      name TEXT,
      required_zone_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      current_location_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sample_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      from_location_id INTEGER,
      to_location_id INTEGER,
      temperature REAL,
      remark TEXT,
      operator TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'warehouse',
      real_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS inventory_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'zone',
      zone_id INTEGER,
      location_id INTEGER,
      status TEXT NOT NULL DEFAULT 'draft',
      total_expected INTEGER DEFAULT 0,
      total_scanned INTEGER DEFAULT 0,
      total_matched INTEGER DEFAULT 0,
      total_extra INTEGER DEFAULT 0,
      total_missing INTEGER DEFAULT 0,
      total_mislocated INTEGER DEFAULT 0,
      total_outbound_scanned INTEGER DEFAULT 0,
      operator TEXT NOT NULL,
      operator_id INTEGER,
      remark TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      completed_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_order_id INTEGER NOT NULL,
      barcode TEXT NOT NULL,
      scanned_location_code TEXT,
      scan_time TEXT,
      sample_id INTEGER,
      expected_location_id INTEGER,
      expected_location_code TEXT,
      match_status TEXT NOT NULL DEFAULT 'pending',
      discrepancy_type TEXT,
      discrepancy_note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS inventory_discrepancies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_order_id INTEGER NOT NULL,
      inventory_item_id INTEGER,
      sample_id INTEGER,
      barcode TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      old_status TEXT,
      old_location_id INTEGER,
      new_status TEXT,
      new_location_id INTEGER,
      handler_remark TEXT,
      handler TEXT,
      handler_id INTEGER,
      handled_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS action_reversals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_timeline_id INTEGER NOT NULL,
      sample_id INTEGER NOT NULL,
      original_action_type TEXT NOT NULL,
      reversed_by TEXT NOT NULL,
      reversed_by_id INTEGER,
      reason TEXT NOT NULL,
      reversal_remark TEXT,
      reversal_timeline_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      operator_id INTEGER,
      operator_name TEXT,
      ip_address TEXT,
      action_type TEXT NOT NULL,
      object_type TEXT,
      object_id TEXT,
      before_value TEXT,
      after_value TEXT,
      remark TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_zone_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      zone_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(user_id, zone_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sample_import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      total_rows INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'processing',
      operator_id INTEGER,
      operator_name TEXT,
      ip_address TEXT,
      remark TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sample_import_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      row_number INTEGER NOT NULL,
      barcode TEXT,
      batch_no TEXT,
      name TEXT,
      required_zone TEXT,
      status TEXT NOT NULL,
      failure_reason TEXT,
      sample_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS inventory_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_key TEXT NOT NULL UNIQUE,
      config_value TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS item_threshold (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_name TEXT NOT NULL UNIQUE,
      threshold INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sample_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_no TEXT NOT NULL UNIQUE,
      batch_no TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      reserver_name TEXT NOT NULL,
      reserver_id INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      remark TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      confirmed_at TEXT,
      used_at TEXT,
      cancelled_at TEXT,
      expired_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sample_borrowings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      borrowing_no TEXT NOT NULL UNIQUE,
      sample_id INTEGER NOT NULL,
      sample_barcode TEXT NOT NULL,
      borrower_name TEXT NOT NULL,
      borrower_id INTEGER NOT NULL,
      expected_return_date TEXT NOT NULL,
      purpose TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      remark TEXT,
      borrowed_at TEXT,
      return_location_id INTEGER,
      return_sample_condition TEXT,
      return_remark TEXT,
      returned_at TEXT,
      returned_by TEXT,
      returned_by_id INTEGER,
      overdue_marked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  try {
    db.run(`CREATE INDEX IF NOT EXISTS idx_sample_borrowings_no ON sample_borrowings(borrowing_no)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sample_borrowings_barcode ON sample_borrowings(sample_barcode)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sample_borrowings_status ON sample_borrowings(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sample_borrowings_borrower ON sample_borrowings(borrower_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sample_borrowings_expected_return ON sample_borrowings(expected_return_date)`);
  } catch(e) {}

  try {
    db.run(`CREATE INDEX IF NOT EXISTS idx_sample_reservations_no ON sample_reservations(reservation_no)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sample_reservations_batch ON sample_reservations(batch_no)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sample_reservations_status ON sample_reservations(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sample_reservations_reserver ON sample_reservations(reserver_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sample_reservations_time ON sample_reservations(start_time, end_time)`);
  } catch(e) {}

  try {
    db.run(`CREATE INDEX IF NOT EXISTS idx_samples_barcode ON samples(barcode)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_samples_status ON samples(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_timeline_sample_id ON sample_timeline(sample_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_timeline_action ON sample_timeline(action_type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_locations_zone ON storage_locations(zone_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_inventory_orders_status ON inventory_orders(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_inventory_orders_type ON inventory_orders(type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_inventory_items_order ON inventory_items(inventory_order_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_inventory_items_barcode ON inventory_items(barcode)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_discrepancies_order ON inventory_discrepancies(inventory_order_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_discrepancies_sample ON inventory_discrepancies(sample_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_discrepancies_status ON inventory_discrepancies(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_reversals_sample ON action_reversals(sample_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_reversals_original ON action_reversals(original_timeline_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_audit_log_operator ON audit_log(operator_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action_type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_audit_log_object ON audit_log(object_type, object_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_user_zone_access_user ON user_zone_access(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_user_zone_access_zone ON user_zone_access(zone_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_import_batches_status ON sample_import_batches(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_import_results_batch ON sample_import_results(batch_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_inventory_config_key ON inventory_config(config_key)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_item_threshold_name ON item_threshold(item_name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sample_borrowings_no ON sample_borrowings(borrowing_no)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sample_borrowings_barcode ON sample_borrowings(sample_barcode)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sample_borrowings_status ON sample_borrowings(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sample_borrowings_borrower ON sample_borrowings(borrower_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sample_borrowings_expected_return ON sample_borrowings(expected_return_date)`);
  } catch(e) {}

  const zoneCount = db.exec('SELECT COUNT(*) as cnt FROM temperature_zones')[0].values[0][0];
  if (zoneCount === 0) {
    db.run(`INSERT INTO temperature_zones (name, min_temp, max_temp, description) VALUES ('冷藏(2-8℃)', 2, 8, '标准冷藏温区')`);
    db.run(`INSERT INTO temperature_zones (name, min_temp, max_temp, description) VALUES ('冷冻(-20℃)', -25, -15, '低温冷冻温区')`);
    db.run(`INSERT INTO temperature_zones (name, min_temp, max_temp, description) VALUES ('深冻(-80℃)', -90, -70, '超低温深冻温区')`);
    db.run(`INSERT INTO temperature_zones (name, min_temp, max_temp, description) VALUES ('常温(15-25℃)', 15, 25, '室温保存温区')`);
  }

  const locCount = db.exec('SELECT COUNT(*) as cnt FROM storage_locations')[0].values[0][0];
  if (locCount === 0) {
    const zones = queryAll('SELECT id, name FROM temperature_zones');
    const zoneMap = {};
    zones.forEach(z => { zoneMap[z.name] = z.id; });
    db.run(`INSERT INTO storage_locations (code, name, zone_id, capacity, description) VALUES ('R-A1', '冷藏区A架1层', ${zoneMap['冷藏(2-8℃)']}, 20, '冷藏库位')`);
    db.run(`INSERT INTO storage_locations (code, name, zone_id, capacity, description) VALUES ('R-A2', '冷藏区A架2层', ${zoneMap['冷藏(2-8℃)']}, 20, '冷藏库位')`);
    db.run(`INSERT INTO storage_locations (code, name, zone_id, capacity, description) VALUES ('F-B1', '冷冻区B架1层', ${zoneMap['冷冻(-20℃)']}, 15, '冷冻库位')`);
    db.run(`INSERT INTO storage_locations (code, name, zone_id, capacity, description) VALUES ('F-B2', '冷冻区B架2层', ${zoneMap['冷冻(-20℃)']}, 15, '冷冻库位')`);
    db.run(`INSERT INTO storage_locations (code, name, zone_id, capacity, description) VALUES ('D-C1', '深冻区C架1层', ${zoneMap['深冻(-80℃)']}, 10, '深冻库位')`);
    db.run(`INSERT INTO storage_locations (code, name, zone_id, capacity, description) VALUES ('N-D1', '常温区D架1层', ${zoneMap['常温(15-25℃)']}, 30, '常温库位')`);
  }

  // 每个用户单独检查（用 INSERT OR IGNORE 语义），新老数据库都能补齐缺失账号
  function ensureUser(username, password, role, real_name) {
    const cnt = db.exec(`SELECT COUNT(*) as cnt FROM users WHERE username='${username}'`)[0].values[0][0];
    if (cnt !== 0) return; // 已存在就跳过
    db.run(
      `INSERT INTO users (username, password, role, real_name) VALUES (?, ?, ?, ?)`,
      [username, password, role, real_name]
    );
  }
  ensureUser('admin', 'admin123', 'admin', '系统管理员');
  ensureUser('warehouse', 'wh123', 'warehouse', '仓库管理员');
  ensureUser('manager', 'mgr123', 'admin', '部门经理');
  ensureUser('viewer', 'view123', 'viewer', '只读用户');

  // 初始化两个库管员账号用于验收
  ensureUser('wh_cold', 'whcold123', 'warehouse', '冷藏库管员');
  ensureUser('wh_frozen', 'whfrozen123', 'warehouse', '冷冻库管员');

  // 给库管员默认绑定温区（验收场景：冷藏库管员绑冷藏，冷冻库管员绑冷冻）
  function ensureUserZone(username, zoneName) {
    const userRow = db.exec(`SELECT id FROM users WHERE username='${username}'`);
    if (!userRow || userRow[0].values.length === 0) return;
    const userId = userRow[0].values[0][0];
    const zoneRow = db.exec(`SELECT id FROM temperature_zones WHERE name='${zoneName.replace(/'/g, "''")}'`);
    if (!zoneRow || zoneRow[0].values.length === 0) return;
    const zoneId = zoneRow[0].values[0][0];
    const exists = db.exec(`SELECT COUNT(*) as cnt FROM user_zone_access WHERE user_id=${userId} AND zone_id=${zoneId}`)[0].values[0][0];
    if (exists === 0) {
      db.run(`INSERT OR IGNORE INTO user_zone_access (user_id, zone_id) VALUES (${userId}, ${zoneId})`);
    }
  }
  ensureUserZone('wh_cold', '冷藏(2-8℃)');
  ensureUserZone('wh_frozen', '冷冻(-20℃)');
  // 默认 warehouse 账号绑所有温区（保持兼容性）
  ensureUserZone('warehouse', '冷藏(2-8℃)');
  ensureUserZone('warehouse', '冷冻(-20℃)');
  ensureUserZone('warehouse', '深冻(-80℃)');
  ensureUserZone('warehouse', '常温(15-25℃)');

  // 初始化库存配置：默认低库存阈值
  const defaultThreshold = db.exec("SELECT COUNT(*) as cnt FROM inventory_config WHERE config_key='default_low_stock_threshold'")[0].values[0][0];
  if (defaultThreshold === 0) {
    db.run(`INSERT INTO inventory_config (config_key, config_value) VALUES ('default_low_stock_threshold', '10')`);
  }

  saveDatabase();
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params && params.length > 0) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function getLastInsertId() {
  const r = db.exec('SELECT last_insert_rowid() as id');
  return r && r[0] && r[0].values[0] ? r[0].values[0][0] : 0;
}

function getChanges() {
  const r = db.exec('SELECT changes() as c');
  return r && r[0] && r[0].values[0] ? r[0].values[0][0] : 0;
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params && params.length > 0) stmt.bind(params);
  stmt.step();
  stmt.free();
  const result = {
    lastInsertRowid: getLastInsertId(),
    changes: getChanges()
  };
  saveDatabase();
  return result;
}

function runExec(sql) {
  db.run(sql);
  const result = {
    lastInsertRowid: getLastInsertId(),
    changes: getChanges()
  };
  saveDatabase();
  return result;
}

function beginTransaction() {
  db.run('BEGIN TRANSACTION');
  inTransaction = true;
}

function commitTransaction() {
  db.run('COMMIT');
  inTransaction = false;
  saveDatabase();
}

function rollbackTransaction() {
  try { db.run('ROLLBACK'); } catch(e) {}
  inTransaction = false;
}

function runTransaction(fn) {
  beginTransaction();
  try {
    fn();
    commitTransaction();
    return true;
  } catch (e) {
    rollbackTransaction();
    throw e;
  }
}

function runInTx(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params && params.length > 0) stmt.bind(params);
  stmt.step();
  stmt.free();
  return {
    lastInsertRowid: getLastInsertId(),
    changes: getChanges()
  };
}

function getLastInsertIdInTx() {
  return getLastInsertId();
}

function insertAuditLog(params) {
  const {
    operator_id, operator_name, ip_address, action_type,
    object_type, object_id, before_value, after_value, remark
  } = params;
  return run(`
    INSERT INTO audit_log
    (operator_id, operator_name, ip_address, action_type,
     object_type, object_id, before_value, after_value, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    operator_id || null,
    operator_name || null,
    ip_address || null,
    action_type,
    object_type || null,
    object_id != null ? String(object_id) : null,
    before_value != null ? JSON.stringify(before_value) : null,
    after_value != null ? JSON.stringify(after_value) : null,
    remark || null
  ]);
}

function insertAuditLogInTx(params) {
  const {
    operator_id, operator_name, ip_address, action_type,
    object_type, object_id, before_value, after_value, remark
  } = params;
  return runInTx(`
    INSERT INTO audit_log
    (operator_id, operator_name, ip_address, action_type,
     object_type, object_id, before_value, after_value, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    operator_id || null,
    operator_name || null,
    ip_address || null,
    action_type,
    object_type || null,
    object_id != null ? String(object_id) : null,
    before_value != null ? JSON.stringify(before_value) : null,
    after_value != null ? JSON.stringify(after_value) : null,
    remark || null
  ]);
}

function getUserZoneIds(userId) {
  if (!userId) return [];
  const rows = queryAll('SELECT zone_id FROM user_zone_access WHERE user_id = ?', [userId]);
  return rows.map(r => r.zone_id);
}

function getUserZoneIdsInTx(userId) {
  if (!userId) return [];
  const rows = queryAll('SELECT zone_id FROM user_zone_access WHERE user_id = ?', [userId]);
  return rows.map(r => r.zone_id);
}

function closeDatabase() {
  if (!db) return;
  try {
    if (!inTransaction) {
      saveDatabase();
    }
    db.close();
    db = null;
    SQL = null;
  } catch (e) {
    console.error('关闭数据库失败:', e.message);
  }
}

let shutdownInProgress = false;
function gracefulShutdown(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`\n收到 ${signal}，正在优雅关闭...`);
  try {
    closeDatabase();
    console.log('数据库已安全关闭');
  } catch (e) {
    console.error('关闭出错:', e.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('beforeExit', () => {
  if (!shutdownInProgress) {
    try { closeDatabase(); } catch (e) {}
  }
});

module.exports = {
  initDatabase,
  closeDatabase,
  queryAll,
  queryOne,
  run,
  runExec,
  runTransaction,
  runInTx,
  beginTransaction,
  commitTransaction,
  rollbackTransaction,
  getLastInsertIdInTx,
  insertAuditLog,
  insertAuditLogInTx,
  getUserZoneIds,
  getUserZoneIdsInTx
};
