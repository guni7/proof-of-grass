const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const db = new Database("zkweather.db");

const DEVICE_ID = "esp8266-daaa2c";
const WINDOW_SIZE = 5;

// Testing threshold: 42.0% humidity.
// Later change to 800 for 80.0%.
const THRESHOLD = 420;
const MIN_COUNT = 3;

const rows = db.prepare(`
  SELECT humidity_x10
  FROM readings
  WHERE device_id = ?
  ORDER BY id DESC
  LIMIT ?
`).all(DEVICE_ID, WINDOW_SIZE);

if (rows.length < WINDOW_SIZE) {
  throw new Error(`Need ${WINDOW_SIZE} readings, only got ${rows.length}`);
}

// Oldest-to-newest makes debugging easier.
const humidities = rows.reverse().map((r) => r.humidity_x10);

const toml = `humidity_readings = [${humidities.join(", ")}]
threshold = ${THRESHOLD}
min_count = ${MIN_COUNT}
`;

const outPath = path.join(
  "..",
  "zkweather_threshold",
  "Prover.toml"
);

fs.writeFileSync(outPath, toml);

console.log("Wrote Noir Prover.toml:");
console.log(toml);