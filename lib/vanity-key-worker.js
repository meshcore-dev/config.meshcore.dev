// Vanity key generation worker
// Loads noble-ed25519 and brute-forces keys until prefix match

let nobleEd25519 = null;
let stopRequested = false;

async function loadLibrary() {
  const sources = [
    'https://unpkg.com/noble-ed25519@1.2.6/index.js',
    'https://cdn.jsdelivr.net/npm/noble-ed25519',
    'https://esm.sh/noble-ed25519',
  ];

  for (const url of sources) {
    try {
      nobleEd25519 = await import(url);
      return;
    } catch (e) {
      console.warn(`Worker: failed to load from ${url}:`, e.message);
    }
  }
  throw new Error('Failed to load noble-ed25519 from any source');
}

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha512(data) {
  const hash = await crypto.subtle.digest('SHA-512', data);
  return new Uint8Array(hash);
}

async function generateKeypair() {
  // Generate random 32-byte seed
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);

  // SHA-512 expand (matches Ed25519 RFC 8032)
  const expanded = await sha512(seed);

  // Clamp scalar (first 32 bytes)
  expanded[0] &= 0xf8;
  expanded[31] &= 0x7f;
  expanded[31] |= 0x40;

  const clampedScalar = expanded.slice(0, 32);

  // Convert to BigInt (little-endian)
  let scalar = 0n;
  for (let i = 0; i < 32; i++) {
    scalar += BigInt(clampedScalar[i]) << BigInt(8 * i);
  }

  // Compute public key using noble-ed25519 Point.BASE.multiply
  const point = nobleEd25519.Point.BASE.multiply(scalar);
  const pubKeyBytes = point.toRawBytes();

  // Private key for MeshCore = full 64-byte expanded key
  const privKeyHex = toHex(expanded);
  const pubKeyHex = toHex(pubKeyBytes);

  return { privKeyHex, pubKeyHex };
}

async function search(prefix, batchSize, progressInterval) {
  const prefixUpper = prefix.toUpperCase();
  let attempts = 0;
  let reportedAttempts = 0;
  let lastProgress = performance.now();

  while (!stopRequested) {
    const kp = await generateKeypair();
    attempts++;

    if (kp.pubKeyHex.toUpperCase().startsWith(prefixUpper)) {
      self.postMessage({
        type: 'match',
        privKey: kp.privKeyHex,
        pubKey: kp.pubKeyHex,
        attempts: attempts - reportedAttempts
      });
      return;
    }

    const now = performance.now();
    if (now - lastProgress >= progressInterval) {
      const delta = attempts - reportedAttempts;
      reportedAttempts = attempts;
      self.postMessage({ type: 'progress', attempts: delta });
      lastProgress = now;
      // Yield to event loop to receive stop messages
      await new Promise(r => setTimeout(r, 0));
    }
  }

  self.postMessage({ type: 'stopped', attempts: attempts - reportedAttempts });
}

self.onmessage = async (e) => {
  const { type, prefix, batchSize, progressInterval } = e.data;

  if (type === 'stop') {
    stopRequested = true;
    return;
  }

  if (type === 'start') {
    stopRequested = false;
    try {
      if (!nobleEd25519) {
        await loadLibrary();
      }
      await search(prefix, batchSize || 100, progressInterval || 200);
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};
