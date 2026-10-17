// Research only: requires the opt-in VM patch beside this file.
// None of the live maker/taker services import this module.
import { arkade } from '@arkade-os/sdk';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat } from '../../packages/protocol/src/quote.js';

export const EXPERIMENTAL_EVALVERIFY = 0xbd;
export const MAX_PROGRAM_BYTES = 10_000;

function fixed32(value: Uint8Array, name: string) {
  if (value.length !== 32) throw new Error(`${name} must be 32 bytes`);
  return value;
}

// Scope authorization to a network, infrastructure and unique deposit lineage.
export function signedProgramDomain(network: 'regtest' | 'mutinynet', server: Uint8Array,
  emulator: Uint8Array, lineage: Uint8Array): Uint8Array {
  return sha256(concat(new TextEncoder().encode('striker/signed-program/v1\0'),
    Uint8Array.of(network === 'regtest' ? 0 : 1), fixed32(server, 'server'),
    fixed32(emulator, 'emulator'), fixed32(lineage, 'lineage')));
}

export function programDigest(domain: Uint8Array, program: Uint8Array): Uint8Array {
  fixed32(domain, 'domain');
  if (!program.length || program.length > MAX_PROGRAM_BYTES) throw new Error('Invalid program size');
  return sha256(concat(domain, sha256(program)));
}

export function signProgram(secret: Uint8Array, domain: Uint8Array, program: Uint8Array): Uint8Array {
  return schnorr.sign(programDigest(domain, program), secret, new Uint8Array(32));
}

export function verifyProgram(authority: Uint8Array, domain: Uint8Array,
  program: Uint8Array, signature: Uint8Array): boolean {
  try { return schnorr.verify(signature, programDigest(domain, program), fixed32(authority, 'authority')); }
  catch { return false; }
}

export function signedProgramCovenant(authority: Uint8Array, domain: Uint8Array): Uint8Array {
  fixed32(authority, 'authority'); fixed32(domain, 'domain');
  // Initial stack: [...program_arguments, program, program_signature].
  return concat(arkade.ArkadeScript.encode([
    'SWAP', 'DUP', 'TOALTSTACK', 'SHA256', domain, 'SWAP', 'CAT', 'SHA256',
    authority, 'CHECKSIGFROMSTACK', 'VERIFY', 'FROMALTSTACK',
  ]), Uint8Array.of(EXPERIMENTAL_EVALVERIFY), arkade.ArkadeScript.encode([1]));
}

export function signedProgramWitness(args: Uint8Array[], program: Uint8Array, signature: Uint8Array): Uint8Array[] {
  if (!program.length || program.length > MAX_PROGRAM_BYTES) throw new Error('Invalid program size');
  if (signature.length !== 64) throw new Error('Program signature must be 64 bytes');
  return [...args, program, signature];
}
