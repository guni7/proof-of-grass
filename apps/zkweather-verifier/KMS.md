# ZK Weather KMS Signing

The ESP8266 does not store private key material. It sends each weather reading
to a LAN signer, and that signer calls Orbitport KMS with server-side OAuth
credentials.

The project uses one signature scheme:

```text
ethereum_secp256k1_eip191
```

The MQTT payload keeps the existing `public_key` field for verifier
compatibility, but it contains the Ethereum signer address. The payload also
includes `signer_address` with the same value.

Current live KMS key:

```text
ZKWEATHER_ETHEREUM_KMS_KEY_ID=kms:zkweather-esp8266-eth-20260510
ZKWEATHER_ETHEREUM_SIGNER_ADDRESS=0x70136c02C29229D5dA1cbC7706C59Cc7374bCC81
```

## Setup

Use `.env.example` as the shape for `apps/zkweather-verifier/.env`, then fill
in the Orbitport OAuth values. Keep `.env` out of source control.

To create a replacement Ethereum KMS key:

```bash
cd apps/zkweather-verifier
npm run kms:create-key -- zkweather-esp8266-eth
```

Put the printed `ZKWEATHER_ETHEREUM_KMS_KEY_ID` and
`ZKWEATHER_ETHEREUM_SIGNER_ADDRESS` in the server-side `.env`.

## Run

Start the local signer:

```bash
npm run kms:signer
```

Start the verifier in another shell:

```bash
npm start
```

Run a live KMS signer check:

```bash
npm run e2e:kms
```

With the Rust broker, signer, and verifier running, run the MQTT loop harness:

```bash
npm run e2e:mqtt
```

Flash `hardware/esp.ino` after confirming `mqtt_server` and `kms_signer_url`
point at the LAN IP of the machine running the broker and signer.

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

The signer reconstructs the canonical message, rejects mismatches, calls
`kms.Sign` with `SigningAlgorithm=ETHEREUM_SECP256K1` and
`MessageType=EIP191`, verifies the recovered address locally, then returns a
65-byte `0x` Ethereum signature for the MQTT payload. For this Orbitport RPC
path, the canonical string is sent directly in the JSON-RPC `Message` field
because that is the value KMS wraps with EIP-191.
