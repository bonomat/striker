import { schnorr } from "@noble/curves/secp256k1.js";
import { bytes, hex, object } from "@satora/striker-protocol/browser";
export interface Vault {
  version: 1;
  publicKey: string;
  salt: string;
  iv: string;
  ciphertext: string;
}
export interface RecoveryBackup {
  version: 1;
  type: "striker-recovery";
  privateKey: string;
  publicKey: string;
}
export function createRecoveryBackup(privateKey: string): RecoveryBackup {
  const secret = bytes(privateKey.trim(), 32, "private key");
  try {
    return {
      version: 1,
      type: "striker-recovery",
      privateKey: hex(secret),
      publicKey: hex(schnorr.getPublicKey(secret)),
    };
  } catch {
    throw new Error("Invalid private key");
  }
}
export function parseRecoveryBackup(value: unknown): RecoveryBackup {
  const record = object(value);
  if (record.version !== 1 || record.type !== "striker-recovery")
    throw new Error("Unsupported recovery backup");
  const backup = createRecoveryBackup(String(record.privateKey ?? ""));
  if (backup.publicKey !== record.publicKey)
    throw new Error("Recovery backup public key mismatch");
  return backup;
}
const encoder = new TextEncoder();
async function encryptionKey(password: string, salt: Uint8Array) {
  if (password.length < 1 || password.length > 256)
    throw new Error("Use a password between 1 and 256 characters.");
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new Uint8Array(salt),
      iterations: 310_000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export function parseVault(value: unknown): Vault {
  const record = object(value);
  if (record.version !== 1) throw new Error("Unsupported wallet backup");
  bytes(record.publicKey, 32, "wallet public key");
  bytes(record.salt, 16, "wallet salt");
  bytes(record.iv, 12, "wallet nonce");
  bytes(record.ciphertext, 48, "encrypted key");
  return record as unknown as Vault;
}
export async function encryptWallet(
  password: string,
  importedKey?: string,
): Promise<Vault> {
  const secret = importedKey
    ? bytes(importedKey.trim(), 32, "private key")
    : schnorr.utils.randomSecretKey();
  let publicKey: string;
  try {
    publicKey = hex(schnorr.getPublicKey(secret));
  } catch {
    throw new Error("Invalid private key");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(`striker-wallet:v1:${publicKey}`),
    },
    key,
    new Uint8Array(secret),
  );
  return {
    version: 1,
    publicKey,
    salt: hex(salt),
    iv: hex(iv),
    ciphertext: hex(new Uint8Array(ciphertext)),
  };
}
export async function decryptWallet(
  value: unknown,
  password: string,
): Promise<Uint8Array> {
  const vault = parseVault(value);
  const key = await encryptionKey(password, bytes(vault.salt, 16, "salt"));
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(bytes(vault.iv, 12, "nonce")),
        additionalData: encoder.encode(`striker-wallet:v1:${vault.publicKey}`),
      },
      key,
      new Uint8Array(bytes(vault.ciphertext, 48, "encrypted key")),
    );
    const secret = new Uint8Array(plaintext);
    if (hex(schnorr.getPublicKey(secret)) !== vault.publicKey)
      throw new Error("Wallet public key mismatch");
    return secret;
  } catch {
    throw new Error("Unable to unlock. Check your password and wallet backup.");
  }
}

/** Re-encrypt the same wallet using its original key when the password is lost. */
export async function recoverWallet(
  value: Vault,
  password: string,
  privateKey: string,
): Promise<Vault> {
  const recovered = await encryptWallet(password, privateKey);
  if (recovered.publicKey !== value.publicKey)
    throw new Error(
      "This private key belongs to another wallet. The saved wallet has not been replaced.",
    );
  return recovered;
}
