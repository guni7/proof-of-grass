# 👁️ GodEye: The ZK-Oracle for Future Society

**GodEye** is a decentralized, privacy-preserving infrastructure for verifying real-world data at the edge. By combining **ZK-Proofs**, **Orbitport Satellite Signing**, and **GoTEE Enclaves**, GodEye creates an immutable truth layer for the Network Economy.

Use the repo-level `justfile` for common developer tasks.

```bash
just
just doctor
just test
```

## Local Services

Run these in separate terminals when testing the ESP/KMS/SIGNAL flow:

```bash
just broker
just signer
just verifier
```

Then publish one signed test reading:

```bash
just mqtt-e2e
```

To create enough local readings for proof input generation:

```bash
just seed-readings 5
```

## KMS

Check live Orbitport KMS signing:

```bash
just kms-e2e
```

The signer config lives in the ignored file:

```text
apps/zkweather-verifier/.env
```

## Proof Inputs

Compile the Poseidon helper circuit:

```bash
just poseidon
```

Generate `merkle-batch.json` and `circuits/zkweather_threshold/Prover.toml`:

```bash
just proof-input
```

Generate proof inputs and solve the threshold circuit witness:

```bash
just witness
```

`just` recipes source `~/.zshrc` before running Nargo so local installs under
`~/.nargo/bin` are picked up.
