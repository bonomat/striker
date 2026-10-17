import { arkade, EmulatorPacket, Extension } from '@arkade-os/sdk';
import { RawWitness } from '@scure/btc-signer';
import { covenantTree, makerCovenant, tokenUserCovenant } from '../../packages/protocol/src/covenant.js';
import { hex } from '../../packages/protocol/src/wire.js';
import { buildSettlement, epochPacket, type Settlement } from '../../packages/protocol/src/settlement.js';
import { encodeQuote, signQuote } from '../../packages/protocol/src/quote.js';
import { fixture, payout, publicKey, secret } from '../../test/fixtures.js';
import { signedProgramCovenant, signedProgramDomain, signProgram } from './contract.js';

export function signedProgramVector() {
  const domain = signedProgramDomain('regtest', publicKey(3), publicKey(4), new Uint8Array(32).fill(0x42));
  const wrapper = signedProgramCovenant(publicKey(1), domain);
  const tree = covenantTree(wrapper, publicKey(1), publicKey(3), publicKey(4));
  return {
    version: 'striker/signed-program/v1-experimental',
    authority: hex(publicKey(1)), emulator: hex(publicKey(4)), domain: hex(domain),
    // scure represents a leaf script with its leaf-version byte appended.
    wrapper: hex(wrapper), scriptPubKey: hex(tree.pkScript), closureScript: hex(tree.leaves[0]![1].slice(0, -1)),
    policies: [{ amount: 700, recipient: payout(2) }, { amount: 800, recipient: payout(5) }].map(policy => {
      const program = arkade.ArkadeScript.encode([
        0, 'INSPECTOUTPUTVALUE', policy.amount, 'NUMEQUALVERIFY',
        0, 'INSPECTOUTPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY', policy.recipient.slice(2), 'EQUAL',
      ]);
      return { amount: policy.amount, recipient: hex(policy.recipient),
        program: hex(program), signature: hex(signProgram(secret(1), domain, program)) };
    }),
    settlements: (['token-to-btc', 'btc-to-token'] as const).map(direction => {
      const terms: Settlement = fixture();
      terms.deposit = { ...terms.deposit, direction };
      if (direction === 'btc-to-token') {
        terms.quote = { ...terms.quote, x: 200n, y: 1000n };
        terms.makerCoin = { ...terms.makerCoin, value: 660,
          assets: [{ assetId: hex(terms.deposit.wantAsset), amount: 1000n }] };
        terms.userCoin = { ...terms.userCoin, value: 1330 };
        terms.userScript = tokenUserCovenant(terms.userPayout, terms.quote.x, terms.deposit.wantAsset);
        terms.userTree = covenantTree(terms.userScript, publicKey(2), publicKey(3), publicKey(4));
      }
      const program = makerCovenant(terms.deposit);
      terms.signature = signQuote(terms.deposit, terms.quote, secret(1));
      const { arkTx } = buildSettlement({ ...terms, makerScript: wrapper, makerTree: tree });
      const assets = Extension.fromTx(arkTx).getAssetPacket()!;
      const packet = EmulatorPacket.create([
        { vin: 0, script: wrapper, witness: RawWitness.encode([
          terms.signature, encodeQuote(terms.deposit, terms.quote), program, signProgram(secret(1), domain, program),
        ]) },
        { vin: 1, script: terms.userScript, witness: RawWitness.encode([]) },
      ]);
      // buildOffchainTx also appends an anchor, so the extension is not the last output.
      for (let i = 0; i < arkTx.outputsLength; i++) {
        const script = arkTx.getOutput(i).script;
        if (script && Extension.isExtension(script)) {
          arkTx.updateOutput(i, Extension.create([assets, packet, epochPacket(0n)]).txOut());
          break;
        }
      }
      return { direction, psbt: Buffer.from(arkTx.toPSBT()).toString('base64'),
        epochExtension: hex(Extension.create([epochPacket(0n)]).serialize()),
        previous: [{ value: terms.makerCoin.value, script: hex(tree.pkScript) },
          { value: terms.userCoin.value, script: hex(terms.userTree.pkScript) }],
      };
    }),
  };
}
