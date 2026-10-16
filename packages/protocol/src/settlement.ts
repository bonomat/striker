import { asset, buildOffchainTx, EmulatorPacket, Extension, UnknownPacket,
  type ArkTxInput, type CSVMultisigTapscript, type VtxoScript } from '@arkade-os/sdk';
import { RawWitness } from '@scure/btc-signer';
import { EPOCH_PACKET } from './covenant.js';
import { encodeQuote, u63, verifyQuote, type Deposit, type Quote } from './quote.js';

export interface Coin { txid: string; vout: number; value: number; assets?: { assetId: string; amount: string | bigint | number }[] }
export interface Settlement {
  deposit: Deposit;
  quote: Quote;
  signature: Uint8Array;
  makerCoin: Coin;
  userCoin: Coin;
  makerTree: VtxoScript;
  userTree: VtxoScript;
  makerScript: Uint8Array;
  userScript: Uint8Array;
  userPayout: Uint8Array;
  checkpoint: CSVMultisigTapscript.Type;
}

export function epochPacket(epoch: bigint): UnknownPacket {
  return new UnknownPacket(EPOCH_PACKET, u63(epoch));
}

export function asInput(coin: Coin, tree: VtxoScript, leaf = 0): ArkTxInput {
  if (!Number.isSafeInteger(coin.value) || coin.value < 0) throw new Error('Invalid coin value');
  if (!tree.leaves[leaf]) throw new Error('Missing spend leaf');
  return { ...coin, tapTree: tree.encode(), tapLeafScript: tree.leaves[leaf] };
}

export function buildSettlement(s: Settlement) {
  const message = encodeQuote(s.deposit, s.quote);
  if (!verifyQuote(s.deposit, message, s.signature)) throw new Error('Invalid signed quote');
  if (s.deposit.direction === 'btc-to-token') {
    const token = s.makerCoin.assets?.find(a => a.assetId === asset.AssetId.fromBytes(s.deposit.wantAsset).toString());
    const held = BigInt(token?.amount ?? 0), remaining = held - s.quote.x;
    if (s.makerCoin.assets?.length !== 1 || remaining <= 0n || s.makerCoin.value < 330)
      throw new Error('PoC requires a positive recursive token remainder');
    if (s.userCoin.assets?.length || BigInt(s.userCoin.value) !== s.quote.y + 330n)
      throw new Error('User BTC funding must equal quoted payment plus 330 sats carrier');
    const assets = asset.Packet.create([asset.AssetGroup.create(
      asset.AssetId.fromBytes(s.deposit.wantAsset), null,
      [asset.AssetInput.create(0, held)],
      [asset.AssetOutput.create(0, s.quote.x), asset.AssetOutput.create(1, remaining)], [],
    )]);
    const emulator = EmulatorPacket.create([
      { vin: 0, script: s.makerScript, witness: RawWitness.encode([s.signature, message]) },
      { vin: 1, script: s.userScript, witness: RawWitness.encode([]) },
    ]);
    return buildOffchainTx([asInput(s.makerCoin, s.makerTree), asInput(s.userCoin, s.userTree)], [
      { script: s.userPayout, amount: 330n },
      { script: s.makerTree.pkScript, amount: BigInt(s.makerCoin.value) },
      { script: s.deposit.payoutScript, amount: s.quote.y },
      Extension.create([assets, emulator, epochPacket(s.quote.epoch)]).txOut(),
    ], s.checkpoint);
  }
  const remainder = BigInt(s.makerCoin.value) - s.quote.x;
  if (remainder < 330n) throw new Error('PoC requires a spendable recursive remainder (>=330 sats)');
  if (s.userCoin.value < 330) throw new Error('User asset carrier below dust');
  const assets = asset.Packet.create([asset.AssetGroup.create(
    asset.AssetId.fromBytes(s.deposit.wantAsset), null,
    [asset.AssetInput.create(1, s.quote.y)],
    [asset.AssetOutput.create(2, s.quote.y)], [],
  )]);
  const emulator = EmulatorPacket.create([
    { vin: 0, script: s.makerScript, witness: RawWitness.encode([s.signature, message]) },
    { vin: 1, script: s.userScript, witness: RawWitness.encode([]) },
  ]);
  return buildOffchainTx([
    asInput(s.makerCoin, s.makerTree), asInput(s.userCoin, s.userTree),
  ], [
    { script: s.userPayout, amount: s.quote.x },
    { script: s.makerTree.pkScript, amount: remainder },
    { script: s.deposit.payoutScript, amount: BigInt(s.userCoin.value) },
    Extension.create([assets, emulator, epochPacket(s.quote.epoch)]).txOut(),
  ], s.checkpoint);
}
