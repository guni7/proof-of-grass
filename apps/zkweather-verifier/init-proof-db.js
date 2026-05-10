const Database = require("better-sqlite3");

const db = new Database("zkweather.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS proof_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    start_reading_id INTEGER NOT NULL,
    end_reading_id INTEGER NOT NULL,
    merkle_root TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    min_count INTEGER NOT NULL,
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    status TEXT NOT NULL,
    proof_path TEXT,
    vk_path TEXT,
    batch_path TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_proof_jobs_batch
  ON proof_jobs(device_id, start_reading_id, end_reading_id);
`);

console.log("Proof DB tables ready.");