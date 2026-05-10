const path = require("path");

const VERIFIER_DIR = __dirname;
const REPO_ROOT = path.resolve(VERIFIER_DIR, "..", "..");
const CIRCUITS_DIR = process.env.ZKWEATHER_CIRCUITS_DIR
  ? path.resolve(process.env.ZKWEATHER_CIRCUITS_DIR)
  : path.join(REPO_ROOT, "circuits");

const DB_PATH = process.env.ZKWEATHER_DB_PATH
  ? path.resolve(process.env.ZKWEATHER_DB_PATH)
  : path.join(VERIFIER_DIR, "zkweather.db");

const POSEIDON_HELPER_DIR = path.join(
  CIRCUITS_DIR,
  "zkweather_poseidon_helper"
);
const POSEIDON_HELPER_ARTIFACT = path.join(
  POSEIDON_HELPER_DIR,
  "target",
  "zkweather_poseidon_helper.json"
);
const THRESHOLD_CIRCUIT_DIR = path.join(CIRCUITS_DIR, "zkweather_threshold");
const THRESHOLD_PROVER_TOML = path.join(THRESHOLD_CIRCUIT_DIR, "Prover.toml");

module.exports = {
  CIRCUITS_DIR,
  DB_PATH,
  POSEIDON_HELPER_ARTIFACT,
  POSEIDON_HELPER_DIR,
  REPO_ROOT,
  THRESHOLD_CIRCUIT_DIR,
  THRESHOLD_PROVER_TOML,
  VERIFIER_DIR,
};
