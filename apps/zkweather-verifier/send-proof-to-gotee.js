const fs = require("fs");
const net = require("net");
const path = require("path");

const jobId = process.argv[2];

if (!jobId) {
  console.error("Usage: node send-proof-to-gotee.js <job-id>");
  process.exit(1);
}

const jobDir = path.join("proofs", `job-${jobId}`);

if (!fs.existsSync(jobDir)) {
  console.error(`Job directory not found: ${jobDir}`);
  process.exit(1);
}

function readBase64IfExists(filename) {
  const filePath = path.join(jobDir, filename);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return fs.readFileSync(filePath).toString("base64");
}

function readJsonIfExists(filename) {
  const filePath = path.join(jobDir, filename);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const proofB64 = readBase64IfExists("proof");
const vkB64 = readBase64IfExists("vk");
const publicInputsB64 = readBase64IfExists("public_inputs");
const batch = readJsonIfExists("merkle-batch.json");

if (!proofB64) {
  console.error(`Missing proof file: ${path.join(jobDir, "proof")}`);
  process.exit(1);
}

if (!vkB64) {
  console.error(`Missing vk file: ${path.join(jobDir, "vk")}`);
  process.exit(1);
}

if (!batch) {
  console.error(`Missing merkle-batch.json file`);
  process.exit(1);
}

const inputPayload = {
  job_id: Number(jobId),

  proof_b64: proofB64,
  vk_b64: vkB64,
  public_inputs_b64: publicInputsB64,

  metadata: {
    device_id: batch.device_id,
    merkle_root: batch.merkle_root,
    threshold: batch.threshold,
    min_count: batch.min_count,
    window_start: batch.window_start,
    window_end: batch.window_end,
    actual_start_id: batch.actual_start_id,
    actual_end_id: batch.actual_end_id,
    hash: batch.hash,
  },
};

const request = {
  Method: "VerifyProof",
  Input: JSON.stringify(inputPayload),
};

const requestLine = JSON.stringify(request) + "\n";

console.log(`Sending job ${jobId} to GoTEE...`);
console.log(`Proof bytes base64 length: ${proofB64.length}`);
console.log(`VK bytes base64 length: ${vkB64.length}`);
console.log(`Request length: ${requestLine.length}`);

const socket = net.createConnection(
  {
    host: "127.0.0.1",
    port: 4000,
  },
  () => {
    socket.write(requestLine);
  }
);

let response = "";

socket.on("data", (chunk) => {
  response += chunk.toString();
});

socket.on("end", () => {
  console.log("Response from GoTEE:");
  console.log(response);
});

socket.on("error", (err) => {
  console.error("Bridge error:", err.message);
  process.exit(1);
});