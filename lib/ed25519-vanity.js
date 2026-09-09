/**
 * Minimal ed25519 arithmetic for MeshCore vanity key search.
 *
 * MeshCore stores a 64-byte private key and derives the public key with
 * ed25519_derive_pub(), which feeds prv_key[0..31] straight into
 * ge_scalarmult_base(). The scalar is therefore *not* required to be the
 * SHA-512 expansion of a seed - any correctly clamped scalar works, and
 * bytes 32..63 (the signing nonce prefix) can be random.
 *
 * That lets the search walk the curve incrementally: starting from a random
 * clamped scalar s, each step adds 8*G to the point and 8 to the scalar,
 * which keeps the clamping intact (low 3 bits clear) while costing a single
 * point addition instead of a full scalar multiplication. Affine y values are
 * recovered for a whole batch with one modular inversion (Montgomery's trick).
 */

const P = (1n << 255n) - 19n;
const M255 = (1n << 255n) - 1n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const D2 = (D * 2n) % P;
const Gx = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const Gy = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;

// Reduce a product (< 2^510) mod 2^255-19. Folding the high limb with the
// mask/shift identity is ~2x faster than BigInt's generic `%`.
function fmod(x) {
  let lo = x & M255, hi = x >> 255n;
  x = lo + hi * 19n;
  lo = x & M255; hi = x >> 255n;
  x = lo + hi * 19n;
  return x >= P ? x - P : x;
}
const fmul = (a, b) => fmod(a * b);
const fsqr = (a) => fmod(a * a);
const fadd = (a, b) => { const r = a + b; return r >= P ? r - P : r; };
const fsub = (a, b) => { const r = a - b; return r < 0n ? r + P : r; };

// x^(p-2) mod p, via the standard ref10 addition chain
function finv(z) {
  const z2 = fsqr(z);
  let t = fsqr(fsqr(z2));
  const z9 = fmul(t, z);
  const z11 = fmul(z9, z2);
  const z2_5_0 = fmul(fsqr(z11), z9);
  t = z2_5_0; for (let i = 0; i < 5; i++) t = fsqr(t);
  const z2_10_0 = fmul(t, z2_5_0);
  t = z2_10_0; for (let i = 0; i < 10; i++) t = fsqr(t);
  const z2_20_0 = fmul(t, z2_10_0);
  t = z2_20_0; for (let i = 0; i < 20; i++) t = fsqr(t);
  const z2_40_0 = fmul(t, z2_20_0);
  t = z2_40_0; for (let i = 0; i < 10; i++) t = fsqr(t);
  const z2_50_0 = fmul(t, z2_10_0);
  t = z2_50_0; for (let i = 0; i < 50; i++) t = fsqr(t);
  const z2_100_0 = fmul(t, z2_50_0);
  t = z2_100_0; for (let i = 0; i < 100; i++) t = fsqr(t);
  const z2_200_0 = fmul(t, z2_100_0);
  t = z2_200_0; for (let i = 0; i < 50; i++) t = fsqr(t);
  t = fmul(t, z2_50_0);
  for (let i = 0; i < 5; i++) t = fsqr(t);
  return fmul(t, z11);
}

// Extended twisted-Edwards coordinates: [X, Y, Z, T], x = X/Z, y = Y/Z
const G = [Gx, Gy, 1n, fmul(Gx, Gy)];
const IDENTITY = [0n, 1n, 1n, 0n];

/** Precompute the addend in "cached" form: [Y-X, Y+X, 2d*T, 2Z] */
const cache = (p) => [fsub(p[1], p[0]), fadd(p[1], p[0]), fmul(D2, p[3]), fadd(p[2], p[2])];

/** add-2008-hwcd-3 (a = -1), 8 field multiplications */
function addCached(p, c) {
  const A = fmul(fsub(p[1], p[0]), c[0]);
  const B = fmul(fadd(p[1], p[0]), c[1]);
  const C = fmul(p[3], c[2]);
  const Dz = fmul(p[2], c[3]);
  const E = fsub(B, A), F = fsub(Dz, C), H = fadd(B, A), I = fadd(Dz, C);
  return [fmul(E, F), fmul(I, H), fmul(F, I), fmul(E, H)];
}

/** dbl-2008-hwcd */
function dbl(p) {
  const A = fsqr(p[0]), B = fsqr(p[1]), C = fmod(2n * fsqr(p[2]));
  const H = fadd(A, B);
  const E = fsub(H, fsqr(fadd(p[0], p[1])));
  const I = fsub(A, B);
  const F = fadd(C, I);
  return [fmul(E, F), fmul(I, H), fmul(F, I), fmul(E, H)];
}

function scalarMulBase(k) {
  let q = IDENTITY, d = G;
  while (k > 0n) {
    if (k & 1n) q = addCached(q, cache(d));
    d = dbl(d);
    k >>= 1n;
  }
  return q;
}

/** Invert every element of `zs` in place using a single finv() call. */
function batchInvert(zs, n, scratch) {
  let run = zs[0];
  scratch[0] = run;
  for (let i = 1; i < n; i++) { run = fmul(run, zs[i]); scratch[i] = run; }
  let inv = finv(run);
  for (let i = n - 1; i > 0; i--) {
    const zi = fmul(inv, scratch[i - 1]);
    inv = fmul(inv, zs[i]);
    zs[i] = zi;
  }
  zs[0] = inv;
}

function toBytesLE(v, len) {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Compress an extended point to the 32-byte ed25519 public key. */
function encodePoint(p) {
  const zi = finv(p[2]);
  const x = fmul(p[0], zi);
  const y = fmul(p[1], zi);
  const b = toBytesLE(y, 32);
  b[31] |= Number(x & 1n) << 7;
  return b;
}

/** Clamp a 32-byte little-endian value the way ed25519_create_keypair does. */
function clampScalar(bytes) {
  const b = Uint8Array.from(bytes);
  b[0] &= 248;
  b[31] &= 63;
  b[31] |= 64;
  let s = 0n;
  for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(b[i]);
  return s;
}

export {
  P, fmod, fmul, fsqr, fadd, fsub, finv,
  G, IDENTITY, cache, addCached, dbl, scalarMulBase, batchInvert,
  encodePoint, clampScalar, toBytesLE, toHex,
};
