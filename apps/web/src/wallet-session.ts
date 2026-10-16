import type { Vault } from "./vault.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytes, hex } from "@satora/striker-protocol/browser";

const sessionStorageKey = "striker.wallet.session.v1";
const encoder = new TextEncoder();
interface SessionKeys {
  get(id: string): Promise<CryptoKey | undefined>;
  put(id: string, key: CryptoKey): Promise<void>;
  delete(id: string): Promise<void>;
}

// IndexedDB can store non-extractable CryptoKeys without serializing key bytes.
class BrowserSessionKeys implements SessionKeys {
  private async request<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("striker-wallet-sessions", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("keys");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Wallet session storage is blocked"));
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction("keys", mode);
        const request = action(transaction.objectStore("keys"));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }
  get(id: string) {
    return this.request<CryptoKey | undefined>("readonly", (store) => store.get(id));
  }
  async put(id: string, key: CryptoKey) {
    await this.request("readwrite", (store) => store.put(key, id));
  }
  async delete(id: string) {
    await this.request("readwrite", (store) => store.delete(id));
  }
}

const vaultIdentity = (vault: Vault) =>
  [vault.publicKey, vault.salt, vault.iv, vault.ciphertext].join(":");

export class WalletSession {
  constructor(
    private readonly storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">,
    private readonly keys: SessionKeys,
  ) {}

  private read(): { id: string; vault: string; iv: string; ciphertext: string } | null {
    const raw = this.storage().getItem(sessionStorageKey);
    if (!raw) return null;
    const record = JSON.parse(raw);
    return record?.version === 1 && typeof record.id === "string" &&
      /^[0-9a-f-]{36}$/.test(record.id) && typeof record.vault === "string" &&
      typeof record.iv === "string" && typeof record.ciphertext === "string"
      ? record : null;
  }

  async clear() {
    let previous;
    try { previous = this.read(); }
    catch { /* Remove malformed or inaccessible session records. */ }
    try { this.storage().removeItem(sessionStorageKey); }
    catch { /* Storage may be disabled. The password vault remains untouched. */ }
    if (previous) await this.keys.delete(previous.id).catch(() => {});
  }

  async remember(vault: Vault, secret: Uint8Array): Promise<boolean> {
    await this.clear();
    const id = crypto.randomUUID();
    try {
      if (secret.length !== 32 || hex(schnorr.getPublicKey(secret)) !== vault.publicKey)
        throw new Error("Session belongs to another wallet");
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({
        name: "AES-GCM", iv, additionalData: encoder.encode(vaultIdentity(vault)),
      }, key, new Uint8Array(secret));
      await this.keys.put(id, key);
      this.storage().setItem(sessionStorageKey, JSON.stringify({
        version: 1, id, vault: vaultIdentity(vault),
        iv: hex(iv), ciphertext: hex(new Uint8Array(ciphertext)),
      }));
      return true;
    } catch {
      await this.keys.delete(id).catch(() => {});
      return false;
    }
  }

  async restore(vault: Vault): Promise<Uint8Array | null> {
    try {
      const saved = this.read();
      if (saved?.vault === vaultIdentity(vault)) {
        const key = await this.keys.get(saved.id);
        if (key && !key.extractable && key.algorithm.name === "AES-GCM" && key.usages.includes("decrypt")) {
          const plaintext = await crypto.subtle.decrypt({
            name: "AES-GCM", iv: new Uint8Array(bytes(saved.iv, 12, "session nonce")),
            additionalData: encoder.encode(vaultIdentity(vault)),
          }, key, new Uint8Array(bytes(saved.ciphertext, 48, "session ciphertext")));
          const secret = new Uint8Array(plaintext);
          if (hex(schnorr.getPublicKey(secret)) === vault.publicKey) return secret;
        }
      }
    } catch { /* A missing or damaged session falls back to password unlock. */ }
    await this.clear();
    return null;
  }
}

// Only this tab holds the encrypted session secret. The IndexedDB key cannot
// decrypt the permanent password vault after the tab's session storage is gone.
export const walletSession = new WalletSession(() => sessionStorage, new BrowserSessionKeys());
