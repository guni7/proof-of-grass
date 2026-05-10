const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const db = new Database("zkweather.db");

const DEVICE_ID = "esp8266-daaa2c";
const WINDOW_SIZE = 5;

// For testing, because your humidity is around 429.
const THRESHOLD = 420;
const MIN_COUNT = 3;

const rows = db.prepare(`
  SELECT *
  FROM readings
  WHERE device_id = ?
  ORDER BY id DESC
  LIMIT ?
`).all(DEVICE_ID, WINDOW_SIZE);

if (rows.length < WINDOW_SIZE) {
  throw new Error(`Need ${WINDOW_SIZE} readings, got ${rows.length}`);
}

const ordered = rows.reverse();

const humidities = ordered.map((r) => r.humidity_x10);
const timestamps = ordered.map((r) => r.timestamp);

const windowStart = Math.min(...timestamps);
const windowEnd = Math.max(...timestamps);

// Optional: allow a small buffer around readings.
const WINDOW_BUFFER_SECONDS = 30;

const publicWindowStart = windowStart - WINDOW_BUFFER_SECONDS;
const publicWindowEnd = windowEnd + WINDOW_BUFFER_SECONDS;

const batchJson = JSON.stringify(
  ordered.map((r) => ({
    id: r.id,
    device_id: r.device_id,
    nonce: r.nonce,
    timestamp: r.timestamp,
    temperature_c_x10: r.temperature_c_x10,
    humidity_x10: r.humidity_x10,
    firmware_hash: r.firmware_hash,
    message_hash: r.message_hash,
  }))
);

const batchHash = crypto
  .createHash("sha256")
  .update(batchJson)
  .digest("hex");

const proverToml = `humidity_readings = [${humidities.join(", ")}]
timestamps = [${timestamps.join(", ")}]
threshold = ${THRESHOLD}
min_count = ${MIN_COUNT}
window_start = ${publicWindowStart}
window_end = ${publicWindowEnd}
`;

const batchMetadata = {
  device_id: DEVICE_ID,
  threshold: THRESHOLD,
  min_count: MIN_COUNT,
  window_size: WINDOW_SIZE,
  window_start: publicWindowStart,
  window_end: publicWindowEnd,
  batch_hash: batchHash,
  readings: ordered,
};

fs.writeFileSync(
  path.join("batch.json"),
  JSON.stringify(batchMetadata, null, 2)
);

fs.writeFileSync(
  path.join("..", "zkweather_threshold", "Prover.toml"),
  proverToml
);

console.log("Selected readings:");
for (const r of ordered) {
  console.log(
    `id=${r.id}, nonce=${r.nonce}, ts=${r.timestamp}, humidity=${r.humidity_x10}, temp=${r.temperature_c_x10}`
  );
}

console.log();
console.log("Batch hash:", batchHash);
console.log("Wrote batch.json");
console.log("Wrote ../zkweather_threshold/Prover.toml");
console.log();
console.log(proverToml);