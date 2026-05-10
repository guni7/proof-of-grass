const fs = require("fs");
const path = require("path");

let nextRpcId = 1;
let cachedToken = null;

function loadDotEnv() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(__dirname, ".env"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;

    const contents = fs.readFileSync(file, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;

      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;

      let value = rawValue.trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function resolveAuthUrl(env) {
  if (env.OP_AUTH_URL) return stripTrailingSlash(env.OP_AUTH_URL);
  if (env.ORBITPORT_AUTH_URL) return stripTrailingSlash(env.ORBITPORT_AUTH_URL);

  const domain =
    env.OP_AUTH_DOMAIN || env.ORBITPORT_AUTH_DOMAIN || "auth.spacecomputer.io";
  if (domain.startsWith("http://") || domain.startsWith("https://")) {
    return stripTrailingSlash(domain);
  }

  return `https://${stripTrailingSlash(domain)}`;
}

function resolveRpcUrl(env, apiUrl) {
  const configured =
    env.SPACEFABRIC_KMS_SIGN_URL || env.ORBITPORT_KMS_RPC_URL || "";

  if (configured) {
    const normalized = stripTrailingSlash(configured);
    if (normalized.endsWith("/api/v1/rpc")) return normalized;
    return `${normalized}/api/v1/rpc`;
  }

  return `${stripTrailingSlash(apiUrl)}/api/v1/rpc`;
}

function readConfig(env = process.env) {
  const apiUrl = stripTrailingSlash(env.OP_API_URL || env.ORBITPORT_API_URL || "https://op.spacecomputer.io");

  return {
    clientId: env.OP_CLIENT_ID || env.ORBITPORT_CLIENT_ID || "",
    clientSecret: env.OP_CLIENT_SECRET || env.ORBITPORT_CLIENT_SECRET || "",
    authUrl: resolveAuthUrl(env),
    audience:
      env.OP_AUTH_AUDIENCE ||
      env.ORBITPORT_AUTH_AUDIENCE ||
      "https://op.spacecomputer.io/api",
    apiUrl,
    rpcUrl: resolveRpcUrl(env, apiUrl),
    keyId:
      env.ZKWEATHER_KMS_KEY_ID ||
      env.SPACEFABRIC_KMS_KEY_REF ||
      env.ORBITPORT_KMS_KEY_ID ||
      "",
    publicKey: env.ZKWEATHER_PUBLIC_KEY || env.ORBITPORT_KMS_PUBLIC_KEY || "",
    timeoutMs: Number(env.ORBITPORT_TIMEOUT_MS || 30000),
  };
}

function requireCredentials(config) {
  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      "Missing OP_CLIENT_ID/OP_CLIENT_SECRET or ORBITPORT_CLIENT_ID/ORBITPORT_CLIENT_SECRET"
    );
  }
}

function requireKeyConfig(config) {
  if (!config.keyId) {
    throw new Error("Missing ZKWEATHER_KMS_KEY_ID or SPACEFABRIC_KMS_KEY_REF");
  }

  if (!config.publicKey) {
    throw new Error("Missing ZKWEATHER_PUBLIC_KEY or ORBITPORT_KMS_PUBLIC_KEY");
  }
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();

    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (err) {
        throw new Error(`Invalid JSON response from ${url}: ${err.message}`);
      }
    }

    if (!response.ok) {
      const message =
        body && typeof body.error_description === "string"
          ? body.error_description
          : body && typeof body.message === "string"
            ? body.message
            : text;
      throw new Error(`HTTP ${response.status} from ${url}: ${message}`);
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function getAccessToken(config) {
  requireCredentials(config);

  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.value;
  }

  const tokenUrl = `${config.authUrl}/oauth/token`;
  const body = await fetchJsonWithTimeout(
    tokenUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        audience: config.audience,
        grant_type: "client_credentials",
      }),
    },
    config.timeoutMs
  );

  if (!body || typeof body.access_token !== "string") {
    throw new Error("OAuth response did not include access_token");
  }

  cachedToken = {
    value: body.access_token,
    expiresAt: now + Number(body.expires_in || 3600),
  };

  return cachedToken.value;
}

async function jsonRpc(config, method, params) {
  const token = await getAccessToken(config);
  const requestId = nextRpcId++;

  const body = await fetchJsonWithTimeout(
    config.rpcUrl,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params,
      }),
    },
    config.timeoutMs
  );

  if (!body || body.jsonrpc !== "2.0") {
    throw new Error("Invalid JSON-RPC response: missing jsonrpc=2.0");
  }

  if (body.id !== requestId && body.id !== null) {
    throw new Error(
      `Invalid JSON-RPC response id: expected ${requestId}, got ${body.id}`
    );
  }

  if (body.error) {
    const message =
      typeof body.error.message === "string"
        ? body.error.message
        : "Unknown JSON-RPC error";
    throw new Error(`KMS ${method} failed: ${message}`);
  }

  if (!("result" in body)) {
    throw new Error("Invalid JSON-RPC response: missing result");
  }

  return body.result;
}

function toBase64Utf8(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function normalizePublicKey(value) {
  const trimmed = String(value || "").trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.slice(2).toLowerCase();
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) {
    return decoded.toString("hex");
  }

  throw new Error("KMS public key must be 32 bytes as hex or base64");
}

function normalizeSignature(value) {
  const trimmed = String(value || "").trim();
  if (/^0x[0-9a-fA-F]{128}$/.test(trimmed)) {
    return trimmed.slice(2).toLowerCase();
  }
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 64) {
    return decoded.toString("hex");
  }

  throw new Error("KMS Ed25519 signature must be 64 bytes as hex or base64");
}

async function createEd25519Key(config, alias) {
  requireCredentials(config);

  return jsonRpc(config, "kms.CreateKey", {
    Alias: alias,
    KeySpec: "ED25519",
    KeyUsage: "SIGN_VERIFY",
    Scheme: "TRANSIT",
  });
}

async function signEd25519Raw(config, message) {
  requireCredentials(config);
  requireKeyConfig(config);

  const result = await jsonRpc(config, "kms.Sign", {
    KeyId: config.keyId,
    Message: toBase64Utf8(message),
    SigningAlgorithm: "ED25519",
    MessageType: "RAW",
  });

  if (!result || typeof result.Signature !== "string") {
    throw new Error("KMS Sign response did not include Signature");
  }

  return {
    keyId: result.KeyId || config.keyId,
    signatureHex: normalizeSignature(result.Signature),
    publicKeyHex: normalizePublicKey(config.publicKey),
    signingAlgorithm: result.SigningAlgorithm || "ED25519",
  };
}

module.exports = {
  createEd25519Key,
  getAccessToken,
  jsonRpc,
  loadDotEnv,
  normalizePublicKey,
  normalizeSignature,
  readConfig,
  signEd25519Raw,
};
