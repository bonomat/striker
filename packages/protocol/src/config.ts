import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { emulatorMode, networkName } from './network.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytes, hex, object } from './wire.js';

export type Role = 'striker' | 'maker' | 'taker';
const defaults: Record<Role, Record<string, unknown>> = {
  striker: { host: '127.0.0.1', port: 4100, makers: 'http://127.0.0.1:4101' },
  maker: { host: '127.0.0.1', port: 4101, ttlSeconds: 30 },
  taker: { striker: 'http://127.0.0.1:4100', giveAmount: '2000' },
};

export function configDirectory(role: Role, explicit?: string): string {
  return path.resolve(explicit ?? process.env[`${role.toUpperCase()}_CONFIG_DIR`] ?? `.${role}`);
}

export function loadConfig(role: Role, explicit?: string, network = networkName()) {
  const keyDirectory = configDirectory(role, explicit);
  // Preserve existing regtest paths and share only identity keys across networks.
  const networkDirectory = network === 'regtest' ? keyDirectory : path.join(keyDirectory, network);
  const directory = emulatorMode(network) === 'local' ? path.join(networkDirectory, 'local-emulator') : networkDirectory;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'config.json');
  const initialDefaults: Record<string, unknown> = { ...defaults[role], ...(role === 'taker' && directory !== networkDirectory ? { giveAmount: '100' } : {}) };
  try { writeFileSync(file, JSON.stringify(initialDefaults, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const config = { ...initialDefaults, ...object(JSON.parse(readFileSync(file, 'utf8'))) };
  // Same chain and wallet: reuse the demo asset, but never the hosted-key deposit.
  if (role === 'taker' && directory !== networkDirectory && config.assetId === undefined) {
    const parentFile = path.join(networkDirectory, 'config.json');
    if (existsSync(parentFile)) {
      const parent = object(JSON.parse(readFileSync(parentFile, 'utf8')));
      if (typeof parent.assetId === 'string') config.assetId = parent.assetId;
    }
  }
  return { directory, keyDirectory, file, config };
}

function validateKey(encoded: string): Uint8Array {
  const key = bytes(encoded.trim(), 32, 'private key');
  try { schnorr.getPublicKey(key); }
  catch { throw new Error('Invalid private key'); }
  return key;
}

export function loadPrivateKey(file: string, override?: string): Uint8Array {
  const imported = override === undefined ? undefined : validateKey(override);
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const key = imported ?? schnorr.utils.randomSecretKey();
    try { writeFileSync(file, hex(key) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  if (!lstatSync(file).isFile()) throw new Error('Private key must be a regular file');
  const key = validateKey(readFileSync(file, 'utf8'));
  if (imported && hex(imported) !== hex(key))
    throw new Error('Environment private key differs from saved key; use a different --config-dir for another wallet');
  chmodSync(file, 0o600);
  return key;
}
