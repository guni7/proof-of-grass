# ESP8266 Weather Publisher

The active hardware sketch lives at [`../hardware/esp.ino`](../hardware/esp.ino).

That sketch uses a local KMS signing proxy instead of embedding an Ed25519
private key on the ESP8266. Keep the Orbitport OAuth credentials and KMS key ID
server-side in `apps/zkweather-verifier/.env`.
