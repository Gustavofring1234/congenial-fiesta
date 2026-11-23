/**
 * Yaz0 compressor (greedy LZ with hash chains). Used to re-pack archives and to
 * build round-trip test fixtures; output is accepted by the game decoder.
 */
export function compressYaz0(input: Uint8Array): Uint8Array {
  const MAX_DIST = 0x1000;
  const MAX_LEN = 0xff + 0x12;
  const out: number[] = [0x59, 0x61, 0x7a, 0x30];
  const n = input.length;
  out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, 0, 0, 0, 0, 0, 0, 0, 0);

  const HASH_SIZE = 1 << 15;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hash = (i: number) => ((input[i] << 10) ^ (input[i + 1] << 5) ^ input[i + 2]) & (HASH_SIZE - 1);
  const insert = (i: number) => {
    if (i + 2 >= n) return;
    const h = hash(i);
    prev[i] = head[h];
    head[h] = i;
  };

  let pos = 0;
  while (pos < n) {
    const codeIndex = out.length;
    out.push(0);
    let code = 0;
    for (let bit = 0; bit < 8 && pos < n; bit++) {
      let bestLen = 0;
      let bestDist = 0;
      if (pos + 2 < n) {
        let cand = head[hash(pos)];
        let chain = 64;
        const maxLen = Math.min(MAX_LEN, n - pos);
        while (cand >= 0 && pos - cand <= MAX_DIST && chain-- > 0) {
          let len = 0;
          while (len < maxLen && input[cand + len] === input[pos + len]) len++;
          if (len > bestLen) {
            bestLen = len;
            bestDist = pos - cand;
            if (len === maxLen) break;
          }
          cand = prev[cand];
        }
      }
      if (bestLen >= 3) {
        const d = bestDist - 1;
        if (bestLen >= 0x12) {
          out.push((d >> 8) & 0x0f, d & 0xff, bestLen - 0x12);
        } else {
          out.push((((bestLen - 2) << 4) | ((d >> 8) & 0x0f)) & 0xff, d & 0xff);
        }
        for (let i = 0; i < bestLen; i++) insert(pos + i);
        pos += bestLen;
      } else {
        code |= 0x80 >> bit;
        out.push(input[pos]);
        insert(pos);
        pos++;
      }
    }
    out[codeIndex] = code;
  }
  return Uint8Array.from(out);
}
