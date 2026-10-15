import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const checkout = path.join(root, '.cache/arkade-regtest');
const revision = '9ac38fe94585bf99a65581d2e79eda63c7e61b6b';
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const [command = 'start', ...args] = process.argv.slice(2);
if (!existsSync(path.join(checkout, '.git'))) {
  mkdirSync(path.dirname(checkout), { recursive: true });
  run('git', ['clone', '--no-checkout', 'https://github.com/ArkLabsHQ/arkade-regtest.git', checkout]);
  run('git', ['checkout', '--detach', revision], checkout);
}
const actual = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' });
if (actual.stdout?.trim() !== revision) throw new Error(`Regtest checkout must be pinned to ${revision}`);
if (command === 'setup') process.exit(0);
run(process.execPath, [path.join(checkout, 'regtest.mjs'), command, '--env', path.join(root, '.env.regtest'), ...args]);
