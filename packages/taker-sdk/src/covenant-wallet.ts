import { ArkAddress, asset, buildOffchainTx, Extension, Transaction, type Identity, type IWallet, type WalletBalance } from '@arkade-os/sdk';
import { asInput, coinsAt, decodeBase64, encodeBase64, hex, reusableTakerContract, equalBytes, type Chain } from '@satora/striker-protocol/browser';

/** Indexer-backed reusable wallet. The SDK wallet remains available for legacy funds. */
export class CovenantWallet {
  readonly contract;
  constructor(readonly chain: Chain, readonly publicKey: Uint8Array, readonly identity: Pick<Identity, 'sign'>,
    readonly legacy: Pick<IWallet, 'send'> & Partial<Pick<IWallet, 'getBalance'>>) {
    this.contract = reusableTakerContract(chain, publicKey);
  }
  async coins() { return coinsAt(this.chain, this.contract.tree); }
  async getBalance(): Promise<WalletBalance> {
    const coins = await this.coins(), assets = new Map<string, bigint>();
    let total = 0;
    for (const coin of coins) {
      total += coin.value;
      for (const a of coin.assets ?? []) assets.set(a.assetId, (assets.get(a.assetId) ?? 0n) + BigInt(a.amount));
    }
    const balances = [...assets].sort(([a], [b]) => a.localeCompare(b)).map(([assetId, amount]) => ({ assetId, amount }));
    return { total, available: coins.reduce((sum, c) => sum + Math.max(0, c.value - 330), 0), settled: total, preconfirmed: 0, recoverable: 0, gated: 0, intentLocked: 0, pendingRecovery: 0, unrolled: 0, boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
      assets: balances, availableAssets: balances };
  }
  async moveLegacy(): Promise<string> {
    if (!this.legacy.getBalance) throw new Error("Previous wallet balance is unavailable");
    const balance = await this.legacy.getBalance();
    if (balance.available < 330) throw new Error('No spendable funds at the previous wallet address');
    return this.legacy.send({ address: this.contract.address, amount: balance.available,
      assets: balance.availableAssets.map(a => ({ assetId: a.assetId, amount: BigInt(a.amount) })) });
  }
  /** Owner withdrawal needs only arkd, never the Emulator or Striker. */
  async prepareWithdrawal(address: string) {
    const decoded = ArkAddress.decode(address);
    if (decoded.hrp !== 'tark' || !equalBytes(decoded.serverPubKey, this.chain.server)) throw new Error('Withdrawal must use a test-network Arkade address');
    const coins = await this.coins();
    if (!coins.length || coins.length > 16) throw new Error('Withdrawal requires between 1 and 16 deposits');
    const groups = new Map<string, { ins: ReturnType<typeof asset.AssetInput.create>[]; total: bigint }>();
    let total = 0n;
    coins.forEach((coin, i) => {
      total += BigInt(coin.value);
      for (const a of coin.assets ?? []) {
        const g = groups.get(a.assetId) ?? { ins: [], total: 0n };
        g.ins.push(asset.AssetInput.create(i, BigInt(a.amount))); g.total += BigInt(a.amount); groups.set(a.assetId, g);
      }
    });
    const packet = asset.Packet.create([...groups].map(([id, g]) => asset.AssetGroup.create(asset.AssetId.fromString(id), null,
      g.ins, [asset.AssetOutput.create(0, g.total)], [])));
    const built = buildOffchainTx(coins.map(c => asInput(c, this.contract.tree, 1)), [
      { script: decoded.pkScript, amount: total }, ...(groups.size ? [Extension.create([packet]).txOut()] : []),
    ], this.chain.checkpoint);
    const signed = await this.identity.sign(built.arkTx);
    const checkpoints = await Promise.all(built.checkpoints.map(async cp => encodeBase64((await this.identity.sign(cp)).toPSBT())));
    return { txid: signed.id, arkTx: encodeBase64(signed.toPSBT()), checkpoints };
  }
  async submitWithdrawal(prepared: { txid: string; arkTx: string; checkpoints: string[] }) {
    const tx = Transaction.fromPSBT(decodeBase64(prepared.arkTx));
    const script = tx.getOutput(0).script!;
    const received = await this.chain.indexer.getVtxos({ scripts: [hex(script)], spendableOnly: true });
    if (received.vtxos.some(c => c.txid === prepared.txid)) return prepared.txid;
    // Re-submitting the exact package cannot spend a second set of deposits.
    const accepted = await this.chain.ark.submitTx(prepared.arkTx, prepared.checkpoints);
    if (accepted.arkTxid !== prepared.txid) throw new Error('Unexpected withdrawal transaction');
    const checkpoints = await Promise.all(accepted.signedCheckpointTxs.map(async cp =>
      encodeBase64((await this.identity.sign(Transaction.fromPSBT(decodeBase64(cp)))).toPSBT())));
    await this.chain.ark.finalizeTx(prepared.txid, checkpoints);
    return prepared.txid;
  }
}
