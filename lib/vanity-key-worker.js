// Vanity key generation worker.
//
// Walks the curve incrementally (scalar += 8, point += 8G) and recovers a whole
// batch of affine y values with one modular inversion. Only y is needed to test
// a prefix: the compressed public key is little-endian y, so hex chars 0..7 are
// bytes 0..3 of y. The x coordinate (for the sign bit) is computed once, for a hit.

import {
  fmul, cache, addCached, scalarMulBase, batchInvert,
  encodePoint, clampScalar, toBytesLE, toHex,
} from './ed25519-vanity.js';

const BATCH = 512;
const STEP = 8n; // keeps the clamped scalar's low 3 bits clear

let stopRequested = false;

// 8*G in cached form - the constant added at every step
const STEP_POINT = cache(scalarMulBase(STEP));

function randomClampedScalar() {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return clampScalar(seed);
}

async function search(prefix, progressInterval) {
  const target = parseInt(prefix, 16);
  const shift = 32 - 4 * prefix.length;
  const divisor = Math.pow(2, shift); // shift right without 32-bit overflow

  const s0 = randomClampedScalar();
  let p = scalarMulBase(s0);

  const Ys = new Array(BATCH), Zs = new Array(BATCH);
  const scratch = new Array(BATCH);

  let attempts = 0;
  let reported = 0;
  let lastProgress = performance.now();

  while (!stopRequested) {
    for (let i = 0; i < BATCH; i++) {
      p = addCached(p, STEP_POINT);
      Ys[i] = p[1]; Zs[i] = p[2];
    }
    batchInvert(Zs, BATCH, scratch);

    for (let i = 0; i < BATCH; i++) {
      const y = fmul(Ys[i], Zs[i]);
      const v = Number(y & 0xffffffffn);
      const b0 = v & 0xff;
      // MeshCore's validatePrivateKey() rejects public keys starting 00 or FF
      if (b0 === 0 || b0 === 0xff) continue;
      const packed = b0 * 0x1000000
        + ((v >>> 8) & 0xff) * 0x10000
        + ((v >>> 16) & 0xff) * 0x100
        + ((v >>> 24) & 0xff);
      if (Math.floor(packed / divisor) === target) {
        const scalar = s0 + STEP * BigInt(attempts + i + 1);
        emitMatch(scalar, attempts + i + 1 - reported);
        return;
      }
    }

    attempts += BATCH;

    const now = performance.now();
    if (now - lastProgress >= progressInterval) {
      self.postMessage({ type: 'progress', attempts: attempts - reported });
      reported = attempts;
      lastProgress = now;
      // Yield so queued 'stop' messages get a chance to run
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  self.postMessage({ type: 'stopped', attempts: attempts - reported });
}

function emitMatch(scalar, deltaAttempts) {
  const pubKey = encodePoint(scalarMulBase(scalar));
  // Private key = clamped scalar || random signing nonce prefix
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const prv = new Uint8Array(64);
  prv.set(toBytesLE(scalar, 32), 0);
  prv.set(nonce, 32);

  self.postMessage({
    type: 'match',
    privKey: toHex(prv),
    pubKey: toHex(pubKey),
    attempts: deltaAttempts,
  });
}

self.onmessage = async (e) => {
  const { type, prefix, progressInterval } = e.data;

  if (type === 'stop') {
    stopRequested = true;
    return;
  }

  if (type === 'start') {
    stopRequested = false;
    try {
      await search(prefix.toLowerCase(), progressInterval || 250);
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};
