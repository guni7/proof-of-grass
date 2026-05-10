set positional-arguments := true

verifier := "apps/zkweather-verifier"
broker := "rust-mqtt-broker"
poseidon_helper := "circuits/zkweather_poseidon_helper"
threshold_circuit := "circuits/zkweather_threshold"

# Show available commands.
default:
    @just --list

# Install Node dependencies for the verifier app.
deps:
    cd {{ verifier }} && npm ci

# Check local toolchain, npm packages, and non-secret KMS config.
doctor:
    @node --version
    @npm --version
    @cargo --version
    @zsh -lc 'export PATH="$HOME/.nargo/bin:$PATH"; source ~/.zshrc >/dev/null 2>&1 || true; nargo --version'
    @cd {{ verifier }} && npm ls ethers better-sqlite3 mqtt --depth=0
    @node -e 'const { loadDotEnv, readConfig } = require("./apps/zkweather-verifier/orbitport-kms"); loadDotEnv(); const c = readConfig(); const required = { ZKWEATHER_ETHEREUM_KMS_KEY_ID: c.keyId, ZKWEATHER_ETHEREUM_SIGNER_ADDRESS: c.signerAddress }; for (const [k, v] of Object.entries(required)) { if (!v) throw new Error(`Missing ${k}`); console.log(`${k}=${v}`); }'

# Run unit checks that do not require live services.
test:
    cd {{ verifier }} && npm test

# Start the Rust MQTT broker.
broker:
    cd {{ broker }} && cargo run

# Start the local HTTP signer proxy. Requires apps/zkweather-verifier/.env.
signer:
    cd {{ verifier }} && npm run kms:signer

# Start the MQTT verifier/storage process.
verifier:
    cd {{ verifier }} && npm start

# Live Orbitport KMS signing check.
kms-e2e:
    cd {{ verifier }} && npm run e2e:kms

# Publish one KMS-signed MQTT reading. Requires broker, signer, and verifier running.
mqtt-e2e:
    cd {{ verifier }} && npm run e2e:mqtt

# Publish N KMS-signed MQTT readings. Requires broker, signer, and verifier running.
seed-readings count="5":
    cd {{ verifier }} && for i in {1..{{ count }}}; do npm run e2e:mqtt; sleep 1; done

# Compile the Noir Poseidon helper circuit.
poseidon:
    zsh -lc 'export PATH="$HOME/.nargo/bin:$PATH"; source ~/.zshrc >/dev/null 2>&1 || true; cd {{ poseidon_helper }}; nargo compile'

# Generate Merkle batch metadata and circuits/zkweather_threshold/Prover.toml.
proof-input:
    zsh -lc 'export PATH="$HOME/.nargo/bin:$PATH"; source ~/.zshrc >/dev/null 2>&1 || true; cd {{ verifier }}; node make-merkle-prover-input.js'

# Generate proof input, then solve the Noir threshold circuit witness.
witness: proof-input
    zsh -lc 'export PATH="$HOME/.nargo/bin:$PATH"; source ~/.zshrc >/dev/null 2>&1 || true; cd {{ threshold_circuit }}; nargo execute'

# Run the proof daemon. Requires nargo and bb on PATH for full proof generation.
proof-daemon:
    zsh -lc 'export PATH="$HOME/.nargo/bin:$PATH"; source ~/.zshrc >/dev/null 2>&1 || true; cd {{ verifier }}; node proof-daemon.js'

# Show how many readings are in the local verifier database.
db-count:
    cd {{ verifier }} && node -e 'const Database = require("better-sqlite3"); const db = new Database("zkweather.db"); console.log(db.prepare("SELECT COUNT(*) AS count FROM readings").get()); db.close();'
