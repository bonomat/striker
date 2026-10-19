import { ArkAddress, asset, buildOffchainTx, Extension, type Identity, type IWallet, type WalletBalance } from '@arkade-os/sdk';
import { asInput, coinsAt, covenantInventory, maintainCovenant, submitOwnerTransfer, encodeBase64, reusableTakerContract, equalBytes, type Chain, type MaintenanceStore } from '@satora/striker-protocol/browser';

/** Indexer-backed reusable wallet. The SDK wallet remains available for legacy funds. */
export class CovenantWallet {
  readonly contract;
  constructor(readonly chain: Chain, readonly publicKey: Uint8Array, readonly identity: Pick<Identity, 'sign'>,
    readonly legacy: Pick<IWallet, 'send'> & Partial<Pick<IWallet, 'getBalance' | 'settle' | 'getAddress' | 'getVtxos' | 'getContractManager'>>) {
    this.contract = reusableTakerContract(chain, publicKey);
  }
  async coins() { return coinsAt(this.chain, this.contract.tree); }
  async getLifecycle() {
    const states = await covenantInventory(this.chain, this.contract.tree);
    return { deposits: states.map(({ coin, state }) => ({ txid: coin.txid, vout: coin.vout, sats: coin.value,
      expiresAt: coin.expiresAt?.toISOString() ?? null, state })),
      recoverable: states.filter(c => c.state === 'recoverable').length,
      expiring: states.filter(c => c.state === 'expiring').length,
      awaitingSweep: states.filter(c => c.state === 'awaiting-sweep').length };
  }
  /** Call under the same wallet lock as swaps, with no pending authorizations. */
  async maintain(store: MaintenanceStore) {
    if (!this.legacy.settle || !this.legacy.getAddress || !this.legacy.getVtxos || !this.legacy.getContractManager)
      throw new Error('This wallet does not support batch recovery and renewal');
    return maintainCovenant({ chain: this.chain, wallet: this.legacy as IWallet, identity: this.identity,
      sourceTree: this.contract.tree, destination: this.contract.address, store });
  }
  async getBalance(): Promise<WalletBalance> {
    return this.balanceFor(await covenantInventory(this.chain, this.contract.tree), 330);
  }
  /** Excludes covenants registered temporarily for batch settlement. */
  async getLegacyBalance(): Promise<WalletBalance> {
    if (!this.legacy.getBalance) throw new Error('Previous wallet balance is unavailable');
    const balance = await this.legacy.getBalance();
    if (!this.legacy.getAddress) return balance;
    const address = ArkAddress.decode(await this.legacy.getAddress());
    const result = this.balanceFor(await covenantInventory(this.chain, { pkScript: address.pkScript }), 0);
    return { ...result, boarding: balance.boarding, total: result.total + balance.boarding.total };
  }
  private balanceFor(inventory: Awaited<ReturnType<typeof covenantInventory>>, reserve: number): WalletBalance {
    const assets = new Map<string, bigint>(), availableAssets = new Map<string, bigint>();
    let total = 0, available = 0, recoverable = 0, settled = 0, preconfirmed = 0;
    for (const { coin, state } of inventory) {
      total += coin.value;
      const spendable = state === 'available' || state === 'expiring';
      if (spendable) {
        available += Math.max(0, coin.value - reserve);
        if (coin.isPreconfirmed) preconfirmed += coin.value; else settled += coin.value;
      }
      if (state === 'recoverable') recoverable += coin.value;
      for (const a of coin.assets ?? []) assets.set(a.assetId, (assets.get(a.assetId) ?? 0n) + BigInt(a.amount));
      if (spendable) for (const a of coin.assets ?? []) availableAssets.set(a.assetId, (availableAssets.get(a.assetId) ?? 0n) + BigInt(a.amount));
    }
    const balances = (map: Map<string, bigint>) => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([assetId, amount]) => ({ assetId, amount }));
    return { total, available, settled, preconfirmed, recoverable, gated: 0, intentLocked: 0, pendingRecovery: 0, unrolled: 0, boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
      assets: balances(assets), availableAssets: balances(availableAssets) };
  }
  async moveLegacy(): Promise<string> {
    if (!this.legacy.getBalance) throw new Error("Previous wallet balance is unavailable");
    const balance = await this.getLegacyBalance();
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
    const packet = groups.size ? asset.Packet.create([...groups].map(([id, g]) => asset.AssetGroup.create(asset.AssetId.fromString(id), null,
      g.ins, [asset.AssetOutput.create(0, g.total)], []))) : undefined;
    const built = buildOffchainTx(coins.map(c => asInput(c, this.contract.tree, 1)), [
      { script: decoded.pkScript, amount: total }, ...(packet ? [Extension.create([packet]).txOut()] : []),
    ], this.chain.checkpoint);
    const signed = await this.identity.sign(built.arkTx);
    const checkpoints = await Promise.all(built.checkpoints.map(async cp => encodeBase64((await this.identity.sign(cp)).toPSBT())));
    return { txid: signed.id, arkTx: encodeBase64(signed.toPSBT()), checkpoints };
  }
  async submitWithdrawal(prepared: { txid: string; arkTx: string; checkpoints: string[] }) {
    return submitOwnerTransfer(this.chain, this.identity, prepared);
  }
}
