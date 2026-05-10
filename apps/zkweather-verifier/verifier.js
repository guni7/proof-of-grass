const mqtt = require("mqtt");
const Database = require("better-sqlite3");
const crypto = require("crypto");

// Your MQTT broker
const MQTT_URL = "mqtt://172.20.10.3:1883";
const MQTT_TOPIC = "weather/dht22/signed";

// Register your real ESP8266 here.
// Do NOT trust public_key from incoming payload blindly.
const REGISTERED_DEVICES = {
  "esp8266-daaa2c": {
    publicKey:
      "712651f450ba05b63898b99ef5f7ba45632e8e2527f7f715cd671ec4024cc51e",
    approvedFirmwareHashes: new Set([
      "7229c744050eabd1f968457de01911ee",
      "f7b62a2847d61cbbdf0cdd73bc0d15ac"
    ]),
  },
};

const db = new Database("zkweather.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    nonce INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    temperature_c_x10 INTEGER NOT NULL,
    humidity_x10 INTEGER NOT NULL,
    firmware_hash TEXT NOT NULL,
    signature_scheme TEXT NOT NULL,
    public_key TEXT NOT NULL,
    signature TEXT NOT NULL,
    local_ip TEXT,
    canonical_message TEXT NOT NULL,
    message_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_device_nonce
  ON readings(device_id, nonce);

  CREATE TABLE IF NOT EXISTS climate_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    start_reading_id INTEGER NOT NULL,
    end_reading_id INTEGER NOT NULL,
    threshold_type TEXT NOT NULL,
    threshold_value INTEGER NOT NULL,
    window_size INTEGER NOT NULL,
    min_count INTEGER NOT NULL,
    actual_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const insertReading = db.prepare(`
  INSERT INTO readings (
    device_id,
    nonce,
    timestamp,
    temperature_c_x10,
    humidity_x10,
    firmware_hash,
    signature_scheme,
    public_key,
    signature,
    local_ip,
    canonical_message,
    message_hash,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }

  return Uint8Array.from(
    hex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
  );
}

function buildCanonicalMessage(reading) {
  return [
    reading.device_id,
    reading.nonce,
    reading.timestamp,
    reading.temperature_c_x10,
    reading.humidity_x10,
    reading.firmware_hash,
  ].join("|");
}

function validateReadingShape(reading) {
  const required = [
    "device_id",
    "nonce",
    "timestamp",
    "temperature_c_x10",
    "humidity_x10",
    "firmware_hash",
    "signature_scheme",
    "public_key",
    "signature",
  ];

  for (const field of required) {
    if (!(field in reading)) {
      return { ok: false, reason: `Missing field: ${field}` };
    }
  }

  if (typeof reading.device_id !== "string") {
    return { ok: false, reason: "device_id must be string" };
  }

  if (typeof reading.firmware_hash !== "string") {
    return { ok: false, reason: "firmware_hash must be string" };
  }

  if (typeof reading.public_key !== "string") {
    return { ok: false, reason: "public_key must be string" };
  }

  if (typeof reading.signature !== "string") {
    return { ok: false, reason: "signature must be string" };
  }

  if (!Number.isInteger(reading.nonce)) {
    return { ok: false, reason: "nonce must be integer" };
  }

  if (!Number.isInteger(reading.timestamp)) {
    return { ok: false, reason: "timestamp must be integer" };
  }

  if (!Number.isInteger(reading.temperature_c_x10)) {
    return { ok: false, reason: "temperature_c_x10 must be integer" };
  }

  if (!Number.isInteger(reading.humidity_x10)) {
    return { ok: false, reason: "humidity_x10 must be integer" };
  }

  if (reading.humidity_x10 < 0 || reading.humidity_x10 > 1000) {
    return { ok: false, reason: "humidity outside valid range" };
  }

  if (reading.temperature_c_x10 < -400 || reading.temperature_c_x10 > 800) {
    return { ok: false, reason: "temperature outside expected range" };
  }

  if (reading.signature_scheme !== "ed25519") {
    return {
      ok: false,
      reason: `unsupported signature scheme: ${reading.signature_scheme}`,
    };
  }

  if (reading.public_key.length !== 64) {
    return { ok: false, reason: "public_key must be 32 bytes hex" };
  }

  if (reading.signature.length !== 128) {
    return { ok: false, reason: "signature must be 64 bytes hex" };
  }

  return { ok: true };
}

async function verifyReading(reading) {
  const shape = validateReadingShape(reading);
  if (!shape.ok) return shape;

  const now = Math.floor(Date.now() / 1000);

  // Allow some clock/network delay.
  // For testing, keep it loose.
  const MAX_AGE_SECONDS = 10 * 60; // 10 minutes old
  const MAX_FUTURE_SECONDS = 2 * 60; // 2 minutes in future

  if (reading.timestamp < now - MAX_AGE_SECONDS) {
    return {
      ok: false,
      reason: `Reading too old: timestamp=${reading.timestamp}, now=${now}`,
    };
  }

  if (reading.timestamp > now + MAX_FUTURE_SECONDS) {
    return {
      ok: false,
      reason: `Reading from future: timestamp=${reading.timestamp}, now=${now}`,
    };
  }

  const registered = REGISTERED_DEVICES[reading.device_id];
  if (!registered) {
    return { ok: false, reason: `Unknown device_id: ${reading.device_id}` };
  }

  if (reading.public_key !== registered.publicKey) {
    return {
      ok: false,
      reason: "Payload public_key does not match registered public key",
    };
  }

  if (!registered.approvedFirmwareHashes.has(reading.firmware_hash)) {
    return {
      ok: false,
      reason: `Unapproved firmware hash: ${reading.firmware_hash}`,
    };
  }

  const canonicalMessage = buildCanonicalMessage(reading);

  const messageBytes = new TextEncoder().encode(canonicalMessage);
  const signatureBytes = hexToBytes(reading.signature);
  const publicKeyBytes = hexToBytes(registered.publicKey);

  const ed = await import("@noble/ed25519");
  const signatureOk = await ed.verifyAsync(
    signatureBytes,
    messageBytes,
    publicKeyBytes
  );

  if (!signatureOk) {
    return {
      ok: false,
      reason: "Bad Ed25519 signature",
      canonicalMessage,
    };
  }

  const messageHash = crypto
    .createHash("sha256")
    .update(canonicalMessage)
    .digest("hex");

  return {
    ok: true,
    canonicalMessage,
    messageHash,
  };
}

const client = mqtt.connect(MQTT_URL);

client.on("connect", () => {
  console.log(`Connected to MQTT broker: ${MQTT_URL}`);

  client.subscribe(MQTT_TOPIC, (err) => {
    if (err) {
      console.error("Subscription error:", err);
      return;
    }

    console.log(`Subscribed to ${MQTT_TOPIC}`);
  });
});

client.on("message", async (topic, payloadBuffer) => {
  const payload = payloadBuffer.toString();

  console.log("\nReceived MQTT message:");
  console.log(payload);

  let reading;
  try {
    reading = JSON.parse(payload);
  } catch (err) {
    console.error("Rejected reading: invalid JSON:", err.message);
    return;
  }

  const result = await verifyReading(reading);

  if (!result.ok) {
    console.error("Rejected reading:", result.reason);

    if (result.canonicalMessage) {
      console.error("Canonical message was:", result.canonicalMessage);
    }

    return;
  }

  try {
    insertReading.run(
      reading.device_id,
      reading.nonce,
      reading.timestamp,
      reading.temperature_c_x10,
      reading.humidity_x10,
      reading.firmware_hash,
      reading.signature_scheme,
      reading.public_key,
      reading.signature,
      reading.local_ip || null,
      result.canonicalMessage,
      result.messageHash,
      Math.floor(Date.now() / 1000)
    );

    console.log("Accepted reading");
    console.log("Canonical:", result.canonicalMessage);
    console.log("Message hash:", result.messageHash);
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      console.error("Rejected reading: duplicate nonce for this device");
    } else {
      console.error("Database insert error:", err.message);
    }
  }
});

client.on("error", (err) => {
  console.error("MQTT error:", err.message);
});
