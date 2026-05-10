const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const {
  normalizeEthereumAddress,
  normalizeEthereumSignature,
  SIGNATURE_SCHEME,
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

async function main() {
  const canonicalMessage =
    "esp8266-daaa2c|42|1700000100|235|512|f7b62a2847d61cbbdf0cdd73bc0d15ac";

  assert.equal(buildCanonicalMessage(reading), canonicalMessage);

  const ok = validateSigningRequest(
    { ...reading, canonical_message: canonicalMessage },
    {
      allowedDeviceId: "esp8266-daaa2c",
      approvedFirmwareHashes: new Set([reading.firmware_hash]),
      now: 1700000100,
      maxClockSkewSeconds: 60,
    }
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.canonicalMessage, canonicalMessage);

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

  assert.equal(SIGNATURE_SCHEME, "ethereum_secp256k1_eip191");
  assert.equal(
    normalizeEthereumAddress("0x70136c02c29229d5da1cbc7706c59cc7374bcc81"),
    "0x70136c02C29229D5dA1cbC7706C59Cc7374bCC81"
  );

  const rawSignature = Buffer.alloc(65, 0xab);
  rawSignature[64] = 0;
  assert.match(
    normalizeEthereumSignature(rawSignature.toString("base64")),
    /^0x[0-9a-f]{128}1b$/
  );
  assert.match(
    normalizeEthereumSignature(`vault:v1:${rawSignature.toString("base64")}`),
    /^0x[0-9a-f]{128}1b$/
  );

  const wallet = ethers.Wallet.createRandom();
  const signature = await wallet.signMessage(canonicalMessage);
  assert.equal(
    ethers.utils.getAddress(ethers.utils.verifyMessage(canonicalMessage, signature)),
    wallet.address
  );
  assert.match(normalizeEthereumSignature(signature), /^0x[0-9a-f]{130}$/);

  console.log("kms signer tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
