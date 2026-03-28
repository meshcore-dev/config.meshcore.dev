export class VanityKeyGenerator {
  constructor() {
    this.workers = [];
    this.running = false;
    this._resolve = null;
    this._reject = null;
    this._totalAttempts = 0;
    this.onProgress = null;
  }

  static get numCores() {
    return navigator.hardwareConcurrency || 4;
  }

  /**
   * Estimate time for a given hex prefix length
   * @param {number} prefixLen - number of hex chars
   * @param {number} keysPerSec - estimated throughput
   * @returns {string} human-readable estimate
   */
  static estimateTime(prefixLen, keysPerSec) {
    if (prefixLen === 0) return 'instant';
    const expected = Math.pow(16, prefixLen);
    const seconds = expected / keysPerSec;

    if (seconds < 1) return 'less than a second';
    if (seconds < 60) return `~${Math.ceil(seconds)} seconds`;
    if (seconds < 3600) return `~${Math.ceil(seconds / 60)} minutes`;
    if (seconds < 86400) return `~${Math.ceil(seconds / 3600)} hours`;
    return `~${Math.ceil(seconds / 86400)} days`;
  }

  get attempts() {
    return this._totalAttempts;
  }

  /**
   * Start generating a vanity key
   * @param {string} prefix - hex prefix to match (1-6 chars)
   * @returns {Promise<{ privKey: string, pubKey: string, attempts: number } | null>}
   */
  generate(prefix) {
    if (this.running) throw new Error('Already running');

    prefix = prefix.replace(/[^0-9a-fA-F]/g, '');
    if (prefix.length === 0 || prefix.length > 6) {
      throw new Error('Prefix must be 1-6 hex characters');
    }

    this.running = true;
    this._totalAttempts = 0;
    const numWorkers = VanityKeyGenerator.numCores;

    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;

      for (let i = 0; i < numWorkers; i++) {
        const worker = new Worker(
          new URL('./vanity-key-worker.js', import.meta.url),
          { type: 'module' }
        );

        worker.onmessage = (e) => {
          if (!this.running) return;
          const data = e.data;

          if (data.type === 'progress') {
            this._totalAttempts += data.attempts;
            if (this.onProgress) this.onProgress(this._totalAttempts);
          } else if (data.type === 'match') {
            this._totalAttempts += data.attempts;
            const result = {
              privKey: data.privKey,
              pubKey: data.pubKey,
              attempts: this._totalAttempts,
            };
            this._stopWorkers();
            this.running = false;
            resolve(result);
          } else if (data.type === 'error') {
            this._stopWorkers();
            this.running = false;
            reject(new Error(data.message));
          } else if (data.type === 'stopped') {
            this._totalAttempts += data.attempts;
          }
        };

        worker.onerror = (err) => {
          this._stopWorkers();
          this.running = false;
          reject(new Error(err.message || 'Worker error'));
        };

        worker.postMessage({ type: 'start', prefix, progressInterval: 200 });
        this.workers.push(worker);
      }
    });
  }

  _stopWorkers() {
    for (const worker of this.workers) {
      try { worker.postMessage({ type: 'stop' }); } catch (e) {}
      setTimeout(() => worker.terminate(), 500);
    }
    this.workers = [];
  }

  cancel() {
    const reject = this._reject;
    this._stopWorkers();
    this.running = false;
    if (reject) reject(new Error('Cancelled'));
    this._resolve = null;
    this._reject = null;
  }
}
