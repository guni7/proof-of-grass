const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { Noir } = require("@noir-lang/noir_js");

const db = new Database("zkweather.db");

const DEVICE_ID = process.env.DEVICE_ID || "esp8266-daaa2c";

const WINDOW_SIZE = Number(process.env.WINDOW_SIZE || 5);
const TREE_SIZE = Number(process.env.TREE_SIZE || 8);
const TREE_DEPTH = Number(process.env.TREE_DEPTH || 3);

// For testing, use 410 because your humidity is around 41.4–41.5%.
// Later change this to 800 for 80.0%.
const THRESHOLD = Number(process.env.THRESHOLD || 410);
const MIN_COUNT = Number(process.env.MIN_COUNT || 3);

const WINDOW_BUFFER_SECONDS = Number(process.env.WINDOW_BUFFER_SECONDS || 30);

const START_ID = process.env.START_ID ? Number(process.env.START_ID) : null;
const END_ID = process.env.END_ID ? Number(process.env.END_ID) : null;

const FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

function sha256ToField(input) {
  const digest = crypto.createHash("sha256").update(String(input)).digest("hex");
  return BigInt("0x" + digest) % FIELD_MODULUS;
}

function toFieldString(x) {
  return `"${BigInt(x).toString()}"`;
}

function fieldArray(arr) {
  return `[${arr.map(toFieldString).join(", ")}]`;
}

function normalizeNoirReturn(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);

  if (value && typeof value === "object") {
    if ("value" in value) return BigInt(value.value);
    if ("inner" in value) return BigInt(value.inner);
  }

  throw new Error(`Unsupported Noir return value: ${JSON.stringify(value)}`);
}

async function loadPoseidonHelper() {
  const circuitPath = path.join(
    "..",
    "zkweather_poseidon_helper",
    "target",
    "zkweather_poseidon_helper.json"
  );

  if (!fs.existsSync(circuitPath)) {
    throw new Error(
      `Poseidon helper circuit not found at ${circuitPath}. Run: cd ../zkweather_poseidon_helper && nargo compile`
    );
  }

  const circuit = JSON.parse(fs.readFileSync(circuitPath, "utf8"));
  return new Noir(circuit);
}

function getRowsForExactWindow() {
  if (START_ID === null || END_ID === null) {
    return null;
  }

  const rows = db
    .prepare(
      `
      SELECT *
      FROM readings
      WHERE device_id = ?
        AND id >= ?
        AND id <= ?
      ORDER BY id ASC
    `
    )
    .all(DEVICE_ID, START_ID, END_ID);

  if (rows.length !== WINDOW_SIZE) {
    throw new Error(
      `Expected ${WINDOW_SIZE} readings from id ${START_ID} to ${END_ID}, got ${rows.length}`
    );
  }

  return rows;
}

function getRowsForLatestFallback() {
  const rows = db
    .prepare(
      `
      SELECT *
      FROM readings
      WHERE device_id = ?
      ORDER BY id DESC
      LIMIT ?
    `
    )
    .all(DEVICE_ID, TREE_SIZE);

  if (rows.length < WINDOW_SIZE) {
    throw new Error(`Need at least ${WINDOW_SIZE} readings, got ${rows.length}`);
  }

  return rows.reverse();
}

async function main() {
  const poseidonNoir = await loadPoseidonHelper();

  async function poseidonHash2(left, right) {
    const { returnValue } = await poseidonNoir.execute({
      mode: 2,
      a: BigInt(left).toString(),
      b: BigInt(right).toString(),
      c: "0",
      d: "0",
      e: "0",
      f: "0",
    });

    return normalizeNoirReturn(returnValue);
  }

  async function poseidonHash6(values) {
    if (values.length !== 6) {
      throw new Error("poseidonHash6 expects exactly 6 values");
    }

    const { returnValue } = await poseidonNoir.execute({
      mode: 6,
      a: BigInt(values[0]).toString(),
      b: BigInt(values[1]).toString(),
      c: BigInt(values[2]).toString(),
      d: BigInt(values[3]).toString(),
      e: BigInt(values[4]).toString(),
      f: BigInt(values[5]).toString(),
    });

    return normalizeNoirReturn(returnValue);
  }

  async function hashReading(r) {
    const deviceHash = sha256ToField(r.device_id);
    const firmwareHash = sha256ToField(r.firmware_hash);

    return await poseidonHash6([
      deviceHash,
      BigInt(r.nonce),
      BigInt(r.timestamp),
      BigInt(r.temperature_c_x10),
      BigInt(r.humidity_x10),
      firmwareHash,
    ]);
  }

  function zeroLeaf() {
    return 0n;
  }

  async function buildMerkleTree(leaves) {
    const levels = [leaves];

    let current = leaves;

    while (current.length > 1) {
      const next = [];

      for (let i = 0; i < current.length; i += 2) {
        next.push(await poseidonHash2(current[i], current[i + 1]));
      }

      levels.push(next);
      current = next;
    }

    return levels;
  }

  function getMerklePath(levels, index) {
    const path = [];
    let idx = index;

    for (let level = 0; level < TREE_DEPTH; level++) {
      const siblingIndex = idx ^ 1;
      path.push(levels[level][siblingIndex]);
      idx = Math.floor(idx / 2);
    }

    return path;
  }

  const exactRows = getRowsForExactWindow();
  const rows = exactRows || getRowsForLatestFallback();

  // Important:
  // `ordered` is the exact batch we are proving, oldest → newest.
  // If START_ID/END_ID are passed, this will exactly match proof-daemon's job.
  const ordered = [...rows];

  if (ordered.length < WINDOW_SIZE) {
    throw new Error(`Need ${WINDOW_SIZE} rows, got ${ordered.length}`);
  }

  // The tree contains the batch rows first, then zero padding up to TREE_SIZE.
  while (ordered.length < TREE_SIZE) {
    ordered.push(null);
  }

  const leaves = [];

  for (const r of ordered) {
    leaves.push(r ? await hashReading(r) : zeroLeaf());
  }

  const levels = await buildMerkleTree(leaves);
  const merkleRoot = levels[levels.length - 1][0];

  // Select the first WINDOW_SIZE real readings in this tree.
  const selected = ordered
    .map((r, index) => ({ r, index }))
    .filter((x) => x.r !== null)
    .slice(0, WINDOW_SIZE);

  if (selected.length !== WINDOW_SIZE) {
    throw new Error(`Expected ${WINDOW_SIZE} selected readings, got ${selected.length}`);
  }

  const selectedRows = selected.map((x) => x.r);
  const selectedIndices = selected.map((x) => x.index);

  const timestamps = selectedRows.map((r) => r.timestamp);
  const windowStart = Math.min(...timestamps) - WINDOW_BUFFER_SECONDS;
  const windowEnd = Math.max(...timestamps) + WINDOW_BUFFER_SECONDS;

  const deviceHashes = selectedRows.map((r) => sha256ToField(r.device_id));
  const nonces = selectedRows.map((r) => BigInt(r.nonce));
  const timestampU32s = selectedRows.map((r) => r.timestamp);
  const temperatureFields = selectedRows.map((r) => BigInt(r.temperature_c_x10));
  const humidityU32s = selectedRows.map((r) => r.humidity_x10);
  const firmwareHashes = selectedRows.map((r) => sha256ToField(r.firmware_hash));

  const merklePaths = selectedIndices.map((idx) => getMerklePath(levels, idx));

  const proverToml = `
device_hashes = ${fieldArray(deviceHashes)}
nonces = ${fieldArray(nonces)}
timestamps = [${timestampU32s.join(", ")}]
temperature_x10s = ${fieldArray(temperatureFields)}
humidity_x10s = [${humidityU32s.join(", ")}]
firmware_hashes = ${fieldArray(firmwareHashes)}

merkle_paths = [
${merklePaths.map((p) => `  ${fieldArray(p)}`).join(",\n")}
]
leaf_indices = [${selectedIndices.join(", ")}]

merkle_root = "${merkleRoot.toString()}"
threshold = ${THRESHOLD}
min_count = ${MIN_COUNT}
window_start = ${windowStart}
window_end = ${windowEnd}
`.trim() + "\n";

  const batchMetadata = {
    hash: "noir_poseidon_bn254",
    device_id: DEVICE_ID,
    tree_size: TREE_SIZE,
    tree_depth: TREE_DEPTH,
    window_size: WINDOW_SIZE,
    threshold: THRESHOLD,
    min_count: MIN_COUNT,
    window_start: windowStart,
    window_end: windowEnd,
    merkle_root: merkleRoot.toString(),
    requested_start_id: START_ID,
    requested_end_id: END_ID,
    actual_start_id: selectedRows[0].id,
    actual_end_id: selectedRows[selectedRows.length - 1].id,
    selected_readings: selectedRows.map((r, i) => ({
      leaf_index: selectedIndices[i],
      id: r.id,
      nonce: r.nonce,
      timestamp: r.timestamp,
      temperature_c_x10: r.temperature_c_x10,
      humidity_x10: r.humidity_x10,
      firmware_hash: r.firmware_hash,
      message_hash: r.message_hash,
    })),
    leaves: leaves.map((x) => x.toString()),
    levels: levels.map((level) => level.map((x) => x.toString())),
  };

  fs.writeFileSync("merkle-batch.json", JSON.stringify(batchMetadata, null, 2));

  fs.writeFileSync(
    path.join("..", "zkweather_threshold", "Prover.toml"),
    proverToml
  );

  console.log("Noir Poseidon Merkle root:", merkleRoot.toString());
  console.log("Selected readings:");

  for (let i = 0; i < selectedRows.length; i++) {
    const r = selectedRows[i];
    console.log(
      `leaf=${selectedIndices[i]}, id=${r.id}, nonce=${r.nonce}, ts=${r.timestamp}, humidity=${r.humidity_x10}`
    );
  }

  console.log("\nWrote merkle-batch.json");
  console.log("Wrote ../zkweather_threshold/Prover.toml");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});