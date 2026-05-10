const http = require("http");
const {
  loadDotEnv,
  normalizePublicKey,
  readConfig,
  signEd25519Raw,
} = require("./orbitport-kms");

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

function isInteger(value) {
  return Number.isInteger(value);
}

function validateSigningRequest(reading, options = {}) {
  if (!reading || typeof reading !== "object" || Array.isArray(reading)) {
    return { ok: false, reason: "request body must be a JSON object" };
  }

  const required = [
    "device_id",
    "nonce",
    "timestamp",
    "temperature_c_x10",
    "humidity_x10",
    "firmware_hash",
  ];

  for (const field of required) {
    if (!(field in reading)) {
      return { ok: false, reason: `missing field: ${field}` };
    }
  }

  if (typeof reading.device_id !== "string" || !reading.device_id) {
    return { ok: false, reason: "device_id must be a non-empty string" };
  }

  if (typeof reading.firmware_hash !== "string" || !reading.firmware_hash) {
    return { ok: false, reason: "firmware_hash must be a non-empty string" };
  }

  if (!isInteger(reading.nonce) || reading.nonce < 0) {
    return { ok: false, reason: "nonce must be a non-negative integer" };
  }

  if (!isInteger(reading.timestamp) || reading.timestamp <= 0) {
    return { ok: false, reason: "timestamp must be a positive integer" };
  }

  if (!isInteger(reading.temperature_c_x10)) {
    return { ok: false, reason: "temperature_c_x10 must be an integer" };
  }

  if (!isInteger(reading.humidity_x10)) {
    return { ok: false, reason: "humidity_x10 must be an integer" };
  }

  if (reading.humidity_x10 < 0 || reading.humidity_x10 > 1000) {
    return { ok: false, reason: "humidity outside valid range" };
  }

  if (reading.temperature_c_x10 < -400 || reading.temperature_c_x10 > 800) {
    return { ok: false, reason: "temperature outside expected range" };
  }

  if (options.allowedDeviceId && reading.device_id !== options.allowedDeviceId) {
    return {
      ok: false,
      reason: `device_id is not allowed: ${reading.device_id}`,
    };
  }

  if (
    options.approvedFirmwareHashes &&
    options.approvedFirmwareHashes.size > 0 &&
    !options.approvedFirmwareHashes.has(reading.firmware_hash)
  ) {
    return {
      ok: false,
      reason: `firmware hash is not approved: ${reading.firmware_hash}`,
    };
  }

  const maxClockSkewSeconds = options.maxClockSkewSeconds ?? 10 * 60;
  if (maxClockSkewSeconds > 0) {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (Math.abs(reading.timestamp - now) > maxClockSkewSeconds) {
      return {
        ok: false,
        reason: `timestamp outside signing window: timestamp=${reading.timestamp}, now=${now}`,
      };
    }
  }

  const canonicalMessage = buildCanonicalMessage(reading);
  if (
    reading.canonical_message !== undefined &&
    reading.canonical_message !== canonicalMessage
  ) {
    return {
      ok: false,
      reason: "canonical_message does not match weather fields",
    };
  }

  return { ok: true, canonicalMessage };
}

function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error(`invalid JSON: ${err.message}`));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function getSignerOptions(env = process.env) {
  return {
    allowedDeviceId: env.ZKWEATHER_ALLOWED_DEVICE_ID || env.ZKWEATHER_DEVICE_ID || "",
    approvedFirmwareHashes: new Set(parseCsv(env.ZKWEATHER_APPROVED_FIRMWARE_HASHES)),
    maxClockSkewSeconds: Number(env.ZKWEATHER_SIGN_MAX_CLOCK_SKEW_SECONDS || 600),
  };
}

function createServer(config, options) {
  const publicKeyHex = normalizePublicKey(config.publicKey);

  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, {
          ok: true,
          key_configured: Boolean(config.keyId),
          public_key: publicKeyHex,
        });
        return;
      }

      if (req.method !== "POST" || req.url !== "/sign") {
        sendJson(res, 404, { ok: false, reason: "not found" });
        return;
      }

      const reading = await readJsonBody(req);
      const validation = validateSigningRequest(reading, options);
      if (!validation.ok) {
        sendJson(res, 400, { ok: false, reason: validation.reason });
        return;
      }

      const signature = await signEd25519Raw(config, validation.canonicalMessage);
      sendJson(res, 200, {
        ok: true,
        signature_scheme: "ed25519",
        public_key: signature.publicKeyHex,
        signature: signature.signatureHex,
        key_id: signature.keyId,
        canonical_message: validation.canonicalMessage,
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, reason: err.message });
    }
  });
}

async function main() {
  loadDotEnv();

  const config = readConfig();
  const options = getSignerOptions();
  const port = Number(process.env.ZKWEATHER_KMS_SIGNER_PORT || 3001);
  const host = process.env.ZKWEATHER_KMS_SIGNER_HOST || "0.0.0.0";

  if (!config.keyId) {
    throw new Error("Missing ZKWEATHER_KMS_KEY_ID or SPACEFABRIC_KMS_KEY_REF");
  }
  normalizePublicKey(config.publicKey);

  const server = createServer(config, options);
  server.listen(port, host, () => {
    console.log(`ZK weather KMS signer listening on http://${host}:${port}`);
    console.log(`Allowed device: ${options.allowedDeviceId || "(any)"}`);
    console.log(
      `Approved firmware hashes: ${
        options.approvedFirmwareHashes.size || "(not enforced)"
      }`
    );
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = {
  buildCanonicalMessage,
  createServer,
  getSignerOptions,
  validateSigningRequest,
};
