import { ArkAddress, CSVMultisigTapscript, EsploraProvider, Extension, InMemoryContractRepository,
  InMemoryWalletRepository, RestArkProvider, RestEmulatorProvider, RestIndexerProvider,
  SingleKey, Transaction, Wallet, attachPrevArkTxs, type VtxoScript } from '@arkade-os/sdk';
import { encodeBase64, decodeBase64 } from './encoding.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { EPOCH_PACKET, bancoUserCovenant, covenantTree, makerCovenant } from './covenant.js';
import { buildSettlement, type Coin, type Settlement } from './settlement.js';
import { bytes, hex, type SignedOffer } from './wire.js';

export interface ChainSettings {
  network: 'regtest' | 'mutinynet';
  arkUrl: string;
  emulatorUrl: string;
  esploraUrl: string;
  emulatorKey: string;
}
export async function connectChainWithSettings(settings: ChainSettings) {
  const ark = new RestArkProvider(settings.arkUrl);
  const indexer = new RestIndexerProvider(settings.arkUrl);
  const emulator = new RestEmulatorProvider(settings.emulatorUrl);
  const info = await ark.getInfo();
  if (info.network !== settings.network) throw new Error(`Expected ${settings.network}, server reports ${info.network}`);
  // Settlement currently conserves every satoshi; refuse a fee policy it cannot pay.
  if (Number(info.fees.txFeeRate) !== 0) throw new Error('PoC settlement requires zero offchain transaction fees');
  const server = bytes(info.signerPubkey, 33, 'server public key').slice(-32);
  const emulatorKey = bytes(settings.emulatorKey, 32, 'EMULATOR_PUBKEY');
  const emulatorInfo = await emulator.getInfo();
  if (emulatorInfo.signerPubkey.slice(-64) !== hex(emulatorKey))
    throw new Error('Emulator signer does not match the configured pinned key');
  const checkpoint = CSVMultisigTapscript.decode(Uint8Array.from(info.checkpointTapscript.match(/../g)!, byte => Number.parseInt(byte, 16)));
  return { ark, indexer, emulator, server, emulatorKey, checkpoint, settings };
}
export type Chain = Awaited<ReturnType<typeof connectChainWithSettings>>;
export async function createWallet(chain: Chain, secret: Uint8Array) {
  const identity = SingleKey.fromPrivateKey(secret);
  const wallet = await Wallet.create({ identity, arkProvider: chain.ark,
    onchainProvider: new EsploraProvider(chain.settings.esploraUrl,
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
  const tx = txs.map(psbt => Transaction.fromPSBT(decodeBase64(psbt))).find(tx => tx.id === coin.txid);
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
  const result = await chain.emulator.submitTx(encodeBase64(arkTx.toPSBT()),
    checkpoints.map(cp => encodeBase64(cp.toPSBT())));
  return { txid: Transaction.fromPSBT(decodeBase64(result.signedArkTx)).id };
}
