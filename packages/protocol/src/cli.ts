import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { bytes, string } from './wire.js';

export function args(names: string[]) {
  const parsed = parseArgs({ allowPositionals: true, options: Object.fromEntries([
    ['help', { type: 'boolean' as const }], ...names.map(name => [name, { type: 'string' as const }]),
  ]) });
  return { values: parsed.values as Record<string, string | boolean | undefined>, positionals: parsed.positionals };
}
export function required(value: unknown, name: string): string { return string(value, name); }
export function secretKey(role: 'maker' | 'taker'): Uint8Array {
  const name = `${role.toUpperCase()}_PRIVATE_KEY`;
  return bytes(process.env[name], 32, name);
}
export function readJSON(file: string): unknown { return JSON.parse(readFileSync(file, 'utf8')); }
export function writeJSON(file: string, data: unknown, exclusive = false) {
  const text = JSON.stringify(data, null, 2) + '\n';
  if (exclusive) writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
  else {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, file);
  }
}
export function port(value: unknown, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65535) throw new Error('Invalid port');
  return number;
}
export function main(run: () => Promise<void>) {
  run().catch(error => { console.error(error instanceof Error ? error.message : 'Command failed'); process.exitCode = 1; });
}
