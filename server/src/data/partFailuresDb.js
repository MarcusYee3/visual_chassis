import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'part_failures.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS part_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_number TEXT NOT NULL,
    part_id TEXT NOT NULL,
    part_label TEXT NOT NULL,
    check_name TEXT,
    source TEXT,
    raw_detail TEXT,
    logged_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_part_failures_sn_part ON part_failures (serial_number, part_id);
`);

// Prior loggings of this exact SN + specific faulted part (e.g. "cable-9-4", "psu-port-2"),
// newest first — used to drive the "already logged, are you sure?" confirmation.
export function findExisting(serialNumber, partId) {
  return db.prepare(
    'SELECT * FROM part_failures WHERE serial_number = ? AND part_id = ? ORDER BY logged_at DESC'
  ).all(serialNumber, partId);
}

export function logFailure({ serialNumber, partId, partLabel, checkName, source, rawDetail }) {
  const info = db.prepare(`
    INSERT INTO part_failures (serial_number, part_id, part_label, check_name, source, raw_detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(serialNumber, partId, partLabel, checkName || null, source || null, rawDetail || null);
  return db.prepare('SELECT * FROM part_failures WHERE id = ?').get(info.lastInsertRowid);
}

export function getAllFailures() {
  return db.prepare('SELECT * FROM part_failures ORDER BY logged_at DESC').all();
}
