# ZK Weather KMS Signing

The ESP8266 no longer stores an Ed25519 private key. It sends each weather
reading to a LAN signer, and the signer calls Orbitport KMS with server-side
OAuth credentials. The MQTT payload still contains an Ed25519 public key and
signature, so the existing verifier path stays simple.

## Setup

Use `apps/zkweather-verifier/.env.example` as the shape for the ignored
server-side `.env`, then fill in the Orbitport OAuth values. Keep that file out
of source control.

Create a TRANSIT Ed25519 KMS key:

```bash
cd apps/zkweather-verifier
npm run kms:create-key -- zkweather-esp8266
```

Put the printed `ZKWEATHER_KMS_KEY_ID` and `ZKWEATHER_PUBLIC_KEY` in the
server-side `.env`.

Start the local signer:

```bash
npm run kms:signer
```

Start the verifier in another shell:

```bash
npm start
```

Flash `hardware/esp.ino` after confirming `kms_signer_url` points at the
machine running `npm run kms:signer`.

## Request Shape

The ESP posts the unsigned reading fields to `POST /sign`:

```json
{
  "device_id": "esp8266-daaa2c",
  "nonce": 1,
  "timestamp": 1700000000,
  "temperature_c_x10": 235,
  "humidity_x10": 512,
  "firmware_hash": "f7b62a2847d61cbbdf0cdd73bc0d15ac",
  "canonical_message": "esp8266-daaa2c|1|1700000000|235|512|f7b62a2847d61cbbdf0cdd73bc0d15ac"
}
```

The signer reconstructs the canonical message, rejects mismatches, signs it via
`kms.Sign` using `SigningAlgorithm=ED25519` and `MessageType=RAW`, then returns
hex signature material for the MQTT payload.
