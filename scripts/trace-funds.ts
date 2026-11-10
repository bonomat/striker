// Usage: npx tsx scripts/trace-funds.ts <tark address> [...]
// Lists every VTXO ever held at the addresses and follows spends forward.
import { ArkAddress } from '@arkade-os/sdk';
const ark = process.env.ARK_URL ?? 'https://mutinynet.arkade.sh';
const get = async (q: string) => (await (await fetch(`${ark}/v1/indexer/vtxos?${q}`)).json()) as { vtxos: any[] };
const seen = new Set<string>();
const show = (v: any, depth: number) => {
  const pad = '  '.repeat(depth);
  const flags = ['isSpent', 'isSwept', 'isUnrolled', 'isPreconfirmed'].filter(k => v[k]).join(',');
  console.log(`${pad}${v.outpoint.txid}:${v.outpoint.vout} ${v.amount} sats script=${v.script.slice(0, 16)}… [${flags}] expires=${new Date(Number(v.expiresAt) * 1000).toISOString()}`
    + `${v.assets?.length ? ' assets=' + JSON.stringify(v.assets) : ''}${v.settledBy ? ' settledBy=' + v.settledBy : ''}${v.arkTxid ? ' arkTx=' + v.arkTxid : ''}${v.spentBy ? ' spentBy=' + v.spentBy : ''}`);
};
async function follow(v: any, depth: number): Promise<void> {
  const key = `${v.outpoint.txid}:${v.outpoint.vout}`; if (seen.has(key)) return; seen.add(key);
  show(v, depth);
  const next = v.arkTxid || v.settledBy; if (!next || depth > 8) return;
  // Outputs of the spending tx (offchain tx or batch) — look up a few vouts.
  for (let vout = 0; vout < 4; vout++) {
    const { vtxos } = await get(`outpoints=${next}:${vout}`);
    for (const o of vtxos ?? []) await follow(o, depth + 1);
  }
}
for (const a of process.argv.slice(2)) {
  const script = Buffer.from(ArkAddress.decode(a).pkScript).toString('hex');
  console.log(`\n== ${a}\n   script ${script}`);
  const { vtxos } = await get(`scripts=${script}`);
  for (const v of (vtxos ?? []).sort((x, y) => Number(x.createdAt) - Number(y.createdAt))) await follow(v, 1);
}
