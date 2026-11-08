/**
 * Runs a command in a Linux environment: natively on Linux/macOS, or inside
 * WSL on Windows. Rust builds and the near-sandbox node run here because the
 * sandbox ships Linux/macOS binaries only, and Linux builds of the contract
 * are byte-for-byte reproducible in CI.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '../..');
const distro = process.env.BAG_HEIST_WSL_DISTRO || 'Ubuntu-24.04';

export function toLinuxPath(p) {
  if (process.platform !== 'win32') return p;
  const resolved = path.resolve(p);
  return `/mnt/${resolved[0].toLowerCase()}${resolved.slice(2).replaceAll('\\', '/')}`;
}

/** Quote a single argument for bash. */
const quote = (arg) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${String(arg).replaceAll("'", `'\\''`)}'`);

/**
 * Run `command` (array of argv) with `env` (object of extra variables) in `cwd`.
 * Returns the spawnSync result; stdio is inherited unless `capture` is set.
 */
export function runLinux(command, { cwd = root, env = {}, capture = false } = {}) {
  if (process.platform !== 'win32') {
    return spawnSync(command[0], command.slice(1), {
      cwd, env: { ...process.env, ...env }, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8',
    });
  }
  // wsl.exe expands $VARS itself, so the script travels through stdin instead of argv.
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${quote(v)}`).join('\n');
  const script = `set -e\nsource ~/.cargo/env 2>/dev/null || true\ncd ${quote(toLinuxPath(cwd))}\n${exports}\n${command.map(quote).join(' ')}\n`;
  return spawnSync('wsl.exe', ['-d', distro, '--', 'bash', '-s'], {
    input: script, stdio: ['pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'], encoding: 'utf8',
  });
}

export function cargoEnv() {
  return { CARGO_TARGET_DIR: process.platform === 'win32' ? '/root/.cache/bag-heist-target' : path.join(root, 'contracts/bag-heist/target') };
}
