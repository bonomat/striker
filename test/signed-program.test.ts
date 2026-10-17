import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { arkade, Extension, Transaction } from '@arkade-os/sdk';
import { RawWitness } from '@scure/btc-signer';
import { publicKey, secret } from './fixtures.js';
import { bytes } from '../packages/protocol/src/wire.js';
import { signedProgramVector } from '../experiments/signed-programs/vector.js';
import { signedProgramCovenant, signedProgramDomain, signProgram, verifyProgram,
  signedProgramWitness, MAX_PROGRAM_BYTES } from '../experiments/signed-programs/contract.js';

test('signed witness programs have a fixed wrapper and reproducible cross-language vector', () => {
  const vector = signedProgramVector();
  assert.deepEqual(vector, JSON.parse(readFileSync(new URL('../experiments/signed-programs/vector.json', import.meta.url), 'utf8')));
  const domain = bytes(vector.domain, 32, 'domain');
  for (const policy of vector.policies) {
    const program = Uint8Array.from(Buffer.from(policy.program, 'hex'));
    const sig = bytes(policy.signature, 64, 'signature');
    assert(verifyProgram(publicKey(1), domain, program, sig));
    assert.deepEqual(signedProgramWitness([], program, sig), [program, sig]);
    assert.equal(Buffer.from(signedProgramCovenant(publicKey(1), domain)).toString('hex'), vector.wrapper);
  }
  for (const settlement of vector.settlements) {
    const tx = Transaction.fromPSBT(Buffer.from(settlement.psbt, 'base64'));
    const packet = Extension.fromTx(tx).getEmulatorPacket()!;
    const entry = packet.entries[0]!;
    assert(entry.witness);
    const witness = RawWitness.decode(entry.witness);
    assert.equal(witness.length, 4); // quote signature, quote, program, program signature
    assert.equal(Buffer.from(entry.script).toString('hex'), vector.wrapper);
    assert(verifyProgram(publicKey(1), domain, witness[2]!, witness[3]!));
  }
});

test('program signatures reject substituted code, authorities and deployment domains', () => {
  const lineage = new Uint8Array(32).fill(0x42);
  const domain = signedProgramDomain('regtest', publicKey(3), publicKey(4), lineage);
  const program = arkade.ArkadeScript.encode([1]);
  const signature = signProgram(secret(1), domain, program);
  assert(!verifyProgram(publicKey(1), domain, arkade.ArkadeScript.encode([0]), signature));
  assert(!verifyProgram(publicKey(2), domain, program, signature));
  for (const changed of [
    signedProgramDomain('mutinynet', publicKey(3), publicKey(4), lineage),
    signedProgramDomain('regtest', publicKey(2), publicKey(4), lineage),
    signedProgramDomain('regtest', publicKey(3), publicKey(2), lineage),
    signedProgramDomain('regtest', publicKey(3), publicKey(4), new Uint8Array(32)),
  ]) assert(!verifyProgram(publicKey(1), changed, program, signature));
  for (const invalid of [new Uint8Array(), new Uint8Array(MAX_PROGRAM_BYTES + 1)])
    assert.throws(() => signProgram(secret(1), domain, invalid), /program size/);
});
