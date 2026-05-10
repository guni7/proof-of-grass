## High-level architecture

```text
ESP8266 + DHT22
  |
  | signed temperature/humidity readings
  v
MQTT Broker
  |
  v
Node Verifier
  |
  | verifies device_id, firmware_hash, signature, nonce, timestamp
  v
SQLite verified readings
  |
  v
Batch Builder
  |
  | Poseidon Merkle root over verified readings
  v
Noir Circuit
  |
  | proves temperature threshold condition
  v
Ultra Honk Proof
  |
  v
armory-verifier in Docker ARM/QEMU
  |
  | VALID
  v
GoTEE Applet
  |
  | receives verified result / secure handoff
  v
Optional smart contract / reward trigger
