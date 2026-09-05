/**
 * Seeded random number generation for reproducible Monte Carlo runs.
 *
 * mulberry32: small, fast, well-distributed 32-bit PRNG. The seed is
 * persisted with every Monte Carlo result so any run can be reproduced.
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed(): number {
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}

/** Standard normal via Box-Muller. `1 - rng()` guards against log(0). */
export function normal01(rng: Rng): number {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function normalRandom(rng: Rng, mean: number, stddev: number): number {
  return mean + normal01(rng) * stddev;
}

/** Lognormal parameterized by the DESIRED mean/stddev of the output. */
export function lognormalRandom(rng: Rng, mean: number, stddev: number): number {
  if (mean <= 0) throw new Error("Lognormal distribution requires a positive mean");
  const variance = stddev * stddev;
  const mu = Math.log(mean * mean / Math.sqrt(variance + mean * mean));
  const sigma = Math.sqrt(Math.log(1 + variance / (mean * mean)));
  return Math.exp(mu + sigma * normal01(rng));
}

export function uniformRandom(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function triangularRandom(rng: Rng, min: number, mode: number, max: number): number {
  if (max <= min) return mode;
  const u = rng();
  const fc = (mode - min) / (max - min);
  if (u < fc) return min + Math.sqrt(u * (max - min) * (mode - min));
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

/** Marsaglia-Tsang gamma sampler (shape >= 1 handled via boost for < 1). */
function gammaRandom(rng: Rng, shape: number): number {
  if (shape < 1) {
    const g = gammaRandom(rng, shape + 1);
    return g * Math.pow(1 - rng(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal01(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function betaRandom(rng: Rng, alpha: number, beta: number): number {
  const x = gammaRandom(rng, alpha);
  const y = gammaRandom(rng, beta);
  return x / (x + y);
}

/** PERT distribution (modified beta over [min, max] with the given mode). */
export function pertRandom(rng: Rng, min: number, mode: number, max: number): number {
  if (max <= min) return mode;
  const lambda = 4;
  const alpha = 1 + lambda * (mode - min) / (max - min);
  const beta = 1 + lambda * (max - mode) / (max - min);
  return min + betaRandom(rng, alpha, beta) * (max - min);
}

/** Standard normal CDF (Abramowitz-Stegun erf approximation). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (z > 0) p = 1 - p;
  return p;
}

// ── Cholesky decomposition for correlated sampling ──

/**
 * Cholesky-decompose a correlation matrix. Throws if the matrix is not
 * positive definite (caller should surface this as a 422 with guidance).
 */
export function cholesky(matrix: number[][]): number[][] {
  const n = matrix.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      if (i === j) {
        const d = matrix[i][i] - sum;
        if (d <= 0) {
          throw new Error(
            "Correlation matrix is not positive definite — check that the pairwise correlations are jointly consistent",
          );
        }
        L[i][j] = Math.sqrt(d);
      } else {
        L[i][j] = (matrix[i][j] - sum) / L[j][j];
      }
    }
  }
  return L;
}
