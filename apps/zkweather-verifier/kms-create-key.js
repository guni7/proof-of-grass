const {
  createEthereumKey,
  loadDotEnv,
  normalizeEthereumAddress,
  readConfig,
} = require("./orbitport-kms");

async function main() {
  loadDotEnv();

  const config = readConfig();
  const alias =
    process.argv[2] ||
    process.env.ZKWEATHER_KMS_KEY_ALIAS ||
    `zkweather-esp8266-eth-${Date.now()}`;

  const result = await createEthereumKey(config, alias);
  const metadata = result.KeyMetadata || {};
  const keyId = metadata.KeyId;
  const address = metadata.Address ? normalizeEthereumAddress(metadata.Address) : "";

  if (!keyId || !address) {
    throw new Error("KMS CreateKey response must include KeyMetadata.KeyId and Address");
  }

  console.log(
    JSON.stringify(
      {
        alias,
        keyId,
        address,
      },
      null,
      2
    )
  );

  console.log("\nAdd these server-side env values for the signer/verifier:");
  console.log("ZKWEATHER_SIGNATURE_SCHEME=ethereum_secp256k1_eip191");
  console.log(`ZKWEATHER_ETHEREUM_KMS_KEY_ID=${keyId}`);
  console.log(`ZKWEATHER_ETHEREUM_SIGNER_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
