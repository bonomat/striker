import { randomBytes } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import type { IWallet, Identity } from '@arkade-os/sdk';
import { covenantInventory, depositJSON, epochPacket, hex, maintainCovenant, makerContract,
  object, parseDeposit, readJSON, writeJSON, type Chain, type MaintenanceOperation } from '@satora/striker-protocol';

interface Journal {
  sourceState: Record<string, unknown>;
  nextState: Record<string, unknown>;
  operation?: MaintenanceOperation;
}

export async function maintainMakerPool(file: string, chain: Chain, wallet: IWallet, identity: Pick<Identity, 'sign'>, thresholdMs: number) {
  const journalFile = `${file}.maintenance.json`;
  let journal = existsSync(journalFile) ? readJSON(journalFile) as Journal : undefined;
  if (!journal) {
    const state = object(readJSON(file)), deposit = parseDeposit(state.deposit), { tree } = makerContract(chain, { deposit });
    const inventory = await covenantInventory(chain, tree, thresholdMs);
    const states = inventory.map(c => c.state);
    if (states.includes('awaiting-sweep')) throw new Error('Maker deposits expired and are waiting for the Arkade sweep');
    if (!states.some(s => s === 'recoverable' || s === 'expiring')) return false;
    if (inventory.length !== 1) throw new Error('Maker maintenance requires exactly one deposit tip; consolidate ambiguous pools before renewing');
    // New lineage revokes all outstanding old quotes even though the rate is unchanged.
    const nextState = { ...state, deposit: depositJSON({ ...deposit, lineage: randomBytes(32) }) };
    journal = { sourceState: state, nextState };
    writeJSON(journalFile, journal, true);
  }
  const saved = journal;
  for (const state of [saved.sourceState, saved.nextState]) {
    if (state.network !== chain.settings.network || state.serverPublicKey !== hex(chain.server) || state.emulatorPublicKey !== hex(chain.emulatorKey))
      throw new Error('Maker maintenance journal belongs to different infrastructure');
  }
  const source = makerContract(chain, { deposit: parseDeposit(saved.sourceState.deposit) });
  const target = makerContract(chain, { deposit: parseDeposit(saved.nextState.deposit) });
  const operation = await maintainCovenant({ chain, wallet, identity, sourceTree: source.tree,
    destination: target.tree.address('tark', chain.server).encode(), packets: [epochPacket(0n)],
    store: { async get() { return saved.operation; }, async put(operation) { saved.operation = operation; writeJSON(journalFile, saved); } } });
  writeJSON(file, { ...saved.nextState, originalCoin: { txid: operation.transfer!.txid, vout: 0, value: operation.amount } });
  renameSync(journalFile, `${file}.maintenance-${operation.transfer!.txid}.json`);
  return true;
}
