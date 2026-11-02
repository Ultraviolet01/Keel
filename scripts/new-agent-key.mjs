#!/usr/bin/env node
// Generates Keel's agent keypair. The factory adds the public key to every new
// vault as a function-call key; the agent service signs with the private key.
//
//   node scripts/new-agent-key.mjs [path]
//
// Saves {public_key, private_key} in NEAR's key-file format to path (default
// ~/.near-credentials/keel-agent-key.json, readable only by you) and prints
// only the public key. Never commit the key file.

import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

const path = process.argv[2] ?? join(homedir(), ".near-credentials", "keel-agent-key.json");
if (existsSync(path)) {
  console.error(`${path} already exists; refusing to overwrite it.`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
// Raw 32-byte keys from their DER encodings.
const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);

const keyFile = {
  public_key: `ed25519:${base58(pub)}`,
  private_key: `ed25519:${base58(Buffer.concat([seed, pub]))}`,
};
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(keyFile, null, 2) + "\n", { mode: 0o600 });
console.log(`Saved to ${path}`);
console.log(keyFile.public_key);
