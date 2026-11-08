/**
 * Dependency-free WebAssembly code-section scanner used by the contract build and tests.
 * It reports instructions outside the WebAssembly MVP so the deployed artifact is
 * portable across NEAR runtime versions.
 */
/** Count post-MVP instructions in the code section. Returns {} for a pure MVP module. */
export function postMvpOpcodes(buf) {
  let p = 8;
  const leb = () => { let r = 0, s = 0, b; do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
  const skipSigned = () => { let b; do { b = buf[p++]; } while (b & 0x80); };
  const found = {};
  const bump = (k) => { found[k] = (found[k] || 0) + 1; };
  while (p < buf.length) {
    const id = buf[p++];
    const size = leb();
    const start = p;
    if (id === 10) {
      const count = leb();
      for (let f = 0; f < count; f++) {
        const bodySize = leb();
        const end = p + bodySize;
        const groups = leb();
        for (let g = 0; g < groups; g++) { leb(); p++; }
        while (p < end) {
          const op = buf[p++];
          if (op === 0xfc) { const sub = leb(); bump(sub <= 7 ? 'nontrapping-fptoint' : 'bulk-memory'); if (sub === 8) { leb(); p++; } else if (sub === 9 || sub === 13 || sub >= 15) leb(); else if (sub === 10) p += 2; else if (sub === 11) p++; else if (sub === 12 || sub === 14) { leb(); leb(); } continue; }
          if (op >= 0xc0 && op <= 0xc4) { bump('sign-ext'); continue; }
          if (op >= 0xd0 && op <= 0xd2) { bump('reference-types'); if (op === 0xd0) p++; if (op === 0xd2) leb(); continue; }
          if (op === 0xfd || op === 0xfe) { bump(op === 0xfd ? 'simd' : 'threads'); p = end; break; }
          if (op === 0x11) { leb(); if (buf[p] !== 0x00) bump('call-indirect-overlong'); leb(); continue; }
          if (op === 0x02 || op === 0x03 || op === 0x04) { const bt = buf[p]; if (bt === 0x40 || (bt >= 0x7b && bt <= 0x7f)) p++; else { bump('multivalue'); skipSigned(); } continue; }
          if (op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x24) || op === 0x3f || op === 0x40) { leb(); continue; }
          if (op === 0x0e) { const n = leb(); for (let i = 0; i <= n; i++) leb(); continue; }
          if (op === 0x1c) { bump('typed-select'); const n = leb(); p += n; continue; }
          if (op === 0x25 || op === 0x26) { bump('reference-types'); leb(); continue; }
          if (op >= 0x28 && op <= 0x3e) { leb(); leb(); continue; }
          if (op === 0x41 || op === 0x42) { skipSigned(); continue; }
          if (op === 0x43) { p += 4; continue; }
          if (op === 0x44) { p += 8; continue; }
        }
        p = end;
      }
    }
    p = start + size;
  }
  return found;
}
