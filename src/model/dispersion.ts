import type { ClubParams } from './types';

/** mulberry32 -- small, fast, deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pre-drawn standard normal / uniform noise, reused across every candidate
 * aim point.
 *
 * This is common random numbers, and it is not a micro-optimization. The
 * optimizer's output is a *comparison* between aim lines whose expected costs
 * differ by hundredths of a stroke. Drawing fresh samples per candidate makes
 * the Monte Carlo error on each candidate independent, so the argmin jitters
 * between neighbouring angles and the whole recommendation flickers when a
 * slider moves. Sharing the draws makes the error common to all candidates
 * and cancels almost entirely out of the differences.
 */
export interface NoiseBank {
  n: number;
  zLong: Float64Array;
  zLat: Float64Array;
  uMishit: Float64Array;
}

export function makeNoiseBank(n: number, seed = 0x5eed): NoiseBank {
  const rand = mulberry32(seed);
  const zLong = new Float64Array(n);
  const zLat = new Float64Array(n);
  const uMishit = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Box-Muller, both outputs used.
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    zLong[i] = r * Math.cos(theta);
    zLat[i] = r * Math.sin(theta);
    uMishit[i] = rand();
  }
  return { n, zLong, zLat, uMishit };
}

/**
 * Per-sample shot offsets in (longitudinal, lateral) yards relative to the
 * aim line, for one club. Computed once per club and reused across every
 * candidate aim direction -- rotating the same offsets is what makes the
 * angle sweep cheap.
 *
 * Spec 4.1: p(shot) = (1-w) N(mu_n, Sigma_n) + w N(mu_m, Sigma_m), Sigma
 * diagonal, sigma proportional to carry.
 */
export interface ShotCloud {
  n: number;
  /** Carry distance along the aim line, in yards. */
  carry: Float64Array;
  /** Offset perpendicular to the aim line; positive is right. */
  lateral: Float64Array;
  /** 1 if this sample came from the mishit component. */
  isMishit: Uint8Array;
}

export function sampleShotCloud(club: ClubParams, noise: NoiseBank): ShotCloud {
  const n = noise.n;
  const carry = new Float64Array(n);
  const lateral = new Float64Array(n);
  const isMishit = new Uint8Array(n);

  const sigmaLong = club.carrySigmaPct * club.meanCarry;
  const sigmaLat = club.lateralSigmaPct * club.meanCarry;
  const bias = club.lateralBiasPct * club.meanCarry;
  const mishitBias = club.mishitLateralBiasPct * club.meanCarry;

  for (let i = 0; i < n; i++) {
    const mishit = noise.uMishit[i] < club.mishitWeight;
    if (mishit) {
      isMishit[i] = 1;
      const mult = club.mishitSigmaMult;
      carry[i] = club.meanCarry * club.mishitCarryMult + noise.zLong[i] * sigmaLong * mult;
      lateral[i] = bias + mishitBias + noise.zLat[i] * sigmaLat * mult;
    } else {
      carry[i] = club.meanCarry + noise.zLong[i] * sigmaLong;
      lateral[i] = bias + noise.zLat[i] * sigmaLat;
    }
    // A shot cannot travel backwards, and a topped one still goes somewhere.
    if (carry[i] < 5) carry[i] = 5;
  }

  return { n, carry, lateral, isMishit };
}

/**
 * Roll after landing, as a fraction of the club's fairway roll. Landing in
 * something soft or grabby kills most of it.
 */
export function rollFactor(surface: string): number {
  switch (surface) {
    case 'fairway':
    case 'tee':
      return 1;
    case 'green':
      return 0.7;
    case 'rough':
      return 0.35;
    case 'trees':
      return 0.25;
    case 'bunker':
      return 0.1;
    default:
      return 0;
  }
}
