import { CovenantWallet } from "./covenant-wallet.js";
export { CovenantWallet } from "./covenant-wallet.js";
export type { MaintenanceOperation, MaintenanceStore } from '@satora/striker-protocol/browser';
import {
  asset,
  buildOffchainTx,
  Extension,
  Transaction,
  type Identity,
  type IWallet,
} from "@arkade-os/sdk";
import {
  bytes,
  coinsAt, checkEmulator, reusableTakerContract, termsForInput, encodeIntent, MAX_INTENT_INPUTS,
  type SignedTakerInput,
  decimal,
  encodeBase64,
  decodeBase64,
  fundedCoin,
  hex,
  object,
  p2tr,
  parseOffer,
  parseQuoteRequest,
  requestJSON,
  string,
  takerContract,
  validateOfferFor,
  type Chain,
  type QuoteRequest,
  type QuoteResponse,
  type Direction,
} from "@satora/striker-protocol/browser";

// Funding can take several network round trips; leave time for covenant validation.
export const MIN_QUOTE_FUNDING_SECONDS = 30;
const MIN_QUOTE_SETTLEMENT_SECONDS = 5;

export interface SwapResult {
  quoteId: string;
  status: string;
  txid?: string;
}
export interface SavedSwap {
  version: 1;
  network: string;
  striker: string;
  request: QuoteRequest;
  response: QuoteResponse;
  createdAt?: number;
  intentInputs?: SignedTakerInput[];
  intentSubmittedAt?: number;
  cancellation?: { txid: string; arkTx: string; checkpoints: string[] };
  fundingStartedAt?: number;
  funding?: { fundingTxid: string; fundingVout?: string };
  result?: SwapResult;
  refund?: {
    txid: string;
    status: "submitted" | "refunded";
    checkpoints?: string[];
  };
}
export interface SwapStore {
  get(quoteId: string): Promise<SavedSwap | undefined>;
  put(swap: SavedSwap): Promise<void>;
  list?(): SavedSwap[] | Promise<SavedSwap[]>;
}
/** Expired intent authorizations cannot spend a renewed input. Allow a clock margin. */
export function hasPendingAuthorization(swap: SavedSwap, now = Date.now()): boolean {
  if (swap.result?.status === 'settled' || swap.result?.status === 'cancelled' || swap.refund?.status === 'refunded') return false;
  if (!(swap.intentInputs || swap.fundingStartedAt || swap.funding)) return false;
  if (swap.intentInputs && swap.response?.protocol === 'intent-v1') {
    const deadline = Number(swap.response.offer?.quote.deadline);
    if (Number.isFinite(deadline) && deadline > 0 && deadline * 1000 + 60000 <= now) return false;
  }
  return true;
}
export interface TakerOptions {
  chain: Chain;
  maintenanceStore?: import('@satora/striker-protocol/browser').MaintenanceStore;
  actor: {
    wallet: Pick<IWallet, "send"> & Partial<Pick<IWallet, 'getBalance' | 'settle' | 'getAddress' | 'getVtxos' | 'getContractManager'>>;
    publicKey: Uint8Array;
    payoutScript: Uint8Array;
    legacyPayoutScript?: Uint8Array;
    identity?: Pick<Identity, "sign">;
    signIntent?: (message: Uint8Array) => Promise<Uint8Array>;
  };
  strikerUrl: string;
  store: SwapStore;
}
export const swapId = (value: unknown) => {
  const id = string(value, "quoteId");
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Invalid quoteId");
  return id;
};
function serviceURL(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid Striker URL");
  return url.toString().replace(/\/$/, "");
}

/** Wallet signing stays with the supplied actor. Quotes and execution use Striker only. */
export class TakerClient {
  private active = new Set<string>();
  readonly strikerUrl: string;
  constructor(readonly options: TakerOptions) {
    this.strikerUrl = serviceURL(options.strikerUrl);
  }
  async maintainWallet(store: import('@satora/striker-protocol/browser').MaintenanceStore, options: { retryUnsettled?: boolean } = {}) {
    if (this.active.size) throw new Error('Wait for the current swap operation before renewing deposits');
    return this.exclusive('wallet-maintenance', async () => {
      if (!this.options.store.list) throw new Error('Wallet maintenance requires a swap store that lists pending authorizations');
      const swaps = await this.options.store.list();
      if (swaps.some(s => hasPendingAuthorization(s)))
        throw new Error('Resolve pending swaps or cancel their authorizations before renewing deposits');
      const { actor, chain } = this.options;
      if (!actor.identity) throw new Error('Wallet maintenance requires an owner signing identity');
      return new CovenantWallet(chain, actor.publicKey, actor.identity!, actor.wallet).maintain(store, options);
    });
  }

  verify(request: QuoteRequest, value: unknown, checkExpiry = true) {
    const response = object(value),
      offer = parseOffer(response.offer),
      actor = this.options.actor;
    validateOfferFor(offer, request, checkExpiry);
    if (
      request.takerPublicKey !== hex(actor.publicKey) ||
      request.takerPayoutScript !== hex(response.protocol === "intent-v1" ? actor.payoutScript : actor.legacyPayoutScript ?? actor.payoutScript)
    )
      throw new Error("Quote belongs to another wallet");
    if (response.protocol !== undefined && response.protocol !== "intent-v1") throw new Error("Unsupported swap protocol");
    const contract = response.protocol === "intent-v1" ? reusableTakerContract(this.options.chain, actor.publicKey) : takerContract(
      this.options.chain,
      actor.publicKey,
      actor.legacyPayoutScript ?? actor.payoutScript,
      offer.quote.x,
      offer.deposit.direction === 'btc-to-token' ? offer.deposit.wantAsset : undefined,
    );
    if (response.fundingAddress !== contract.address)
      throw new Error("Striker returned an incorrect funding address");
    swapId(response.quoteId);
    return { response: response as unknown as QuoteResponse, offer, contract };
  }
  async quote(assetId: string, amount: string, direction: Direction = 'token-to-btc'): Promise<SavedSwap> {
    if (this.options.actor.signIntent) await checkEmulator(this.options.chain);
    const request = parseQuoteRequest({
      assetId,
      giveAmount: amount,
      ...(direction === 'btc-to-token' ? { direction } : {}),
      takerPublicKey: hex(this.options.actor.publicKey),
      takerPayoutScript: hex(this.options.actor.payoutScript),
    });
    const { response } = this.verify(
      request,
      await requestJSON(`${this.strikerUrl}/${this.options.actor.signIntent ? "v2" : "v1"}/quotes`, request, 15_000),
    );
    if (this.options.actor.signIntent && response.protocol !== "intent-v1") throw new Error("Striker does not support reusable covenant swaps");
    const saved: SavedSwap = {
      version: 1,
      network: this.options.chain.settings.network,
      striker: this.strikerUrl,
      request,
      response,
      createdAt: Date.now(),
    };
    await this.options.store.put(saved);
    return saved;
  }
  async status(quoteId: string): Promise<SwapResult> {
    const result = object(
      await requestJSON(`${this.strikerUrl}/v1/swaps/${swapId(quoteId)}`),
    );
    if (result.quoteId !== quoteId)
      throw new Error("Status belongs to another swap");
    const status = string(result.status, "status");
    if (!["quoted", "executing", "settled", "failed"].includes(status))
      throw new Error("Unknown swap status");
    if (status === "settled") bytes(result.txid, 32, "txid");
    return result as unknown as SwapResult;
  }
  private async saved(quoteId: string) {
    const saved = await this.options.store.get(swapId(quoteId));
    if (!saved || saved.version !== 1 || saved.response.quoteId !== quoteId)
      throw new Error("Unknown saved swap");
    if ((saved.network ?? "regtest") !== this.options.chain.settings.network)
      throw new Error("Quote belongs to another network");
    if (serviceURL(saved.striker) !== this.strikerUrl)
      throw new Error("Quote belongs to another Striker service");
    saved.request = parseQuoteRequest(saved.request);
    return saved;
  }
  private async exclusive<T>(id: string, run: () => Promise<T>) {
    if (id !== 'wallet-maintenance' && this.active.has('wallet-maintenance')) throw new Error('Wallet recovery or renewal is in progress');
    if (this.active.has(id))
      throw new Error("This swap is already being processed");
    this.active.add(id);
    try {
      return await run();
    } finally {
      this.active.delete(id);
    }
  }
  async execute(quoteId: string): Promise<SwapResult> {
    return this.exclusive(quoteId, async () => {
      if (await this.options.maintenanceStore?.get()) throw new Error('Complete or inspect pending wallet maintenance before executing a swap');
      const saved = await this.saved(quoteId);
      if (saved.refund) throw new Error("Refund already requested");
      if (saved.result?.status === "cancelled") throw new Error("Authorization was cancelled; request a new quote");
      const { response, offer, contract } = this.verify(
        saved.request,
        saved.response,
        saved.funding === undefined && !saved.intentInputs && saved.result?.status !== "settled",
      );
      if (saved.result?.status === "settled") return saved.result;
      if (response.protocol === "intent-v1") return this.executeIntent(saved, offer);
      if (!saved.funding) {
        if (saved.fundingStartedAt)
          throw new Error(
            "Funding outcome is unknown. Check wallet activity before sending more funds.",
          );
        if (Number(offer.quote.deadline) * 1000 - Date.now() < MIN_QUOTE_FUNDING_SECONDS * 1000)
          throw new Error("Quote expires too soon to fund safely. Refresh the quote before swapping.");
        // Persist intent first: a reload or uncertain network failure must never fund twice.
        saved.fundingStartedAt = Date.now();
        const reverse = offer.deposit.direction === 'btc-to-token';
        const sats = reverse ? offer.quote.y + 330n : 330n;
        if (sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('BTC amount exceeds wallet precision');
        await this.options.store.put(saved);
        const txid = await this.options.actor.wallet.send({
          address: contract.address,
          amount: Number(sats),
          ...(reverse ? {} : { assets: [{ assetId: saved.request.assetId, amount: offer.quote.y }] }),
        });
        saved.funding = { fundingTxid: hex(bytes(txid, 32, "fundingTxid")) };
        await this.options.store.put(saved);
      }
      const funding = saved.funding;
      bytes(funding.fundingTxid, 32, "fundingTxid");
      if (funding.fundingVout === undefined) {
        const coin = await fundedCoin(
          this.options.chain,
          contract.tree,
          funding.fundingTxid,
        );
        funding.fundingVout = coin.vout.toString();
        await this.options.store.put(saved);
      }
      decimal(funding.fundingVout, "fundingVout");
      if (Number(offer.quote.deadline) * 1000 - Date.now() < MIN_QUOTE_SETTLEMENT_SECONDS * 1000)
        throw new Error("Quote expired or is too close to expiry to settle safely. Return unspent funds to your wallet, then request a new quote.");
      const result = object(
        await requestJSON(
          `${this.strikerUrl}/v1/swaps`,
          { quoteId: response.quoteId, ...funding },
          60_000,
        ),
      );
      if (result.quoteId !== quoteId || result.status !== "settled")
        throw new Error("Unexpected execution result; check swap status");
      bytes(result.txid, 32, "txid");
      saved.result = result as unknown as SwapResult;
      await this.options.store.put(saved);
      return saved.result;
    });
  }
  private async executeIntent(saved: SavedSwap, offer: ReturnType<typeof parseOffer>): Promise<SwapResult> {
    const { actor, chain, store } = this.options;
    if (!actor.signIntent) throw new Error("This wallet cannot authorize reusable covenant swaps");
    if (Number(offer.quote.deadline) * 1000 - Date.now() < MIN_QUOTE_SETTLEMENT_SECONDS * 1000)
      throw new Error("Quote expired or expires too soon. Request a new quote; your deposits remain in your wallet.");
    const contract = reusableTakerContract(chain, actor.publicKey);
    if (saved.request.takerPayoutScript !== hex(contract.tree.pkScript)) throw new Error("Intent receipt must return to your covenant");
    if (!saved.intentInputs) {
      const coins = [...await coinsAt(chain, contract.tree)].sort((a, b) => b.value - a.value);
      const btcToToken = offer.deposit.direction === 'btc-to-token';
      let sats = btcToToken ? offer.quote.y + 330n : 330n, tokens = btcToToken ? 0n : offer.quote.y;
      const selected: { coin: typeof coins[number]; sats: bigint; tokens: bigint }[] = [];
      // Token-bearing deposits first; then add BTC carriers as needed.
      if (!btcToToken) coins.sort((a, b) => {
        const held = (c: typeof a) => BigInt(c.assets?.find(v => v.assetId === saved.request.assetId)?.amount ?? 0);
        return held(a) === held(b) ? 0 : held(a) > held(b) ? -1 : 1;
      });
      for (const coin of coins) {
        if (sats === 0n && tokens === 0n) break;
        const spare = BigInt(coin.value) - 330n;
        if (spare < 0n) continue;
        const held = BigInt(coin.assets?.find(a => a.assetId === saved.request.assetId)?.amount ?? 0);
        const payTokens = held < tokens ? held : tokens, paySats = spare < sats ? spare : sats;
        if (payTokens === 0n && paySats === 0n) continue;
        selected.push({ coin, sats: paySats, tokens: payTokens }); sats -= paySats; tokens -= payTokens;
      }
      if (sats || tokens || selected.length > MAX_INTENT_INPUTS)
        throw new Error("Insufficient covenant balance, or more than four deposits are needed. Each change output needs a 330-sat carrier. Move previous-wallet funds, consolidate deposits, or deposit more BTC.");
      const batch = selected.map(item => ({ coin: item.coin, paySats: item.sats, payTokens: item.tokens }));
      const terms = selected.map(({ coin, sats, tokens }) => termsForInput(chain.checkpoint, contract.tree, offer, coin, sats, tokens, batch));
      const signature = hex(await actor.signIntent(encodeIntent(contract.domain, terms[0]!)));
      saved.intentInputs = selected.map(({ coin }, i) => ({ coin: { txid: coin.txid, vout: coin.vout }, terms: terms[i]!, signature }));
      // Persist the exact authorization before the request. Recovery reuses it.
      await store.put(saved);
    }
    saved.intentSubmittedAt ??= Date.now(); await store.put(saved);
    const result = object(await requestJSON(`${this.strikerUrl}/v2/swaps`, {
      quoteId: saved.response.quoteId, inputs: saved.intentInputs,
    }, 60_000));
    if (result.quoteId !== saved.response.quoteId || result.status !== "settled") throw new Error("Unexpected execution result; check swap status");
    bytes(result.txid, 32, "txid"); saved.result = result as unknown as SwapResult; await store.put(saved);
    return saved.result;
  }
  async cancelIntent(quoteId: string): Promise<string> {
    return this.exclusive(quoteId, async () => {
      const saved = await this.saved(quoteId), { actor, chain } = this.options;
      this.verify(saved.request, saved.response, false);
      if (saved.result?.status === "cancelled") return saved.cancellation!.txid;
      if (saved.response.protocol !== "intent-v1" || !saved.intentInputs || saved.result?.status === "settled" || !actor.identity)
        throw new Error("No pending authorization to cancel");
      const wallet = new CovenantWallet(chain, actor.publicKey, actor.identity, actor.wallet);
      if (!saved.cancellation) {
        const coins = await wallet.coins();
        if (!saved.intentInputs.every(input => coins.some(c => c.txid === input.coin.txid && c.vout === input.coin.vout)))
          throw new Error("An authorized input was spent. Check swap status before cancelling.");
        // Expiry alone cannot revoke a transaction the Emulator already co-signed.
        // An owner self-spend makes all previous input authorizations unusable.
        saved.cancellation = await wallet.prepareWithdrawal(wallet.contract.address);
        await this.options.store.put(saved);
      }
      const txid = await wallet.submitWithdrawal(saved.cancellation);
      saved.result = { quoteId, status: "cancelled" }; await this.options.store.put(saved);
      return txid;
    });
  }
  /** Return an unspent funded offer through its owner leaf, including after quote expiry. */
  async refund(quoteId: string): Promise<string> {
    return this.exclusive(quoteId, async () => {
      const saved = await this.saved(quoteId),
        { actor, chain } = this.options;
      const { offer, contract } = this.verify(
        saved.request,
        saved.response,
        false,
      );
      if (saved.result?.status === "settled")
        throw new Error("Swap already settled");
      if (saved.refund?.status === "refunded") return saved.refund.txid;
      if (!actor.identity || !saved.funding)
        throw new Error("No known funding to refund");
      if (!saved.refund) {
        const coin = await fundedCoin(
          chain,
          contract.tree,
          saved.funding.fundingTxid,
          saved.funding.fundingVout === undefined
            ? undefined
            : Number(saved.funding.fundingVout),
        );
        const reverse = offer.deposit.direction === 'btc-to-token';
        if (reverse ? (coin.assets?.length || BigInt(coin.value) !== offer.quote.y + 330n) : (
          coin.assets?.length !== 1 ||
          coin.assets[0]?.assetId !== saved.request.assetId ||
          BigInt(coin.assets[0].amount) !== offer.quote.y
        ))
          throw new Error("Funding does not match the saved swap");
        const packet = asset.Packet.create([
          asset.AssetGroup.create(
            asset.AssetId.fromString(saved.request.assetId),
            null,
            [asset.AssetInput.create(0, offer.quote.y)],
            [asset.AssetOutput.create(0, offer.quote.y)],
            [],
          ),
        ]);
        const leaf = contract.tree.leaves[1]!;
        const { arkTx, checkpoints } = buildOffchainTx(
          [{ ...coin, tapTree: contract.tree.encode(), tapLeafScript: leaf }],
          [
            { script: actor.payoutScript, amount: BigInt(coin.value) },
            ...(reverse ? [] : [Extension.create([packet]).txOut()]),
          ],
          chain.checkpoint,
        );
        const signed = await actor.identity.sign(arkTx);
        const accepted = await chain.ark.submitTx(
          encodeBase64(signed.toPSBT()),
          checkpoints.map((cp) => encodeBase64(cp.toPSBT())),
        );
        saved.refund = {
          txid: accepted.arkTxid,
          status: "submitted",
          checkpoints: accepted.signedCheckpointTxs,
        };
        await this.options.store.put(saved);
      }
      const checkpoints = await Promise.all(
        saved.refund.checkpoints!.map(async (cp) =>
          encodeBase64(
            (
              await actor.identity!.sign(Transaction.fromPSBT(decodeBase64(cp)))
            ).toPSBT(),
          ),
        ),
      );
      await chain.ark.finalizeTx(saved.refund.txid, checkpoints);
      saved.refund = { txid: saved.refund.txid, status: "refunded" };
      await this.options.store.put(saved);
      return saved.refund.txid;
    });
  }
}

export function parseAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error("Invalid asset decimals");
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))
    throw new Error("Enter a valid amount");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new Error(`Use at most ${decimals} decimal places`);
  const units =
    BigInt(whole!) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  return decimal(units.toString(), "amount", true);
}
export function formatAmount(
  units: bigint,
  decimals: number,
  trim = true,
): string {
  const base = 10n ** BigInt(decimals),
    fraction = (units % base).toString().padStart(decimals, "0");
  const text = decimals ? `${units / base}.${fraction}` : units.toString();
  return trim && decimals ? text.replace(/\.?0+$/, "") : text;
}
