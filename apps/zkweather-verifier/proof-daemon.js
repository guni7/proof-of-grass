const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3");

const db = new Database("zkweather.db");

const DEVICE_ID = "esp8266-daaa2c";

const WINDOW_SIZE = 5;
const TREE_SIZE = 8;

// For testing.
// Later change to 800 for 80.0%.
const THRESHOLD = 410;
const MIN_COUNT = 3;

const POLL_INTERVAL_MS = 5000;

const VERIFIER_DIR = process.cwd();
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const CIRCUIT_DIR = path.join(ROOT_DIR, "circuits", "zkweather_threshold");
const PROOFS_DIR = path.join(VERIFIER_DIR, "proofs");

const ARMORY_VERIFIER_DIR = path.join(ROOT_DIR, "spacecomputer", "armory-verifier");
const ARMORY_VERIFIER_BIN = path.join(
  ARMORY_VERIFIER_DIR,
  "target",
  "release",
  "armory-verifier"
);

if (!fs.existsSync(PROOFS_DIR)) {
  fs.mkdirSync(PROOFS_DIR, { recursive: true });
}

db.exec(`
  CREATE TABLE IF NOT EXISTS proof_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    start_reading_id INTEGER NOT NULL,
    end_reading_id INTEGER NOT NULL,
    merkle_root TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    min_count INTEGER NOT NULL,
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    status TEXT NOT NULL,
    proof_path TEXT,
    vk_path TEXT,
    batch_path TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_proof_jobs_batch
  ON proof_jobs(device_id, start_reading_id, end_reading_id);
`);

for (const column of ["verifier", "verifier_status", "verifier_output"]) {
  try {
    db.exec(`ALTER TABLE proof_jobs ADD COLUMN ${column} TEXT;`);
  } catch (_) {
    // Column already exists.
  }
}

let proving = false;
let lastWaitingMessage = "";

function run(command, args, cwd) {
  console.log(`\n$ ${command} ${args.join(" ")}`);

  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
  });
}

function runCapture(command, args, cwd) {
  console.log(`\n$ ${command} ${args.join(" ")}`);

  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout) : "";
    const stderr = err.stderr ? String(err.stderr) : "";
    const output = `${stdout}\n${stderr}`.trim();

    err.message = `${err.message}\n${output}`;
    throw err;
  }
}

function runWithEnv(command, args, cwd, env) {
  console.log(`\n$ ${command} ${args.join(" ")}`);

  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      ...env,
    },
  });
}

function getLastSuccessfulEndId() {
  const row = db
    .prepare(
      `
      SELECT end_reading_id
      FROM proof_jobs
      WHERE device_id = ?
        AND status = 'success'
      ORDER BY end_reading_id DESC
      LIMIT 1
    `
    )
    .get(DEVICE_ID);

  return row ? row.end_reading_id : 0;
}

function getNextUnprovenWindow() {
  const lastEndId = getLastSuccessfulEndId();

  const rows = db
    .prepare(
      `
      SELECT *
      FROM readings
      WHERE device_id = ?
        AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `
    )
    .all(DEVICE_ID, lastEndId, WINDOW_SIZE);

  if (rows.length < WINDOW_SIZE) {
    return null;
  }

  return rows;
}

function hasSuccessfulProofForWindow(startId, endId) {
  const row = db
    .prepare(
      `
      SELECT id
      FROM proof_jobs
      WHERE device_id = ?
        AND start_reading_id = ?
        AND end_reading_id = ?
        AND status = 'success'
      LIMIT 1
    `
    )
    .get(DEVICE_ID, startId, endId);

  return !!row;
}

function deleteFailedJobForWindow(startId, endId) {
  db.prepare(
    `
    DELETE FROM proof_jobs
    WHERE device_id = ?
      AND start_reading_id = ?
      AND end_reading_id = ?
      AND status = 'failed'
  `
  ).run(DEVICE_ID, startId, endId);
}

function insertJob({
  startId,
  endId,
  merkleRoot,
  threshold,
  minCount,
  windowStart,
  windowEnd,
}) {
  const now = Math.floor(Date.now() / 1000);

  const result = db
    .prepare(
      `
      INSERT INTO proof_jobs (
        device_id,
        start_reading_id,
        end_reading_id,
        merkle_root,
        threshold,
        min_count,
        window_start,
        window_end,
        status,
        verifier,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      DEVICE_ID,
      startId,
      endId,
      merkleRoot,
      threshold,
      minCount,
      windowStart,
      windowEnd,
      "running",
      "armory-verifier-arm-docker-and-native",
      now
    );

  return result.lastInsertRowid;
}

function completeJob(jobId, { proofPath, vkPath, batchPath, verifierOutput }) {
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    `
    UPDATE proof_jobs
    SET status = ?,
        proof_path = ?,
        vk_path = ?,
        batch_path = ?,
        verifier_status = ?,
        verifier_output = ?,
        completed_at = ?
    WHERE id = ?
  `
  ).run(
    "success",
    proofPath,
    vkPath,
    batchPath,
    "VALID",
    verifierOutput || null,
    now,
    jobId
  );
}

function failJob(jobId, error, verifierOutput = null) {
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    `
    UPDATE proof_jobs
    SET status = ?,
        error = ?,
        verifier_status = ?,
        verifier_output = ?,
        completed_at = ?
    WHERE id = ?
  `
  ).run(
    "failed",
    String(error.stack || error.message || error),
    "FAILED",
    verifierOutput,
    now,
    jobId
  );
}

function readBatchMetadata() {
  const batchPath = path.join(VERIFIER_DIR, "merkle-batch.json");

  if (!fs.existsSync(batchPath)) {
    throw new Error(`Missing batch metadata at ${batchPath}`);
  }

  return JSON.parse(fs.readFileSync(batchPath, "utf8"));
}

function archiveProofArtifacts(jobId) {
  const jobDir = path.join(PROOFS_DIR, `job-${jobId}`);

  fs.mkdirSync(jobDir, { recursive: true });

  const sourceProof = path.join(CIRCUIT_DIR, "target", "proof");
  const sourceVk = path.join(CIRCUIT_DIR, "target", "vk");
  const sourceVkHash = path.join(CIRCUIT_DIR, "target", "vk_hash");
  const sourcePublicInputs = path.join(CIRCUIT_DIR, "target", "public_inputs");
  const sourceBatch = path.join(VERIFIER_DIR, "merkle-batch.json");
  const sourceProverToml = path.join(CIRCUIT_DIR, "Prover.toml");

  const destProof = path.join(jobDir, "proof");
  const destVk = path.join(jobDir, "vk");
  const destVkHash = path.join(jobDir, "vk_hash");
  const destPublicInputs = path.join(jobDir, "public_inputs");
  const destBatch = path.join(jobDir, "merkle-batch.json");
  const destProverToml = path.join(jobDir, "Prover.toml");

  const requiredFiles = [
    ["proof", sourceProof],
    ["vk", sourceVk],
    ["vk_hash", sourceVkHash],
    ["public_inputs", sourcePublicInputs],
    ["merkle-batch.json", sourceBatch],
    ["Prover.toml", sourceProverToml],
  ];

  for (const [label, filePath] of requiredFiles) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing ${label} file at ${filePath}`);
    }
  }

  fs.copyFileSync(sourceProof, destProof);
  fs.copyFileSync(sourceVk, destVk);
  fs.copyFileSync(sourceVkHash, destVkHash);
  fs.copyFileSync(sourcePublicInputs, destPublicInputs);
  fs.copyFileSync(sourceBatch, destBatch);
  fs.copyFileSync(sourceProverToml, destProverToml);

  return {
    jobDir,
    proofPath: destProof,
    vkPath: destVk,
    vkHashPath: destVkHash,
    publicInputsPath: destPublicInputs,
    batchPath: destBatch,
    proverTomlPath: destProverToml,
  };
}

function cleanCircuitTarget() {
  const files = ["proof", "vk", "vk_hash", "public_inputs"];

  for (const file of files) {
    const p = path.join(CIRCUIT_DIR, "target", file);

    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
    }
  }

  const vkOutDir = path.join(CIRCUIT_DIR, "target", "vk_out");

  if (fs.existsSync(vkOutDir)) {
    fs.rmSync(vkOutDir, { recursive: true, force: true });
  }
}

function copyProofToArmoryArtifacts(jobId, archived) {
  const destJobDir = path.join(
    ARMORY_VERIFIER_DIR,
    "artifacts",
    `job-${jobId}`
  );

  fs.mkdirSync(destJobDir, { recursive: true });

  for (const file of ["proof", "vk", "vk_hash", "public_inputs"]) {
    const source = path.join(archived.jobDir, file);
    const dest = path.join(destJobDir, file);

    if (!fs.existsSync(source)) {
      throw new Error(`Missing proof artifact: ${source}`);
    }

    fs.copyFileSync(source, dest);
  }

  return destJobDir;
}

function verifyWithArmoryDocker(jobId) {
  const output = runCapture(
    "docker",
    [
      "compose",
      "run",
      "--rm",
      "verifier-arm",
      "-p",
      `/data/artifacts/job-${jobId}/proof`,
      "-k",
      `/data/artifacts/job-${jobId}/vk`,
      "-i",
      `/data/artifacts/job-${jobId}/public_inputs`,
    ],
    ARMORY_VERIFIER_DIR
  );

  const trimmed = output.trim();

  console.log(trimmed);

  if (trimmed !== "VALID") {
    throw new Error(
      `armory-verifier ARM Docker did not return VALID. Output: ${output}`
    );
  }

  return trimmed;
}

function verifyWithArmoryNative(archived) {
  if (!fs.existsSync(ARMORY_VERIFIER_BIN)) {
    throw new Error(
      `Missing armory-verifier binary at ${ARMORY_VERIFIER_BIN}. Run: cd ../../spacecomputer/armory-verifier && cargo build --release`
    );
  }

  const output = runCapture(
    ARMORY_VERIFIER_BIN,
    [
      "-p",
      archived.proofPath,
      "-k",
      archived.vkPath,
      "-i",
      archived.publicInputsPath,
    ],
    VERIFIER_DIR
  );

  const trimmed = output.trim();

  console.log(trimmed);

  // Exact match because "INVALID" contains "VALID".
  if (trimmed !== "VALID") {
    throw new Error(
      `armory-verifier native did not return VALID. Output: ${output}`
    );
  }

  return trimmed;
}

function sendProofToGotee(jobId) {
  const sender = path.join(VERIFIER_DIR, "send-proof-to-gotee.js");

  if (!fs.existsSync(sender)) {
    console.log("Skipping GoTEE send: send-proof-to-gotee.js not found");
    return;
  }

  run("node", ["send-proof-to-gotee.js", String(jobId)], VERIFIER_DIR);
}

function logWaiting(message) {
  if (lastWaitingMessage !== message) {
    console.log(message);
    lastWaitingMessage = message;
  }
}

async function generateProofForNextWindow() {
  if (proving) {
    return;
  }

  const window = getNextUnprovenWindow();

  if (!window) {
    const lastEndId = getLastSuccessfulEndId();
    logWaiting(
      `Waiting for ${WINDOW_SIZE} new verified readings after id ${lastEndId}...`
    );
    return;
  }

  const startId = window[0].id;
  const endId = window[window.length - 1].id;

  if (hasSuccessfulProofForWindow(startId, endId)) {
    logWaiting(
      `Proof already exists for readings ${startId} → ${endId}. Waiting for new readings...`
    );
    return;
  }

  proving = true;

  let jobId = null;
  let verifierOutput = null;

  try {
    console.log(`\nNew proof window: readings ${startId} → ${endId}`);

    runWithEnv(
      "node",
      ["make-merkle-prover-input.js"],
      VERIFIER_DIR,
      {
        DEVICE_ID,
        START_ID: String(startId),
        END_ID: String(endId),
        WINDOW_SIZE: String(WINDOW_SIZE),
        TREE_SIZE: String(TREE_SIZE),
        TREE_DEPTH: "3",
        THRESHOLD: String(THRESHOLD),
        MIN_COUNT: String(MIN_COUNT),
      }
    );

    const batch = readBatchMetadata();

    if (batch.actual_start_id !== startId || batch.actual_end_id !== endId) {
      throw new Error(
        `Batch mismatch: daemon wanted ${startId} → ${endId}, generator produced ${batch.actual_start_id} → ${batch.actual_end_id}`
      );
    }

    deleteFailedJobForWindow(startId, endId);

    jobId = insertJob({
      startId,
      endId,
      merkleRoot: batch.merkle_root,
      threshold: batch.threshold,
      minCount: batch.min_count,
      windowStart: batch.window_start,
      windowEnd: batch.window_end,
    });

    console.log(`Created proof job ${jobId}`);
    console.log(`Merkle root: ${batch.merkle_root}`);
    console.log(`Threshold: ${batch.threshold}`);
    console.log(`Min count: ${batch.min_count}`);

    run("nargo", ["execute"], CIRCUIT_DIR);

    cleanCircuitTarget();

    run(
      "bb",
      [
        "write_vk",
        "-b",
        "./target/zkweather_threshold.json",
        "-t",
        "evm",
        "-o",
        "./target/vk_out",
      ],
      CIRCUIT_DIR
    );

    run(
      "bb",
      [
        "prove",
        "-b",
        "./target/zkweather_threshold.json",
        "-w",
        "./target/zkweather_threshold.gz",
        "-k",
        "./target/vk_out/vk",
        "-t",
        "evm",
        "-o",
        "./target",
      ],
      CIRCUIT_DIR
    );

    fs.copyFileSync(
      path.join(CIRCUIT_DIR, "target", "vk_out", "vk"),
      path.join(CIRCUIT_DIR, "target", "vk")
    );

    fs.copyFileSync(
      path.join(CIRCUIT_DIR, "target", "vk_out", "vk_hash"),
      path.join(CIRCUIT_DIR, "target", "vk_hash")
    );

    const archived = archiveProofArtifacts(jobId);

    copyProofToArmoryArtifacts(jobId, archived);

    const dockerVerifierOutput = verifyWithArmoryDocker(jobId);
    const nativeVerifierOutput = verifyWithArmoryNative(archived);

    verifierOutput = `docker-arm: ${dockerVerifierOutput}\nnative: ${nativeVerifierOutput}`;

    completeJob(jobId, {
      ...archived,
      verifierOutput,
    });

    sendProofToGotee(jobId);

    console.log(`✅ Proof job ${jobId} completed, ARM-verified, native-verified, and sent to GoTEE`);
    console.log(`Proof saved at: ${archived.proofPath}`);
    console.log(`VK saved at: ${archived.vkPath}`);
    console.log(`VK hash saved at: ${archived.vkHashPath}`);
    console.log(`Public inputs saved at: ${archived.publicInputsPath}`);
    console.log(`Batch saved at: ${archived.batchPath}`);
    console.log(verifierOutput);

    lastWaitingMessage = "";
  } catch (err) {
    console.error("❌ Proof generation failed:", err.message);

    if (jobId !== null) {
      failJob(jobId, err, verifierOutput);
    }
  } finally {
    proving = false;
  }
}

console.log("zkWeather proof daemon started.");
console.log("Working directory:", process.cwd());
console.log("DB path:", path.resolve("zkweather.db"));
console.log(`Circuit dir: ${CIRCUIT_DIR}`);
console.log(`Armory verifier dir: ${ARMORY_VERIFIER_DIR}`);
console.log(`Armory verifier: ${ARMORY_VERIFIER_BIN}`);
console.log(`Watching device: ${DEVICE_ID}`);
console.log(`Window size: ${WINDOW_SIZE}`);
console.log(`Tree size: ${TREE_SIZE}`);
console.log(`Threshold: ${THRESHOLD}`);
console.log(`Min count: ${MIN_COUNT}`);

console.log("\nVersion checks:");

try {
  run("bb", ["--version"], VERIFIER_DIR);
} catch (_) {
  console.error("Could not run bb --version");
}

try {
  run("nargo", ["--version"], VERIFIER_DIR);
} catch (_) {
  console.error("Could not run nargo --version");
}

generateProofForNextWindow().catch((err) => {
  console.error("Initial daemon run error:", err);
});

setInterval(() => {
  generateProofForNextWindow().catch((err) => {
    console.error("Daemon loop error:", err);
  });
}, POLL_INTERVAL_MS);