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

  try {
    db.run(`CREATE INDEX IF NOT EXISTS idx_samples_barcode ON samples(barcode)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_samples_status ON samples(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_timeline_sample_id ON sample_timeline(sample_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_timeline_action ON sample_timeline(action_type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_locations_zone ON storage_locations(zone_id)`);
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

module.exports = {
  initDatabase,
  queryAll,
  queryOne,
  run,
  runExec,
  runTransaction,
  runInTx,
  beginTransaction,
  commitTransaction,
  rollbackTransaction
};
