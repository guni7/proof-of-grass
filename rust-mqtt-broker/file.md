# ESP8266 Weather Publisher

The active hardware sketch lives at [`../hardware/esp.ino`](../hardware/esp.ino).

That sketch uses a local KMS signing proxy instead of embedding private key
material on the ESP8266. Keep the Orbitport OAuth credentials and Ethereum KMS
key ID server-side in `apps/zkweather-verifier/.env`.
