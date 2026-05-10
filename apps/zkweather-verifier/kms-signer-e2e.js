const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const {
  loadDotEnv,
  normalizeEthereumAddress,
  readConfig,
} = require("./orbitport-kms");
const {
  buildCanonicalMessage,
  createServer,
  getSignerOptions,
} = require("./kms-signer");

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  loadDotEnv();

  const config = readConfig();
  const signerAddress = normalizeEthereumAddress(config.signerAddress);
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
    temperature_c_x10: 235,
    humidity_x10: 512,
    firmware_hash: firmwareHash,
  };
  reading.canonical_message = buildCanonicalMessage(reading);

  const server = createServer(config, {
    ...getSignerOptions(),
    maxClockSkewSeconds: 600,
  });
  const address = await listen(server);

  try {
    const baseUrl = `http://${address.address}:${address.port}`;
    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.ok, true);
    assert.equal(health.signer_mode, "orbitport-kms");
    assert.equal(health.signature_scheme, "ethereum_secp256k1_eip191");
    assert.equal(health.signer_address, signerAddress);

    const signResponse = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reading),
    });
    const signed = await signResponse.json();
    assert.equal(signResponse.status, 200, signed.reason);
    assert.equal(signed.ok, true);
    assert.equal(signed.signature_scheme, "ethereum_secp256k1_eip191");
    assert.equal(signed.public_key, signerAddress);
    assert.equal(signed.signer_address, signerAddress);
    assert.equal(signed.canonical_message, reading.canonical_message);
    assert.match(signed.signature, /^0x[0-9a-f]{130}$/);

    const recovered = ethers.utils.getAddress(
      ethers.utils.verifyMessage(reading.canonical_message, signed.signature)
    );
    assert.equal(recovered, signerAddress);

    console.log("live kms signer e2e passed");
    console.log(`device_id=${reading.device_id}`);
    console.log(`firmware_hash=${reading.firmware_hash}`);
    console.log(`signer_address=${signerAddress}`);
    console.log(`key_id=${signed.key_id}`);
    console.log(`canonical_message=${reading.canonical_message}`);
    console.log(`signature=${signed.signature}`);
  } finally {
    await close(server);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
