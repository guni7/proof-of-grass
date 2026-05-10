const {
  createEd25519Key,
  loadDotEnv,
  normalizePublicKey,
  readConfig,
} = require("./orbitport-kms");

async function main() {
  loadDotEnv();

  const config = readConfig();
  const alias =
    process.argv[2] ||
    process.env.ZKWEATHER_KMS_KEY_ALIAS ||
    `zkweather-${Date.now()}`;

  const result = await createEd25519Key(config, alias);
  const metadata = result.KeyMetadata || {};
  const keyId = metadata.KeyId;
  const publicKey = metadata.PublicKey ? normalizePublicKey(metadata.PublicKey) : "";

  if (!keyId) {
    throw new Error("KMS CreateKey response did not include KeyMetadata.KeyId");
  }

  console.log(
    JSON.stringify(
      {
        alias,
        keyId,
        publicKey: publicKey || null,
      },
      null,
      2
    )
  );

  console.log("\nAdd these server-side env values for the signer/verifier:");
  console.log(`ZKWEATHER_KMS_KEY_ID=${keyId}`);
  if (publicKey) {
    console.log(`ZKWEATHER_PUBLIC_KEY=${publicKey}`);
  } else {
    console.log(
      "ZKWEATHER_PUBLIC_KEY=<KMS public key was not returned; fetch key metadata and set it here>"
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
