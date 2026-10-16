import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex, loadPrivateKey, localEmulatorDirectory, writeJSON } from '@satora/striker-protocol';
import { chmodSync, writeFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function compose(args: string[]) {
  const child = spawn('docker', ['compose', '-f', path.join(root, 'compose.emulator.yml'),
    '--project-name', 'striker-mutinynet-emulator', ...args], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, STRIKER_EMULATOR_ENV_FILE: path.join(localEmulatorDirectory(), 'docker.env') },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error('Local Emulator Docker command failed');
}
export async function startLocalEmulator() {
  const directory = localEmulatorDirectory();
  const key = loadPrivateKey(path.join(directory, 'private-key'));
  const publicKey = hex(schnorr.getPublicKey(key));
  const arkUrl = process.env.ARK_URL ?? 'https://mutinynet.arkade.sh';
  const endpoint = new URL(arkUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || /[\r\n]/.test(arkUrl))
    throw new Error('Local Emulator requires an http(s) ARK_URL without credentials');
  writeFileSync(path.join(directory, 'docker.env'),
    `EMULATOR_SECRET_KEY=${hex(key)}\nEMULATOR_ARKD_URL=${arkUrl}\nEMULATOR_LOG_LEVEL=5\n`, { mode: 0o600 });
  chmodSync(path.join(directory, 'docker.env'), 0o600);
  // App processes read only this public pin, never the Emulator signing key.
  writeJSON(path.join(directory, 'public.json'), { publicKey, arkUrl });
  const image = spawn('docker', ['image', 'inspect', 'striker-emulator:v0.0.9-rc.2-striker.1'], { stdio: 'ignore' });
  const [imageCode] = await once(image, 'exit');
  await compose(['up', '-d', imageCode === 0 ? '--no-build' : '--build']);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:7074/v1/info', { signal: AbortSignal.timeout(1500) });
      const info = await response.json() as { signerPubkey?: string };
      if (response.ok && info.signerPubkey?.slice(-64) === publicKey) return;
    } catch { /* Wait for the gRPC connection to Mutinynet and the HTTP gateway. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await compose(['logs', '--tail', '50']);
  throw new Error('Local Emulator did not become ready; inspect just emulator-logs');
}
export async function stopLocalEmulator() { await compose(['stop']); }
export async function localEmulatorLogs() { await compose(['logs', '--tail', '100', '--follow']); }
