import path from 'node:path';
import { cargoEnv, root, runLinux } from './lib/linux.mjs';

// Windows Application Control blocks Cargo build scripts inside OneDrive.
// WSL plus an external target directory is also the environment used for the
// reproducible WASM artifact, so native tests and release builds share inputs.
const result = runLinux(['cargo', 'test', '--locked'], {
  cwd: path.join(root, 'contracts/bag-heist'),
  env: cargoEnv(),
});
process.exit(result.status ?? 1);
