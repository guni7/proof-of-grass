const Database = require("better-sqlite3");

const db = new Database("zkweather.db");

const DEVICE_ID = "esp8266-daaa2c";

// For testing, use 420 because your humidity is currently around 429.
// Later set this to 800 for 80.0%.
const HUMIDITY_THRESHOLD_X10 = 420;

const WINDOW_SIZE = 5;
const MIN_COUNT = 3;

const rows = db.prepare(`
  SELECT *
  FROM readings
  WHERE device_id = ?
  ORDER BY id DESC
  LIMIT ?
`).all(DEVICE_ID, WINDOW_SIZE);

if (rows.length < WINDOW_SIZE) {
  console.log(`Need ${WINDOW_SIZE} readings, only have ${rows.length}`);
  process.exit(0);
}

const count = rows.filter((r) => r.humidity_x10 >= HUMIDITY_THRESHOLD_X10).length;

console.log("Latest readings:");
for (const r of rows.reverse()) {
  console.log(
    `id=${r.id}, nonce=${r.nonce}, temp=${r.temperature_c_x10 / 10}C, humidity=${r.humidity_x10 / 10}%`
  );
}

console.log();
console.log(`Humidity threshold: ${HUMIDITY_THRESHOLD_X10 / 10}%`);
console.log(`Count above threshold: ${count}/${WINDOW_SIZE}`);

if (count >= MIN_COUNT) {
  console.log("✅ CLIMATE EVENT VERIFIED");
  console.log(
    `At least ${MIN_COUNT}/${WINDOW_SIZE} readings were above ${HUMIDITY_THRESHOLD_X10 / 10}% humidity.`
  );
} else {
  console.log("❌ No climate event");
}
