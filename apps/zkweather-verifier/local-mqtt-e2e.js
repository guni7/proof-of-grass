const mqtt = require("mqtt");
const Database = require("better-sqlite3");
const { loadDotEnv } = require("./orbitport-kms");
const { buildCanonicalMessage } = require("./kms-signer");

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestSignature(signerUrl, reading) {
  const response = await fetch(signerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reading),
  });
  const body = await response.json();

  if (!response.ok || !body.ok) {
    throw new Error(`signer rejected request: ${body.reason || response.status}`);
  }

  return body;
}

function publishPayload(mqttUrl, topic, payload) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(mqttUrl);
    const timeout = setTimeout(() => {
      client.end(true);
      reject(new Error("MQTT publish timed out"));
    }, 5000);

    client.once("connect", () => {
      client.publish(topic, JSON.stringify(payload), {}, (err) => {
        clearTimeout(timeout);
        client.end();
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    client.once("error", (err) => {
      clearTimeout(timeout);
      client.end(true);
      reject(err);
    });
  });
}

async function waitForVerifierInsert(db, canonicalMessage) {
  const statement = db.prepare(
    "SELECT id, message_hash FROM readings WHERE canonical_message = ?"
  );

  for (let i = 0; i < 30; i++) {
    const row = statement.get(canonicalMessage);
    if (row) return row;
    await delay(200);
  }

  throw new Error("verifier did not insert the signed reading");
}

async function main() {
  loadDotEnv();

  const mqttUrl = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";
  const topic = process.env.MQTT_TOPIC || "weather/dht22/signed";
  const signerUrl =
    process.env.ZKWEATHER_LOCAL_SIGNER_URL || "http://127.0.0.1:3001/sign";
  const firmwareHash =
    parseCsv(process.env.ZKWEATHER_APPROVED_FIRMWARE_HASHES)[0] ||
    "f7b62a2847d61cbbdf0cdd73bc0d15ac";

  const reading = {
    device_id:
      process.env.ZKWEATHER_ALLOWED_DEVICE_ID ||
      process.env.ZKWEATHER_DEVICE_ID ||
      "esp8266-daaa2c",
    nonce: Math.floor(Date.now() / 1000),
    timestamp: Math.floor(Date.now() / 1000),
    temperature_c_x10: 246,
    humidity_x10: 501,
    firmware_hash: firmwareHash,
  };
  reading.canonical_message = buildCanonicalMessage(reading);

  const signed = await requestSignature(signerUrl, reading);
  const payload = {
    device_id: reading.device_id,
    nonce: reading.nonce,
    timestamp: reading.timestamp,
    temperature_c_x10: reading.temperature_c_x10,
    humidity_x10: reading.humidity_x10,
    firmware_hash: reading.firmware_hash,
    signature_scheme: signed.signature_scheme,
    public_key: signed.public_key,
    signer_address: signed.signer_address,
    signature: signed.signature,
    local_ip: "127.0.0.1",
  };

  await publishPayload(mqttUrl, topic, payload);

  const db = new Database("zkweather.db");
  try {
    const row = await waitForVerifierInsert(db, reading.canonical_message);
    console.log("kms mqtt e2e passed");
    console.log(`topic=${topic}`);
    console.log(`reading_id=${row.id}`);
    console.log(`message_hash=${row.message_hash}`);
    console.log(`canonical_message=${reading.canonical_message}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
