#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <time.h>

#define DHTPIN D2
#define DHTTYPE DHT22

// Your WiFi details
const char* ssid = "Gunit";
const char* password = "qwertyuiop";

// Your Rust MQTT broker IP and port
const char* mqtt_server = "172.20.10.3";
const int mqtt_port = 1883;

// Local KMS signing proxy. It keeps Orbitport credentials off the ESP8266.
const char* kms_signer_url = "http://172.20.10.3:3002/sign";

WiFiClient espClient;
PubSubClient mqtt(espClient);
DHT dht(DHTPIN, DHTTYPE);

uint32_t nonce = 0;

struct KmsSignature {
  bool ok;
  String signatureScheme;
  String signerAddress;
  String signatureHex;
  String error;
};

String jsonEscape(const String& value) {
  String out = "";

  for (unsigned int i = 0; i < value.length(); i++) {
    char c = value.charAt(i);
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (c == '\n') {
      out += "\\n";
    } else if (c == '\r') {
      out += "\\r";
    } else if (c == '\t') {
      out += "\\t";
    } else if ((uint8_t)c >= 0x20) {
      out += c;
    }
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

String buildSigningRequest(
  const String& deviceId,
  uint32_t nonce,
  uint32_t timestamp,
  int tempX10,
  int humidityX10,
  const String& firmwareHash,
  const String& canonicalMessage
) {
  String json = "{";
  json += "\"device_id\":\"" + jsonEscape(deviceId) + "\",";
  json += "\"nonce\":" + String(nonce) + ",";
  json += "\"timestamp\":" + String(timestamp) + ",";
  json += "\"temperature_c_x10\":" + String(tempX10) + ",";
  json += "\"humidity_x10\":" + String(humidityX10) + ",";
  json += "\"firmware_hash\":\"" + jsonEscape(firmwareHash) + "\",";
  json += "\"canonical_message\":\"" + jsonEscape(canonicalMessage) + "\"";
  json += "}";

  return json;
}

String extractJsonString(const String& json, const String& key) {
  String pattern = "\"" + key + "\"";
  int keyIndex = json.indexOf(pattern);
  if (keyIndex < 0) return "";

  int colonIndex = json.indexOf(':', keyIndex + pattern.length());
  if (colonIndex < 0) return "";

  int startIndex = json.indexOf('"', colonIndex + 1);
  if (startIndex < 0) return "";

  String out = "";
  bool escaping = false;
  for (unsigned int i = startIndex + 1; i < json.length(); i++) {
    char c = json.charAt(i);
    if (escaping) {
      out += c;
      escaping = false;
    } else if (c == '\\') {
      escaping = true;
    } else if (c == '"') {
      return out;
    } else {
      out += c;
    }
  }

  return "";
}

bool isHexString(const String& value, unsigned int expectedLength) {
  if (value.length() != expectedLength) return false;

  for (unsigned int i = 0; i < value.length(); i++) {
    char c = value.charAt(i);
    bool isHex =
      (c >= '0' && c <= '9') ||
      (c >= 'a' && c <= 'f') ||
      (c >= 'A' && c <= 'F');

    if (!isHex) return false;
  }

  return true;
}

bool isEthereumAddress(const String& value) {
  if (value.length() != 42) return false;
  if (value.charAt(0) != '0' || value.charAt(1) != 'x') return false;

  for (unsigned int i = 2; i < value.length(); i++) {
    char c = value.charAt(i);
    bool isHex =
      (c >= '0' && c <= '9') ||
      (c >= 'a' && c <= 'f') ||
      (c >= 'A' && c <= 'F');

    if (!isHex) return false;
  }

  return true;
}

bool isEthereumSignature(const String& value) {
  return value.length() == 132 &&
         value.charAt(0) == '0' &&
         value.charAt(1) == 'x' &&
         isHexString(value.substring(2), 130);
}

KmsSignature requestKmsSignature(
  const String& deviceId,
  uint32_t nonce,
  uint32_t timestamp,
  int tempX10,
  int humidityX10,
  const String& firmwareHash,
  const String& canonicalMessage
) {
  KmsSignature result;
  result.ok = false;

  WiFiClient kmsClient;
  HTTPClient http;

  if (!http.begin(kmsClient, kms_signer_url)) {
    result.error = "failed to initialize KMS HTTP client";
    return result;
  }

  http.addHeader("Content-Type", "application/json");
  http.setTimeout(15000);

  String requestBody = buildSigningRequest(
    deviceId,
    nonce,
    timestamp,
    tempX10,
    humidityX10,
    firmwareHash,
    canonicalMessage
  );

  int statusCode = http.POST(requestBody);
  String responseBody = http.getString();
  http.end();

  if (statusCode != 200) {
    result.error = "KMS signer HTTP " + String(statusCode) + ": " + responseBody;
    return result;
  }

  String signerAddress = extractJsonString(responseBody, "signer_address");
  if (signerAddress == "") {
    signerAddress = extractJsonString(responseBody, "public_key");
  }

  String signatureHex = extractJsonString(responseBody, "signature");
  String scheme = extractJsonString(responseBody, "signature_scheme");
  String signedCanonical = extractJsonString(responseBody, "canonical_message");

  if (scheme != "ethereum_secp256k1_eip191") {
    result.error = "KMS signer returned unsupported signature scheme";
    return result;
  }

  if (!isEthereumAddress(signerAddress)) {
    result.error = "KMS signer returned invalid Ethereum signer address";
    return result;
  }

  if (!isEthereumSignature(signatureHex)) {
    result.error = "KMS signer returned invalid Ethereum signature";
    return result;
  }

  if (signedCanonical != "" && signedCanonical != canonicalMessage) {
    result.error = "KMS signer canonical message mismatch";
    return result;
  }

  result.ok = true;
  result.signatureScheme = scheme;
  result.signerAddress = signerAddress;
  result.signatureHex = signatureHex;
  return result;
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
  const String& signatureScheme,
  const String& signerAddress,
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
  json += "\"signature_scheme\":\"" + signatureScheme + "\",";
  json += "\"public_key\":\"" + signerAddress + "\",";
  json += "\"signer_address\":\"" + signerAddress + "\",";
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
  Serial.println("==== ESP8266 DHT22 MQTT KMS STARTED ====");

  dht.begin();
  Serial.println("DHT22 started");

  Serial.print("Device ID: ");
  Serial.println(getDeviceId());

  Serial.print("Firmware hash / sketch MD5: ");
  Serial.println(getFirmwareHash());

  Serial.print("KMS signer URL: ");
  Serial.println(kms_signer_url);

  connectWifi();
  setupTime();

  mqtt.setServer(mqtt_server, mqtt_port);

  // JSON includes an Ethereum 65-byte signature and signer address.
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
  String canonicalMessage = buildCanonicalMessage(
    deviceId,
    nonce,
    timestamp,
    tempX10,
    humidityX10,
    firmwareHash
  );

  Serial.println();
  Serial.println("Requesting KMS signature...");
  unsigned long signStart = millis();
  KmsSignature kmsSignature = requestKmsSignature(
    deviceId,
    nonce,
    timestamp,
    tempX10,
    humidityX10,
    firmwareHash,
    canonicalMessage
  );
  unsigned long signEnd = millis();

  if (!kmsSignature.ok) {
    Serial.print("KMS signing failed: ");
    Serial.println(kmsSignature.error);
    delay(5000);
    return;
  }

  String signedPayload = buildJsonPayload(
    deviceId,
    nonce,
    timestamp,
    tempX10,
    humidityX10,
    firmwareHash,
    kmsSignature.signatureScheme,
    kmsSignature.signerAddress,
    kmsSignature.signatureHex,
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

  Serial.print("Signature scheme: ");
  Serial.println(kmsSignature.signatureScheme);

  Serial.print("Signer identity: ");
  Serial.println(kmsSignature.signerAddress);

  Serial.print("Canonical message: ");
  Serial.println(canonicalMessage);

  Serial.print("Signature: ");
  Serial.println(kmsSignature.signatureHex);

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
