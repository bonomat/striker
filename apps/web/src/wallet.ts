import {
  ArkAddress,
  EsploraProvider,
  IndexedDBContractRepository,
  IndexedDBWalletRepository,
  SingleKey,
  Wallet,
} from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  connectChainWithSettings,
  hex,
} from "@satora/striker-protocol/browser";
import { TakerClient, type SavedSwap, type SwapStore } from "@satora/taker-sdk";
import type { AppConfig } from "./config.js";

export const vaultStorageKey = "striker.wallet.v1";
export class BrowserSwapStore implements SwapStore {
  constructor(
    readonly prefix: string,
    readonly changed: () => void,
  ) {}
  async get(id: string): Promise<SavedSwap | undefined> {
    const raw = localStorage.getItem(`${this.prefix}:${id}`);
    return raw ? (JSON.parse(raw) as SavedSwap) : undefined;
  }
  async put(swap: SavedSwap) {
    localStorage.setItem(
      `${this.prefix}:${swap.response.quoteId}`,
      JSON.stringify(swap),
    );
    this.changed();
  }
  list(): SavedSwap[] {
    const records: SavedSwap[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (!key.startsWith(`${this.prefix}:`)) continue;
      try {
        const record = JSON.parse(localStorage.getItem(key)!) as SavedSwap;
        if (record.version === 1 && record.response?.quoteId)
          records.push(record);
      } catch {
        /* Ignore invalid records; the SDK validates every resumed swap. */
      }
    }
    return records.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }
}
export async function connectWallet(
  config: AppConfig,
  key: Uint8Array,
  changed: () => void,
) {
  const publicKey = schnorr.getPublicKey(key),
    publicHex = hex(publicKey);
  const chain = await connectChainWithSettings({
    ...config,
    ...(config.strikerUrl ? {} : {
      arkUrl: `${location.origin}/api/ark`,
      emulatorUrl: `${location.origin}/api/emulator`,
      esploraUrl: `${location.origin}/api/esplora`,
    }),
  });
  const identity = SingleKey.fromPrivateKey(key);
  const database = `striker-${config.network}-${publicHex}`;
  const wallet = await Wallet.create({
    identity,
    arkProvider: chain.ark,
    onchainProvider: new EsploraProvider(chain.settings.esploraUrl, {
      forcePolling: true,
      pollingInterval: 3000,
    }),
    storage: {
      walletRepository: new IndexedDBWalletRepository(database),
      contractRepository: new IndexedDBContractRepository(
        database + "-contracts",
      ),
    },
    settlementConfig: false,
  });
  const address = await wallet.getAddress();
  const store = new BrowserSwapStore(
    `striker.swaps:${config.network}:${chain.server.toString()}:${publicHex}`,
    changed,
  );
  const client = new TakerClient({
    chain,
    actor: {
      wallet,
      identity,
      publicKey,
      payoutScript: ArkAddress.decode(address).pkScript,
    },
    strikerUrl: config.strikerUrl ?? `${location.origin}/api/striker`,
    store,
  });
  return { wallet, identity, address, publicHex, client, store };
}
export type ConnectedWallet = Awaited<ReturnType<typeof connectWallet>>;
export async function withWalletLock<T>(
  account: ConnectedWallet,
  action: () => Promise<T>,
): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "This browser needs Web Locks support to execute a swap safely.",
    );
  return navigator.locks.request(`striker-wallet:${account.publicHex}`, action);
}
