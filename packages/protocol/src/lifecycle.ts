import { ArkAddress, ArkError, EsploraProvider, Extension, Intent, Transaction, VtxoScript, asset, buildOffchainTx, canSpendOffchain, contractHandlers, withPrevTxs,
  isPastExpiry, type ContractHandler, type ExtendedVirtualCoin, type IWallet, type Identity, type TapLeafScript, type VirtualCoin } from '@arkade-os/sdk';
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
  lastError?: string;
  cancellationProof?: string;
  cancelledAt?: number;
  cancellationInputs?: { txid: string; vout: number }[];
  supersededInputs?: { txid: string; vout: number }[];
  bridge?: PreparedOwnerTransfer;
  settlementInputs?: { txid: string; vout: number }[];
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

async function annotateOwnerInputs(chain: Chain, wallet: IWallet, tree: VtxoScript, coins: VirtualCoin[]) {
  const manager = await wallet.getContractManager();
  await manager.createContract({ type: OWNER_CONTRACT, params: { tree: hex(tree.encode()) },
    script: hex(tree.pkScript), address: tree.address('tark', chain.server).encode() });
  return manager.annotateVtxos(coins);
}

async function prepareOwnerTransfer(chain: Chain, identity: Pick<Identity, 'sign'>, coins: ExtendedVirtualCoin[],
  destination: Uint8Array, extraPackets: Parameters<typeof Extension.create>[0] = []): Promise<PreparedOwnerTransfer> {
  const groups = new Map<string, { ins: ReturnType<typeof asset.AssetInput.create>[]; total: bigint }>();
  let total = 0n;
  coins.forEach((coin, i) => {
    total += BigInt(coin.value);
    for (const a of coin.assets ?? []) {
      const group = groups.get(a.assetId) ?? { ins: [], total: 0n };
      group.ins.push(asset.AssetInput.create(i, BigInt(a.amount))); group.total += BigInt(a.amount); groups.set(a.assetId, group);
    }
  });
  const packet = groups.size ? asset.Packet.create([...groups].map(([id, group]) => asset.AssetGroup.create(asset.AssetId.fromString(id), null,
    group.ins, [asset.AssetOutput.create(0, group.total)], []))) : undefined;
  const packets = [...extraPackets, ...(packet ? [packet] : [])];
  const built = buildOffchainTx(coins.map(coin => ({ ...coin, tapLeafScript: coin.forfeitTapLeafScript })), [
    { script: destination, amount: total }, ...(packets.length ? [Extension.create(packets).txOut()] : []),
  ], chain.checkpoint);
  const signed = await identity.sign(built.arkTx);
  return { txid: signed.id, arkTx: encodeBase64(signed.toPSBT()),
    checkpoints: await Promise.all(built.checkpoints.map(async cp => encodeBase64((await identity.sign(cp)).toPSBT()))) };
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

/** Recover swept inputs directly, or bridge live inputs to a standard exit script
 * before renewal. Return all assets to the covenant after the batch. Persist
 * each exact signed transfer before submission so every phase can be resumed.
 */
export async function maintainCovenant(options: {
  chain: Chain; wallet: IWallet; identity: Pick<Identity, 'sign'>;
  sourceTree: VtxoScript; destination: string; store: MaintenanceStore;
  packets?: Parameters<typeof Extension.create>[0];
  /** Explicit resume only: cancel an old queued intent before retrying its exact inputs. */
  retryUnsettled?: boolean;
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
    const inventory = await covenantInventory(chain, sourceTree);
    // Recover swept deposits separately; don't lock healthy funds in the batch.
    const due = inventory.filter(c => c.state === 'recoverable');
    const selected = due.length ? due : inventory.filter(c => c.state === 'expiring');
    const coins = selected.slice(0, 16).map(c => c.coin);
    if (!coins.length && inventory.some(c => c.state === 'awaiting-sweep')) throw new Error('Expired deposits are waiting for the Arkade sweep; recovery is not available yet');
    if (!coins.length) throw new Error('No deposits need recovery or renewal');
    if (!coins.length || coins.length > 16) throw new Error('Maintenance requires between 1 and 16 deposits');
    operation = { version: 1, network: chain.settings.network, source, destination, ownerAddress,
      inputs: coins.map(({ txid, vout }) => ({ txid, vout })), amount: coins.reduce((sum, c) => sum + c.value, 0), assets: assetTotals(coins) };
    if (!Number.isSafeInteger(operation.amount) || operation.amount <= 0) throw new Error('Invalid maintenance value');
    await store.put(operation);
  }
  if ((operation.startedAt || operation.cancelledAt) && !operation.settlementTxid) {
    // Recover a lost batch response using ONLY the recorded inputs and their
    // authoritative settlement ID. Never infer success from a wallet balance.
    const raw = await chain.indexer.getVtxos({ scripts: [operation.bridge ? hex(ArkAddress.decode(ownerAddress).pkScript) : source] });
    const inputs = (operation.settlementInputs ?? operation.inputs).map(input => raw.vtxos.find(c => c.txid === input.txid && c.vout === input.vout));
    const commitment = inputs[0]?.settledBy;
    if (commitment && inputs.every(c => c?.settledBy === commitment)) {
      operation.assets ??= assetTotals(inputs.map(c => c!));
      operation.settlementTxid = commitment; await store.put(operation);
    } else if (options.retryUnsettled && inputs.every(c => c && depositState(c) !== 'spent' && !c.isUnrolled)) {
      const original = inputs.map(c => c!);
      // A proof containing a live no-exit-leaf input is invalid. One swept
      // input suffices to cancel an overlapping queued intent in arkd.
      const swept = original.filter(c => c.isSwept);
      // A live source covenant cannot have registered a batch intent: arkd
      // rejects its missing exit leaf. Its exact bridge spend is the next step;
      // the server still rejects it if an overlapping spend exists.
      const cancellationCoins = operation.bridge ? original : swept;
      const annotated = operation.bridge
        ? await (await wallet.getContractManager()).annotateVtxos(cancellationCoins)
        : await annotateOwnerInputs(chain, wallet, sourceTree, cancellationCoins);
      const cancellationInputs = cancellationCoins.map(({ txid, vout }) => ({ txid, vout }));
      const message: Intent.DeleteMessage = { type: 'delete', expire_at: 0 };
      if (cancellationCoins.length && (!operation.cancellationProof || JSON.stringify(operation.cancellationInputs ?? operation.inputs) !== JSON.stringify(cancellationInputs))) {
        const withParents = await withPrevTxs(annotated, chain.indexer, new EsploraProvider(chain.settings.esploraUrl));
        operation.cancellationProof = encodeBase64((await identity.sign(Intent.create(message, withParents, []))).toPSBT());
        operation.cancellationInputs = cancellationInputs;
        await store.put(operation);
      }
      try { if (cancellationCoins.length) await chain.ark.deleteIntent({ proof: operation.cancellationProof!, message }); }
      catch (error) {
        // arkd reports this after validating the proof when no queued intent matches.
        // A batch already in progress still competes for the SAME input set; never
        // replace those inputs or infer completion from this response.
        if (!(error instanceof ArkError && error.name === 'INVALID_INTENT_PROOF' && error.message.includes('no matching intents found for intent proof'))) {
          operation.lastError = error instanceof Error ? error.message : 'Intent cancellation failed';
          await store.put(operation); throw error;
        }
      }
      if (!operation.bridge && swept.length && swept.length !== original.length) {
        operation.supersededInputs = operation.inputs;
        operation.inputs = cancellationInputs;
        operation.amount = swept.reduce((sum, c) => sum + c.value, 0);
        operation.assets = assetTotals(swept);
      }
      operation.cancelledAt = Date.now(); operation.startedAt = undefined;
      await store.put(operation);
    } else throw new Error(`A maintenance settlement has an uncertain outcome. Resume to check and cancel its queued intent before retrying the same deposits.${operation.lastError ? ` Previous error: ${operation.lastError}` : ''}`);
  }
  if (!operation.settlementTxid) {
    // Refuse unsupported fee policies before signing or publishing any transfer.
    const info = await chain.ark.getInfo();
    if (Number(info.fees.txFeeRate) !== 0 || Object.values(info.fees.intentFee ?? {}).some(value => value !== '' && !/^0(?:\.0+)?$/.test(value)))
      throw new Error('Covenant maintenance currently requires zero settlement fees');
    let inputs: ExtendedVirtualCoin[];
    if (!operation.bridge) {
      const all = await covenantCoins(chain, sourceTree);
      const coins = operation.inputs.map(input => all.find(c => c.txid === input.txid && c.vout === input.vout));
      if (coins.some(c => !c)) throw new Error('A maintenance input was spent; inspect wallet activity before continuing');
      const recorded = coins.map(c => c!);
      if (recorded.reduce((sum, c) => sum + c.value, 0) !== operation.amount)
        throw new Error('Maintenance inputs do not match the recorded amount');
      const assets = assetTotals(recorded);
      if (operation.assets && JSON.stringify(assets) !== JSON.stringify(operation.assets))
        throw new Error('Maintenance inputs do not match the recorded assets');
      operation.assets ??= assets;
      inputs = await annotateOwnerInputs(chain, wallet, sourceTree, recorded);
      if (coins.some(c => !c!.isSwept)) {
        // Live covenant scripts have no unilateral exit leaf. Move through the
        // standard owner script before asking arkd to renew in a batch.
        if (coins.some(c => c!.isSwept)) throw new Error('Mixed swept and live deposits require separate maintenance');
        operation.bridge = await prepareOwnerTransfer(chain, identity, inputs, ArkAddress.decode(ownerAddress).pkScript);
        operation.settlementInputs = [{ txid: operation.bridge.txid, vout: 0 }];
        await store.put(operation);
      }
    } else inputs = [];
    if (operation.bridge) {
      await submitOwnerTransfer(chain, identity, operation.bridge);
      const ownerScript = hex(ArkAddress.decode(ownerAddress).pkScript);
      const coins = await waitFor(async () => {
        const { vtxos } = await chain.indexer.getVtxos({ scripts: [ownerScript] });
        return vtxos.find(c => c.txid === operation!.bridge!.txid && c.vout === 0 && depositState(c) !== 'spent');
      }, 'owner renewal bridge');
      if (coins.value !== operation.amount || JSON.stringify(assetTotals([coins])) !== JSON.stringify(operation.assets ?? []))
        throw new Error('Renewal bridge does not match recorded maintenance inputs');
      inputs = await (await wallet.getContractManager()).annotateVtxos([coins]);
    }
    operation.startedAt = Date.now(); await store.put(operation);
    try {
      operation.settlementTxid = await wallet.settle({ inputs, outputs: [{ address: ownerAddress, amount: BigInt(operation.amount) }] });
    } catch (error) {
      operation.lastError = error instanceof Error ? error.message : 'Settlement failed';
      await store.put(operation); throw error;
    }
    await store.put(operation);
  }
  if (!operation.transfer) {
    const commitment = operation.settlementTxid;
    const ownerScript = hex(ArkAddress.decode(ownerAddress).pkScript);
    const coins = await waitFor(async () => {
      const vtxos = await wallet.getVtxos();
      const matching = vtxos.filter(c => c.script === ownerScript && c.commitmentTxIds?.includes(commitment) && canSpendOffchain(c, { timestamp: new Date() }));
      return matching.length === 1 && matching[0]!.value === operation!.amount ? matching : undefined;
    }, 'recovered owner output');
    const coin = coins[0]!;
    if (operation.assets && JSON.stringify(assetTotals([coin])) !== JSON.stringify(operation.assets))
      throw new Error('Recovered assets do not match the recorded maintenance inputs');
    operation.transfer = await prepareOwnerTransfer(chain, identity, [coin], decoded.pkScript, options.packets);
    await store.put(operation);
  }
  await submitOwnerTransfer(chain, identity, operation.transfer);
  operation.completed = true; await store.put(operation);
  return operation;
}
