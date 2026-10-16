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
}
export interface TakerOptions {
  chain: Chain;
  actor: {
    wallet: Pick<IWallet, "send">;
    publicKey: Uint8Array;
    payoutScript: Uint8Array;
    identity?: Pick<Identity, "sign">;
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

  verify(request: QuoteRequest, value: unknown, checkExpiry = true) {
    const response = object(value),
      offer = parseOffer(response.offer),
      actor = this.options.actor;
    validateOfferFor(offer, request, checkExpiry);
    if (
      request.takerPublicKey !== hex(actor.publicKey) ||
      request.takerPayoutScript !== hex(actor.payoutScript)
    )
      throw new Error("Quote belongs to another wallet");
    const contract = takerContract(
      this.options.chain,
      actor.publicKey,
      actor.payoutScript,
      offer.quote.x,
      offer.deposit.direction === 'btc-to-token' ? offer.deposit.wantAsset : undefined,
    );
    if (response.fundingAddress !== contract.address)
      throw new Error("Striker returned an incorrect funding address");
    swapId(response.quoteId);
    return { response: response as unknown as QuoteResponse, offer, contract };
  }
  async quote(assetId: string, amount: string, direction: Direction = 'token-to-btc'): Promise<SavedSwap> {
    const request = parseQuoteRequest({
      assetId,
      giveAmount: amount,
      ...(direction === 'btc-to-token' ? { direction } : {}),
      takerPublicKey: hex(this.options.actor.publicKey),
      takerPayoutScript: hex(this.options.actor.payoutScript),
    });
    const { response } = this.verify(
      request,
      await requestJSON(`${this.strikerUrl}/v1/quotes`, request, 15_000),
    );
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
      const saved = await this.saved(quoteId);
      if (saved.refund) throw new Error("Refund already requested");
      const { response, offer, contract } = this.verify(
        saved.request,
        saved.response,
        saved.funding === undefined,
      );
      if (saved.result?.status === "settled") return saved.result;
      if (!saved.funding) {
        if (saved.fundingStartedAt)
          throw new Error(
            "Funding outcome is unknown. Check wallet activity before sending more funds.",
          );
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
