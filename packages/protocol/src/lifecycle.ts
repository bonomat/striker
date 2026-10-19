import { ArkAddress, Extension, Transaction, VtxoScript, asset, buildOffchainTx, canSpendOffchain, contractHandlers,
  isPastExpiry, type ContractHandler, type IWallet, type Identity, type TapLeafScript, type VirtualCoin } from '@arkade-os/sdk';
import { bytes, hex } from './wire.js';
import { decodeBase64, encodeBase64 } from './encoding.js';
import { type Chain, expiryContext, waitFor } from './chain-client.js';

export const RENEWAL_WINDOW_MS = 6 * 60 * 60 * 1000;
export type DepositState = 'available' | 'expiring' | 'awaiting-sweep' | 'recoverable' | 'spent';
export function depositState(coin: VirtualCoin, now = Date.now(), thresholdMs = RENEWAL_WINDOW_MS, height?: number): DepositState {
  if (coin.isSpent || coin.spentBy || coin.settledBy) return 'spent';
  if (coin.isSwept) return 'recoverable';
  if (isPastExpiry(coin, { timestamp: new Date(now), height })) return 'awaiting-sweep';
  if ((coin.expiresAt && new Date(coin.expiresAt).getTime() <= now + thresholdMs) ||
    (height !== undefined && coin.expiresAtHeight !== undefined && coin.expiresAtHeight <= height + Math.ceil(thresholdMs / 600_000))) return 'expiring';
  return 'available';
}
export async function covenantCoins(chain: Chain, tree: Pick<VtxoScript, 'pkScript'>) {
  const { vtxos } = await chain.indexer.getVtxos({ scripts: [hex(tree.pkScript)] });
  return vtxos.filter(c => depositState(c) !== 'spent' && !c.isUnrolled);
}
export async function covenantInventory(chain: Chain, tree: Pick<VtxoScript, 'pkScript'>, thresholdMs = RENEWAL_WINDOW_MS) {
  const coins = await covenantCoins(chain, tree), now = await expiryContext(chain, coins);
  return coins.map(coin => ({ coin, state: depositState(coin, now.timestamp.getTime(), thresholdMs, now.height) }));
}

const OWNER_CONTRACT = 'striker-owner-v1';
const ownerHandler: ContractHandler<Record<string, string>> & { deriveTapscripts(script: VtxoScript): { forfeitTapLeafScript: TapLeafScript; intentTapLeafScript: TapLeafScript; tapTree: Uint8Array } } = {
  type: OWNER_CONTRACT,
  createScript: params => VtxoScript.decode(bytes(params.tree, (params.tree?.length ?? 0) / 2, 'tree')),
  serializeParams: params => params,
  deserializeParams: params => params,
  selectPath: script => ({ leaf: script.leaves[1]! }),
  getAllSpendingPaths: script => [{ leaf: script.leaves[1]! }],
  getSpendablePaths: script => [{ leaf: script.leaves[1]! }],
  // Escrow inputs must only be selected explicitly for maintenance.
  isGenericallySpendable: () => false,
  deriveTapscripts: script => ({ forfeitTapLeafScript: script.leaves[1]!, intentTapLeafScript: script.leaves[1]!, tapTree: script.encode() }),
};
// Persisted contracts must remain annotatable after reconnect/reload, too.
if (!contractHandlers.has(OWNER_CONTRACT)) contractHandlers.register(ownerHandler);

export interface PreparedOwnerTransfer { txid: string; arkTx: string; checkpoints: string[] }
export interface MaintenanceOperation {
  version: 1;
  network: string;
  source: string;
  destination: string;
  ownerAddress: string;
  inputs: { txid: string; vout: number }[];
  amount: number;
  assets?: { assetId: string; amount: string }[];
  startedAt?: number;
  settlementTxid?: string;
  transfer?: PreparedOwnerTransfer;
  completed?: boolean;
}
export interface MaintenanceStore {
  /** Return only the pending operation; archive completed receipts separately. */
  get(): Promise<MaintenanceOperation | undefined>;
  put(operation: MaintenanceOperation): Promise<void>;
}
function assetTotals(coins: VirtualCoin[]) {
  const totals = new Map<string, bigint>();
  for (const coin of coins) for (const a of coin.assets ?? []) totals.set(a.assetId, (totals.get(a.assetId) ?? 0n) + BigInt(a.amount));
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([assetId, amount]) => ({ assetId, amount: amount.toString() }));
}

/** Idempotently submit an exact owner-signed package; never select replacement inputs. */
export async function submitOwnerTransfer(chain: Chain, identity: Pick<Identity, 'sign'>, prepared: PreparedOwnerTransfer) {
  const tx = Transaction.fromPSBT(decodeBase64(prepared.arkTx));
  if (tx.id !== prepared.txid) throw new Error('Maintenance transaction ID mismatch');
  const output = tx.getOutput(0).script!;
  const published = async () => (await chain.indexer.getVtxos({ scripts: [hex(output)] })).vtxos.some(c => c.txid === prepared.txid);
  if (await published()) return prepared.txid;
  try {
    const accepted = await chain.ark.submitTx(prepared.arkTx, prepared.checkpoints);
    if (accepted.arkTxid !== prepared.txid) throw new Error('Unexpected maintenance transaction');
    const checkpoints = await Promise.all(accepted.signedCheckpointTxs.map(async cp =>
      encodeBase64((await identity.sign(Transaction.fromPSBT(decodeBase64(cp)))).toPSBT())));
    await chain.ark.finalizeTx(prepared.txid, checkpoints);
  } catch (error) {
    // The SDK watcher can finalize concurrently; a lost response is also ambiguous.
    // Only authoritative publication of this exact transaction counts as success.
    if (!await published()) throw error;
  }
  return prepared.txid;
}

/** Recover/renew explicit covenant inputs via the owner path, then re-lock them.
 * The SDK assigns recovered tokens to its standard wallet address, so this is
 * deliberately two phases. Save the journal before each network mutation.
 */
export async function maintainCovenant(options: {
  chain: Chain; wallet: IWallet; identity: Pick<Identity, 'sign'>;
  sourceTree: VtxoScript; destination: string; store: MaintenanceStore;
  packets?: Parameters<typeof Extension.create>[0];
}) {
  const { chain, wallet, identity, sourceTree, destination, store } = options;
  const source = hex(sourceTree.pkScript), decoded = ArkAddress.decode(destination);
  if (!decoded.serverPubKey.every((b, i) => b === chain.server[i]) || decoded.hrp !== 'tark') throw new Error('Maintenance destination belongs to another server or network');
  const ownerAddress = await wallet.getAddress();
  let operation = await store.get();
  if (operation && (operation.network !== chain.settings.network || operation.source !== source || operation.destination !== destination || operation.ownerAddress !== ownerAddress))
    throw new Error('Maintenance journal belongs to another wallet or covenant');
  if (operation?.completed) return operation;
  if (!operation) {
    const inventory = await covenantInventory(chain, sourceTree), coins = inventory.map(c => c.coin);
    if (!coins.length || coins.length > 16) throw new Error('Maintenance requires between 1 and 16 deposits');
    if (inventory.some(c => c.state === 'awaiting-sweep')) throw new Error('Expired deposits are waiting for the Arkade sweep; recovery is not available yet');
    operation = { version: 1, network: chain.settings.network, source, destination, ownerAddress,
      inputs: coins.map(({ txid, vout }) => ({ txid, vout })), amount: coins.reduce((sum, c) => sum + c.value, 0), assets: assetTotals(coins) };
    if (!Number.isSafeInteger(operation.amount) || operation.amount <= 0) throw new Error('Invalid maintenance value');
    await store.put(operation);
  }
  if (operation.startedAt && !operation.settlementTxid) {
    // Recover a lost batch response using ONLY the recorded inputs and their
    // authoritative settlement ID. Never infer success from a wallet balance.
    const raw = await chain.indexer.getVtxos({ scripts: [source] });
    const inputs = operation.inputs.map(input => raw.vtxos.find(c => c.txid === input.txid && c.vout === input.vout));
    const commitment = inputs[0]?.settledBy;
    if (commitment && inputs.every(c => c?.settledBy === commitment)) {
      operation.assets ??= assetTotals(inputs.map(c => c!));
      operation.settlementTxid = commitment; await store.put(operation);
    } else throw new Error('A maintenance settlement has an uncertain outcome. Inspect its recorded inputs before retrying; funds may already be in the previous wallet');
  }
  if (!operation.settlementTxid) {
    const all = await covenantCoins(chain, sourceTree);
    const coins = operation.inputs.map(input => all.find(c => c.txid === input.txid && c.vout === input.vout));
    if (coins.some(c => !c)) throw new Error('A maintenance input was spent; inspect wallet activity before continuing');
    // Settlement conserves every satoshi and asset. Refuse unsupported fee policies.
    const info = await chain.ark.getInfo();
    if (Number(info.fees.txFeeRate) !== 0 || Object.values(info.fees.intentFee ?? {}).some(value => value !== '' && !/^0(?:\.0+)?$/.test(value)))
      throw new Error('Covenant maintenance currently requires zero settlement fees');
    if (!contractHandlers.has(OWNER_CONTRACT)) contractHandlers.register(ownerHandler);
    const manager = await wallet.getContractManager();
    await manager.createContract({ type: OWNER_CONTRACT, params: { tree: hex(sourceTree.encode()) },
      script: source, address: sourceTree.address('tark', chain.server).encode() });
    const inputs = await manager.annotateVtxos(coins.map(c => c!));
    operation.startedAt = Date.now(); await store.put(operation);
    operation.settlementTxid = await wallet.settle({ inputs, outputs: [{ address: ownerAddress, amount: BigInt(operation.amount) }] });
    await store.put(operation);
  }
  if (!operation.transfer) {
    const commitment = operation.settlementTxid;
    const coins = await waitFor(async () => {
      const vtxos = await wallet.getVtxos();
      const matching = vtxos.filter(c => c.commitmentTxIds?.includes(commitment) && canSpendOffchain(c, { timestamp: new Date() }));
      return matching.length === 1 && matching[0]!.value === operation!.amount ? matching : undefined;
    }, 'recovered owner output');
    const coin = coins[0]!;
    if (operation.assets && JSON.stringify(assetTotals([coin])) !== JSON.stringify(operation.assets))
      throw new Error('Recovered assets do not match the recorded maintenance inputs');
    const packet = coin.assets?.length ? asset.Packet.create(coin.assets.map(a => asset.AssetGroup.create(asset.AssetId.fromString(a.assetId), null,
      [asset.AssetInput.create(0, BigInt(a.amount))], [asset.AssetOutput.create(0, BigInt(a.amount))], []))) : undefined;
    const packets = [...(options.packets ?? []), ...(packet ? [packet] : [])];
    const built = buildOffchainTx([{ ...coin, tapLeafScript: coin.forfeitTapLeafScript }], [
      { script: decoded.pkScript, amount: BigInt(coin.value) }, ...(packets.length ? [Extension.create(packets).txOut()] : []),
    ], chain.checkpoint);
    const signed = await identity.sign(built.arkTx);
    operation.transfer = { txid: signed.id, arkTx: encodeBase64(signed.toPSBT()),
      checkpoints: await Promise.all(built.checkpoints.map(async cp => encodeBase64((await identity.sign(cp)).toPSBT()))) };
    await store.put(operation);
  }
  await submitOwnerTransfer(chain, identity, operation.transfer);
  operation.completed = true; await store.put(operation);
  return operation;
}
