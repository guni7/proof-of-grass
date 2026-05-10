#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <Ed25519.h>
#include <time.h>

#define DHTPIN D2
#define DHTTYPE DHT22

// Your WiFi details
const char* ssid = "Gunit";
const char* password = "qwertyuiop";

// Your Rust MQTT broker IP and port
const char* mqtt_server = "172.20.10.3";
const int mqtt_port = 1883;

WiFiClient espClient;
PubSubClient mqtt(espClient);
DHT dht(DHTPIN, DHTTYPE);

uint32_t nonce = 0;

// -----------------------------------------------------------------------------
// Ed25519 keypair
//
// Private key: 32 bytes
// Public key:  32 bytes
//
// IMPORTANT:
// This keypair is for demo only. Generate your own later.
// Do not use this key for real funds.
// -----------------------------------------------------------------------------

uint8_t privateKey[32] = {
  0x1f, 0x1e, 0x1d, 0x1c, 0x1b, 0x1a, 0x19, 0x18,
  0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11, 0x10,
  0x0f, 0x0e, 0x0d, 0x0c, 0x0b, 0x0a, 0x09, 0x08,
  0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0x00
};

uint8_t publicKey[32];

String bytesToHex(const uint8_t* data, size_t len) {
  const char hexChars[] = "0123456789abcdef";
  String out = "";

  for (size_t i = 0; i < len; i++) {
    out += hexChars[(data[i] >> 4) & 0x0F];
    out += hexChars[data[i] & 0x0F];
  }

  return out;
}

String getDeviceId() {
  return "esp8266-" + String(ESP.getChipId(), HEX);
}

String getFirmwareHash() {
  return ESP.getSketchMD5();
}

String buildCanonicalMessage(
  const String& deviceId,
  uint32_t nonce,
  uint32_t timestamp,
  int tempX10,
  int humidityX10,
  const String& firmwareHash
) {
  return deviceId + "|" +
         String(nonce) + "|" +
         String(timestamp) + "|" +
         String(tempX10) + "|" +
         String(humidityX10) + "|" +
         firmwareHash;
}

String signEd25519(const String& message) {
  uint8_t signature[64];

  Ed25519::sign(
    signature,
    privateKey,
    publicKey,
    message.c_str(),
    message.length()
  );

  return bytesToHex(signature, 64);
}

uint32_t getUnixTimestamp() {
  time_t now = time(nullptr);

  if (now < 1700000000) {
    return 0;
  }

  return (uint32_t)now;
}

String buildJsonPayload(
  const String& deviceId,
  uint32_t nonce,
  uint32_t timestamp,
  int tempX10,
  int humidityX10,
  const String& firmwareHash,
  const String& publicKeyHex,
  const String& signature,
  const String& localIp
) {
  String json = "{";
  json += "\"device_id\":\"" + deviceId + "\",";
  json += "\"nonce\":" + String(nonce) + ",";
  json += "\"timestamp\":" + String(timestamp) + ",";
  json += "\"temperature_c_x10\":" + String(tempX10) + ",";
  json += "\"humidity_x10\":" + String(humidityX10) + ",";
  json += "\"firmware_hash\":\"" + firmwareHash + "\",";
  json += "\"signature_scheme\":\"ed25519\",";
  json += "\"public_key\":\"" + publicKeyHex + "\",";
  json += "\"signature\":\"" + signature + "\",";
  json += "\"local_ip\":\"" + localIp + "\"";
  json += "}";

  return json;
}

void connectWifi() {
  Serial.println();
  Serial.print("Connecting to WiFi: ");
  Serial.println(ssid);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  int attempts = 0;

  while (WiFi.status() != WL_CONNECTED && attempts < 60) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi connected!");
    Serial.print("ESP8266 IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi connection failed.");
    Serial.print("WiFi status code: ");
    Serial.println(WiFi.status());
  }
}

void setupTime() {
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");

  Serial.print("Waiting for NTP time sync");

  time_t now = time(nullptr);
  int attempts = 0;

  while (now < 1700000000 && attempts < 40) {
    delay(500);
    Serial.print(".");
    now = time(nullptr);
    attempts++;
  }

  Serial.println();

  if (now >= 1700000000) {
    Serial.print("NTP time synced. Unix time: ");
    Serial.println(now);
  } else {
    Serial.println("NTP time sync failed. Will not publish signed readings yet.");
  }
}

void connectMqtt() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Cannot connect to MQTT because WiFi is not connected.");
    return;
  }

  while (!mqtt.connected()) {
    Serial.print("Connecting to MQTT broker at ");
    Serial.print(mqtt_server);
    Serial.print(":");
    Serial.print(mqtt_port);
    Serial.print(" ... ");

    String clientId = "esp8266-dht22-";
    clientId += String(ESP.getChipId(), HEX);

    if (mqtt.connect(clientId.c_str())) {
      Serial.println("connected");

      String statusPayload =
        "{\"status\":\"online\",\"device_id\":\"" + getDeviceId() + "\"}";

      mqtt.publish("weather/dht22/status", statusPayload.c_str(), true);

    } else {
      Serial.print("failed, rc=");
      Serial.print(mqtt.state());
      Serial.println(" retrying in 2 seconds");
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(3000);

  Serial.println();
  Serial.println("==== ESP8266 DHT22 MQTT ED25519 STARTED ====");

  dht.begin();
  Serial.println("DHT22 started");

  // Derive public key from private key once at boot.
  Ed25519::derivePublicKey(publicKey, privateKey);

  Serial.print("Device ID: ");
  Serial.println(getDeviceId());

  Serial.print("Firmware hash / sketch MD5: ");
  Serial.println(getFirmwareHash());

  Serial.print("Ed25519 public key: ");
  Serial.println(bytesToHex(publicKey, 32));

  connectWifi();
  setupTime();

  mqtt.setServer(mqtt_server, mqtt_port);

  // JSON includes 64-byte signature as 128 hex chars, so give MQTT enough room.
  mqtt.setBufferSize(1024);
}



void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected. Retrying...");
    connectWifi();
    delay(2000);
    return;
  }

  if (!mqtt.connected()) {
    connectMqtt();
  }

  mqtt.loop();

  float humidity = dht.readHumidity();
  float temperature = dht.readTemperature();

  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("Failed to read DHT22");
    delay(2500);
    return;
  }

  int tempX10 = (int)(temperature * 10);
  int humidityX10 = (int)(humidity * 10);

  nonce++;

  uint32_t timestamp = getUnixTimestamp();

  if (timestamp == 0) {
    Serial.println("No valid NTP timestamp yet. Skipping signed publish.");
    delay(5000);
    return;
  }

  String deviceId = getDeviceId();
  String firmwareHash = getFirmwareHash();
  String localIp = WiFi.localIP().toString();
  String publicKeyHex = bytesToHex(publicKey, 32);

  String canonicalMessage = buildCanonicalMessage(
    deviceId,
    nonce,
    timestamp,
    tempX10,
    humidityX10,
    firmwareHash
  );

  Serial.println();
  Serial.println("Signing message with Ed25519...");
  unsigned long signStart = millis();
  String signature = signEd25519(canonicalMessage);
  unsigned long signEnd = millis();

  String signedPayload = buildJsonPayload(
    deviceId,
    nonce,
    timestamp,
    tempX10,
    humidityX10,
    firmwareHash,
    publicKeyHex,
    signature,
    localIp
  );

  char tempStr[16];
  char humStr[16];

  dtostrf(temperature, 4, 1, tempStr);
  dtostrf(humidity, 4, 1, humStr);

  bool tempPublished = mqtt.publish("weather/dht22/temperature", tempStr);
  bool humPublished = mqtt.publish("weather/dht22/humidity", humStr);
  bool signedPublished = mqtt.publish("weather/dht22/signed", signedPayload.c_str());

  Serial.print("Temperature: ");
  Serial.print(tempStr);
  Serial.print(" C | Humidity: ");
  Serial.print(humStr);
  Serial.println(" %");

  Serial.print("Device ID: ");
  Serial.println(deviceId);

  Serial.print("Firmware hash: ");
  Serial.println(firmwareHash);

  Serial.print("Public key: ");
  Serial.println(publicKeyHex);

  Serial.print("Canonical message: ");
  Serial.println(canonicalMessage);

  Serial.print("Ed25519 signature: ");
  Serial.println(signature);

  Serial.print("Signing took ms: ");
  Serial.println(signEnd - signStart);

  Serial.print("Signed JSON payload: ");
  Serial.println(signedPayload);

  Serial.print("MQTT publish status: temp=");
  Serial.print(tempPublished);
  Serial.print(", humidity=");
  Serial.print(humPublished);
  Serial.print(", signed=");
  Serial.println(signedPublished);

  delay(5000);
}
