import { asset, buildOffchainTx, EmulatorPacket, Extension, type VtxoScript } from '@arkade-os/sdk';
import { RawWitness } from '@scure/btc-signer';
import { asInput, epochPacket, type Coin } from './settlement.js';
import { encodeIntent, intentDomain, makerWitness, intentRecords, MAX_INTENT_INPUTS, termsForInput, verifyIntent, type SignedTakerInput } from './intent.js';
import { equalBytes } from './quote.js';
import { hex, type SignedOffer } from './wire.js';
import type { Chain } from './chain-client.js';

export function buildIntentSettlement(chain: Chain, offer: SignedOffer, maker: { coin: Coin; tree: VtxoScript; script: Uint8Array },
  taker: { owner: Uint8Array; tree: VtxoScript; script: Uint8Array; coins: Coin[]; inputs: SignedTakerInput[] }) {
  const { coins, inputs } = taker, btcToToken = offer.deposit.direction === 'btc-to-token';
  if (!coins.length || coins.length > MAX_INTENT_INPUTS || coins.length !== inputs.length) throw new Error('Invalid taker input count');
  if (new Set(coins.map(c => `${c.txid}:${c.vout}`)).size !== coins.length) throw new Error('Duplicate taker input');
  if (inputs.some(i => i.signature !== inputs[0]!.signature)) throw new Error('Every taker input must share one batch signature');
  const batch = coins.map((coin, i) => ({ coin, paySats: BigInt(inputs[i]!.terms.paySats), payTokens: BigInt(inputs[i]!.terms.payTokens) }));
  const target = hex(offer.deposit.wantAsset), domain = intentDomain(chain);
  let paidSats = 0n, paidTokens = 0n;
  const changes = coins.map((coin, i) => {
    const input = inputs[i]!;
    if (input.coin.txid !== coin.txid || input.coin.vout !== coin.vout) throw new Error('Intent outpoint mismatch');
    const sats = BigInt(input.terms.paySats), tokens = BigInt(input.terms.payTokens);
    const expected = termsForInput(chain.checkpoint, taker.tree, offer, coin, sats, tokens, batch);
    if (!equalBytes(encodeIntent(domain, expected), encodeIntent(domain, input.terms)) || !verifyIntent(taker.owner, domain, input))
      throw new Error('Invalid taker authorization');
    const value = BigInt(coin.value) - sats;
    if (value < 330n || tokens < 0n || sats < 0n) throw new Error('Taker change must retain at least 330 sats');
    const held = BigInt(coin.assets?.find(a => a.assetId === target)?.amount ?? 0);
    if (tokens > held) throw new Error('Insufficient authorized token input');
    paidSats += sats; paidTokens += tokens;
    return { script: taker.tree.pkScript, amount: value };
  });
  if (paidSats !== (btcToToken ? offer.quote.y + 330n : 330n) || paidTokens !== (btcToToken ? 0n : offer.quote.y))
    throw new Error('Authorized contributions do not match quote');
  const makerRemainder = btcToToken ? BigInt(maker.coin.value) : BigInt(maker.coin.value) - offer.quote.x;
  if (makerRemainder < 330n) throw new Error('Insufficient maker liquidity');
  const groups = new Map<string, { ins: ReturnType<typeof asset.AssetInput.create>[]; outs: ReturnType<typeof asset.AssetOutput.create>[] }>();
  function group(id: string) {
    if (!groups.has(id)) groups.set(id, { ins: [], outs: [] });
    return groups.get(id)!;
  }
  for (const a of maker.coin.assets ?? []) {
    const g = group(a.assetId), held = BigInt(a.amount);
    g.ins.push(asset.AssetInput.create(0, held));
    if (a.assetId !== target || !btcToToken || held <= offer.quote.x) throw new Error('Invalid maker token liquidity');
    g.outs.push(asset.AssetOutput.create(0, offer.quote.x), asset.AssetOutput.create(1, held - offer.quote.x));
  }
  if (btcToToken && !maker.coin.assets?.some(a => a.assetId === target)) throw new Error('Missing maker asset');
  if (!btcToToken) group(target).outs.push(asset.AssetOutput.create(2, offer.quote.y));
  coins.forEach((coin, i) => {
    for (const a of coin.assets ?? []) {
      const g = group(a.assetId), held = BigInt(a.amount);
      g.ins.push(asset.AssetInput.create(i + 1, held));
      const remaining = held - (a.assetId === target ? BigInt(inputs[i]!.terms.payTokens) : 0n);
      if (remaining > 0n) g.outs.push(asset.AssetOutput.create(i + 3, remaining));
    }
  });
  const packet = asset.Packet.create([...groups].map(([id, g]) => asset.AssetGroup.create(asset.AssetId.fromString(id), null, g.ins, g.outs, [])));
  const emulator = EmulatorPacket.create([
    { vin: 0, script: maker.script, witness: makerWitness(offer) },
    ...inputs.map((input, i) => ({ vin: i + 1, script: taker.script,
      witness: RawWitness.encode([Uint8Array.from(input.signature.match(/../g)!, b => parseInt(b, 16)), encodeIntent(domain, input.terms), intentRecords(input.terms)]) })),
  ]);
  return buildOffchainTx([asInput(maker.coin, maker.tree), ...coins.map(c => asInput(c, taker.tree))], [
    { script: taker.tree.pkScript, amount: btcToToken ? 330n : offer.quote.x },
    { script: maker.tree.pkScript, amount: makerRemainder },
    { script: offer.deposit.payoutScript, amount: btcToToken ? offer.quote.y : 330n },
    ...changes,
    Extension.create([packet, emulator, epochPacket(offer.quote.epoch)]).txOut(),
  ], chain.checkpoint);
}
