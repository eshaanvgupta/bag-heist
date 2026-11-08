#!/usr/bin/env node
/** `node scripts/cargo.mjs test [args]` runs cargo for the contract crate (in WSL on Windows). */
import path from 'node:path';
import { cargoEnv, root, runLinux } from './lib/linux.mjs';

const args = process.argv.slice(2);
const result = runLinux(['cargo', ...args], { cwd: path.join(root, 'contracts/bag-heist'), env: cargoEnv() });
process.exit(result.status ?? 1);
