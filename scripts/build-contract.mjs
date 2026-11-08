#!/usr/bin/env node
/**
 * Reproducible contract build.
 *
 *   node scripts/build-contract.mjs
 *
 * 1. cargo build --release for wasm32-unknown-unknown with `--cfg near` (Linux;
 *    WSL on Windows) and path remapping, so the artifact does not depend on
 *    the machine's home or checkout directory.
 * 2. binaryen lowers the module to WebAssembly MVP and strips debug sections.
 * 3. The result is validated (MVP feature set, opcode scan, required exports,
 *    host imports) and its provenance is written to res/contract-build.json.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cargoEnv, root, runLinux, toLinuxPath } from './lib/linux.mjs';
import { postMvpOpcodes } from './lib/wasm-scan.mjs';

const REQUIRED_EXPORTS = [
  'new', 'register_profile', 'open_round', 'commit_solution', 'reveal_solution', 'finalize_round', 'claim_reward',
  'craft_crowbar', 'get_config', 'get_state', 'get_round', 'get_rounds', 'get_profile', 'get_commitment',
  'get_commitments', 'check_route', 'get_crowbar', 'get_crowbars', 'ft_transfer', 'ft_transfer_call',
  'ft_resolve_transfer', 'ft_total_supply', 'ft_balance_of', 'ft_metadata', 'storage_deposit', 'storage_withdraw',
  'storage_unregister', 'storage_balance_bounds', 'storage_balance_of',
];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const resDir = path.join(root, 'res');
mkdirSync(resDir, { recursive: true });
const rawOut = path.join(resDir, 'bag_heist.raw.wasm');

const { CARGO_TARGET_DIR } = cargoEnv();
const crate = path.join(root, 'contracts/bag-heist');
// CARGO_ENCODED_RUSTFLAGS is 0x1f-separated, which keeps paths with spaces intact.
const script = [
  'set -e',
  'CH="${CARGO_HOME:-$HOME/.cargo}"',
  `export CARGO_ENCODED_RUSTFLAGS="$(printf '%s\\x1f%s\\x1f%s\\x1f%s' --cfg near "--remap-path-prefix=$CH/registry/src=/cargo/registry" '--remap-path-prefix=${toLinuxPath(root)}=/bag-heist')"`,
  'cargo build --release --locked --target wasm32-unknown-unknown',
  `cp "${CARGO_TARGET_DIR}/wasm32-unknown-unknown/release/bag_heist.wasm" '${toLinuxPath(rawOut)}'`,
  'rustc --version',
  'cargo --version',
].join('\n');
const built = runLinux(['bash', '-c', script], { cwd: crate, env: { CARGO_TARGET_DIR }, capture: true });
if (built.status !== 0) fail(`cargo build failed:\n${built.stderr || built.stdout}`);
const [rustc, cargo] = built.stdout.trim().split(/\r?\n/).slice(-2);

const wasmOpt = path.join(root, 'node_modules/binaryen/bin/wasm-opt');
const artifact = path.join(resDir, 'bag_heist.wasm');
const passes = ['-Oz', '--llvm-memory-copy-fill-lowering', '--signext-lowering', '--llvm-nontrapping-fptoint-lowering', '--strip-debug', '--strip-producers', '--strip-target-features'];
const run = (args) => {
  const r = spawnSync(process.execPath, [wasmOpt, ...args], { stdio: 'inherit' });
  if (r.status !== 0) fail(`wasm-opt ${args.join(' ')} failed`);
};
run([rawOut, ...passes, '-o', artifact]);
run([artifact, '--mvp-features', '--enable-mutable-globals', '-o', path.join(os.tmpdir(), 'bag-heist-mvp-check.wasm')]);

const raw = readFileSync(rawOut);
const code = readFileSync(artifact);
const residual = postMvpOpcodes(code);
if (Object.keys(residual).length) fail(`Post-MVP opcodes remain: ${JSON.stringify(residual)}`);
const module = new WebAssembly.Module(code);
const exports = WebAssembly.Module.exports(module).map((e) => e.name).sort();
const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
for (const required of ['env.panic_utf8', 'env.sha256', 'env.log_utf8']) {
  if (!imports.includes(required)) fail(`Missing host import ${required}; was --cfg near applied?`);
}
const missing = REQUIRED_EXPORTS.filter((name) => !exports.includes(name));
if (missing.length) fail(`Missing exports: ${missing.join(', ')}`);

const sources = ['Cargo.toml', 'Cargo.lock', 'src/lib.rs', 'src/board.rs', 'src/types.rs'];
const binaryen = JSON.parse(readFileSync(path.join(root, 'node_modules/binaryen/package.json'), 'utf8')).version;
const record = {
  artifact: 'res/bag_heist.wasm',
  bytes: code.length,
  sha256: sha256(code),
  raw_cargo_output: { bytes: raw.length, sha256: sha256(raw) },
  rustc,
  cargo,
  binaryen,
  target: 'wasm32-unknown-unknown',
  rustflags: '--cfg near + path remapping (/bag-heist, /cargo/registry)',
  wasm_opt_passes: passes,
  mvp_validated: true,
  exports: exports.length,
  source_sha256: Object.fromEntries(sources.map((f) => [f, sha256(readFileSync(path.join(crate, f)))])),
};
writeFileSync(path.join(resDir, 'contract-build.json'), JSON.stringify(record, null, 2) + '\n');
writeFileSync(path.join(resDir, 'bag_heist.wasm.sha256'), `${record.sha256}  bag_heist.wasm\n`);
console.log(`res/bag_heist.wasm  ${code.length} bytes  sha256 ${record.sha256}`);
console.log(`${rustc} | ${cargo} | binaryen ${binaryen} | ${exports.length} exports | MVP validated`);
