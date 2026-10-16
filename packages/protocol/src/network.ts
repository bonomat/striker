import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ESPLORA_URL, MUTINYNET_EMULATOR_PUBKEY, REGTEST_EMULATOR_PUBKEY } from '@arkade-os/sdk';

export type Network = 'regtest' | 'mutinynet';
export function networkName(value = process.env.STRIKER_NETWORK ?? 'regtest'): Network {
  if (value !== 'regtest' && value !== 'mutinynet') throw new Error('Network must be regtest or mutinynet');
  return value;
}
export function emulatorMode(network = networkName()): 'hosted' | 'local' {
  const mode = process.env.STRIKER_EMULATOR ?? 'hosted';
  if (mode !== 'hosted' && mode !== 'local') throw new Error('STRIKER_EMULATOR must be hosted or local');
  if (mode === 'local' && network !== 'mutinynet') throw new Error('Local Emulator profile is for Mutinynet; regtest already has its own Emulator');
  return mode;
}
export function localEmulatorDirectory(): string {
  return path.resolve(process.env.EMULATOR_CONFIG_DIR ?? '.emulator');
}
export function networkSettings(network = networkName()) {
  const hosted = network === 'mutinynet';
  const local = emulatorMode(network) === 'local';
  let localKey: string | undefined;
  if (local) {
    try {
      const saved = JSON.parse(readFileSync(path.join(localEmulatorDirectory(), 'public.json'), 'utf8'));
      if (saved.arkUrl !== (process.env.ARK_URL ?? 'https://mutinynet.arkade.sh')) throw new Error('Local Emulator uses a different Arkade server');
      if (typeof saved.publicKey !== 'string' || !/^[0-9a-f]{64}$/.test(saved.publicKey)) throw new Error('Invalid local Emulator public key');
      localKey = saved.publicKey;
    } catch (error) { throw new Error(`Run just emulator-start first: ${error instanceof Error ? error.message : 'Missing local Emulator pin'}`); }
  }
  return { network,
    arkUrl: process.env.ARK_URL ?? (hosted ? 'https://mutinynet.arkade.sh' : 'http://localhost:7070'),
    emulatorUrl: process.env.EMULATOR_URL ?? (local ? 'http://127.0.0.1:7074' : hosted ? 'https://emulator.mutinynet.arkade.sh' : 'http://localhost:7073'),
    esploraUrl: process.env.ESPLORA_URL ?? ESPLORA_URL[network],
    emulatorKey: process.env.EMULATOR_PUBKEY ?? localKey ?? (hosted ? MUTINYNET_EMULATOR_PUBKEY : REGTEST_EMULATOR_PUBKEY).slice(2),
  };
}
