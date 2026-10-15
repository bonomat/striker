import { ArkAddress, CSVMultisigTapscript, EsploraProvider, Extension, InMemoryContractRepository,
  InMemoryWalletRepository, RestArkProvider, RestEmulatorProvider, RestIndexerProvider,
  SingleKey, Transaction, Wallet, attachPrevArkTxs, type VtxoScript } from '@arkade-os/sdk';
import { schnorr } from '@noble/curves/secp256k1.js';
import { EPOCH_PACKET, bancoUserCovenant, covenantTree, makerCovenant } from './covenant.js';
import { buildSettlement, type Coin, type Settlement } from './settlement.js';
import { bytes, hex, type SignedOffer } from './wire.js';

export async function connectChain() {
  const ark = new RestArkProvider(process.env.ARK_URL ?? 'http://localhost:7070');
  const indexer = new RestIndexerProvider(process.env.ARK_URL ?? 'http://localhost:7070');
  const emulator = new RestEmulatorProvider(process.env.EMULATOR_URL ?? 'http://localhost:7073');
  const info = await ark.getInfo();
  if (info.network !== 'regtest') throw new Error('This PoC requires an Arkade regtest server');
  const server = Uint8Array.from(Buffer.from(info.signerPubkey, 'hex')).slice(-32);
  const emulatorKey = bytes(process.env.EMULATOR_PUBKEY ??
    '999413c46fa10ada5cbc4bcc79a1d09160c2ba3cfc812705d7a13e5e545fb2a9', 32, 'EMULATOR_PUBKEY');
  const checkpoint = CSVMultisigTapscript.decode(Uint8Array.from(Buffer.from(info.checkpointTapscript, 'hex')));
  return { ark, indexer, emulator, server, emulatorKey, checkpoint };
}
export type Chain = Awaited<ReturnType<typeof connectChain>>;
export async function createWallet(chain: Chain, secret: Uint8Array) {
  const identity = SingleKey.fromPrivateKey(secret);
  const wallet = await Wallet.create({ identity, arkProvider: chain.ark,
    onchainProvider: new EsploraProvider(process.env.ESPLORA_URL ?? 'http://localhost:3000/api',
      { forcePolling: true, pollingInterval: 2000 }),
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: false });
  const address = await wallet.getAddress();
  return { wallet, identity, address, publicKey: schnorr.getPublicKey(secret), payoutScript: ArkAddress.decode(address).pkScript };
}
export async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
export async function coinsAt(chain: Chain, tree: VtxoScript) {
  const result = await chain.indexer.getVtxos({ scripts: [hex(tree.pkScript)], spendableOnly: true });
  return result.vtxos;
}
export async function fundedCoin(chain: Chain, tree: VtxoScript, txid: string, vout?: number) {
  return waitFor(async () => (await coinsAt(chain, tree)).find(c => c.txid === txid && (vout === undefined || c.vout === vout)), 'funded covenant');
}
export async function epochOf(chain: Chain, coin: Coin): Promise<bigint> {
  const { txs } = await chain.indexer.getVirtualTxs([coin.txid]);
  const tx = txs.map(psbt => Transaction.fromPSBT(Buffer.from(psbt, 'base64'))).find(tx => tx.id === coin.txid);
  if (!tx) throw new Error('Cannot resolve maker deposit transaction');
  const encoded = Extension.fromTx(tx).getPacketByType(EPOCH_PACKET)?.serialize();
  if (!encoded || encoded.length !== 8) throw new Error('Invalid maker epoch packet');
  const value = new DataView(encoded.buffer, encoded.byteOffset, 8).getBigUint64(0, true);
  if (value > (1n << 63n) - 1n) throw new Error('Invalid maker epoch');
  return value;
}
export function makerContract(chain: Chain, offer: Pick<SignedOffer, 'deposit'>) {
  const script = makerCovenant(offer.deposit);
  return { script, tree: covenantTree(script, offer.deposit.makerPublicKey, chain.server, chain.emulatorKey) };
}
export function takerContract(chain: Chain, owner: Uint8Array, payoutScript: Uint8Array, minimum: bigint) {
  const script = bancoUserCovenant(payoutScript, minimum);
  const tree = covenantTree(script, owner, chain.server, chain.emulatorKey);
  return { script, tree, address: tree.address('tark', chain.server).encode() };
}
export async function liveMaker(chain: Chain, offer: SignedOffer) {
  const contract = makerContract(chain, offer);
  const coins = await coinsAt(chain, contract.tree);
  if (coins.length !== 1) throw new Error('Maker must have exactly one live deposit tip');
  const coin = coins[0]!;
  if (await epochOf(chain, coin) !== offer.quote.epoch) throw new Error('Maker quote was cancelled');
  if (BigInt(coin.value) - offer.quote.x < 330n) throw new Error('Insufficient maker liquidity');
  return { ...contract, coin };
}
export async function settle(chain: Chain, terms: Settlement) {
  const { arkTx, checkpoints } = buildSettlement(terms);
  await attachPrevArkTxs(arkTx, [terms.makerCoin.txid, terms.userCoin.txid], chain.indexer);
  const result = await chain.emulator.submitTx(Buffer.from(arkTx.toPSBT()).toString('base64'),
    checkpoints.map(cp => Buffer.from(cp.toPSBT()).toString('base64')));
  return { txid: Transaction.fromPSBT(Buffer.from(result.signedArkTx, 'base64')).id };
}
