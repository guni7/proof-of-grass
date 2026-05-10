const assert = require("node:assert/strict");
const {
  normalizePublicKey,
  normalizeSignature,
} = require("./orbitport-kms");
const {
  buildCanonicalMessage,
  validateSigningRequest,
} = require("./kms-signer");

const reading = {
  device_id: "esp8266-daaa2c",
  nonce: 42,
  timestamp: 1700000100,
  temperature_c_x10: 235,
  humidity_x10: 512,
  firmware_hash: "f7b62a2847d61cbbdf0cdd73bc0d15ac",
};

assert.equal(
  buildCanonicalMessage(reading),
  "esp8266-daaa2c|42|1700000100|235|512|f7b62a2847d61cbbdf0cdd73bc0d15ac"
);

const ok = validateSigningRequest(
  { ...reading, canonical_message: buildCanonicalMessage(reading) },
  {
    allowedDeviceId: "esp8266-daaa2c",
    approvedFirmwareHashes: new Set([reading.firmware_hash]),
    now: 1700000100,
    maxClockSkewSeconds: 60,
  }
);
assert.equal(ok.ok, true);
assert.equal(ok.canonicalMessage, buildCanonicalMessage(reading));

const badCanonical = validateSigningRequest(
  { ...reading, canonical_message: "wrong" },
  { now: 1700000100, maxClockSkewSeconds: 60 }
);
assert.equal(badCanonical.ok, false);
assert.match(badCanonical.reason, /canonical_message/);

const stale = validateSigningRequest(reading, {
  now: 1700001000,
  maxClockSkewSeconds: 60,
});
assert.equal(stale.ok, false);
assert.match(stale.reason, /timestamp outside signing window/);

assert.equal(
  normalizePublicKey("0x" + "ab".repeat(32)),
  "ab".repeat(32)
);
assert.equal(
  normalizePublicKey(Buffer.alloc(32, 0xcd).toString("base64")),
  "cd".repeat(32)
);
assert.equal(
  normalizeSignature(Buffer.alloc(64, 0xef).toString("base64")),
  "ef".repeat(64)
);

console.log("kms signer tests passed");
