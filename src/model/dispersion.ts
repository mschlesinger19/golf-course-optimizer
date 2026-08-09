import type { PatternSource } from './shots';
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
  /** Chooses between a logged shot and the prior, per sample. */
  uBlend: Float64Array;
  /** Selects which logged shot to bootstrap, per sample. */
  uIndex: Float64Array;
}

export function makeNoiseBank(n: number, seed = 0x5eed): NoiseBank {
  const rand = mulberry32(seed);
  const zLong = new Float64Array(n);
  const zLat = new Float64Array(n);
  const uMishit = new Float64Array(n);
  const uBlend = new Float64Array(n);
  const uIndex = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Box-Muller, both outputs used.
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    zLong[i] = r * Math.cos(theta);
    zLat[i] = r * Math.sin(theta);
    uMishit[i] = rand();
    uBlend[i] = rand();
    uIndex[i] = rand();
  }
  return { n, zLong, zLat, uMishit, uBlend, uIndex };
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
  /** Component along the aim line, in yards. */
  carry: Float64Array;
  /** Offset perpendicular to the aim line; positive is right. */
  lateral: Float64Array;
  /** Radial distance travelled, in yards. Mean of this is the club's carry. */
  radius: Float64Array;
  /** Signed offline angle in radians; positive is right. */
  angle: Float64Array;
  /** 1 if this sample came from the mishit component. */
  isMishit: Uint8Array;
}

/**
 * Dispersion is angular, not rectangular.
 *
 * A shot leaves the face on a direction and travels a distance. The offline
 * error is an angle, so the pattern is a cone spreading from the ball: its
 * cross-section at constant distance is an arc, and a strike that comes up
 * short is proportionally less offline in yards. Sampling a fixed perpendicular
 * offset instead would give an ellipse with a flat far edge and would put the
 * full sideways spread on a shot that travelled 40 yards less -- wrong in a way
 * that matters most for exactly the mishits that decide whether to bail out.
 *
 * This is also the plainer reading of spec 4.1: sigma stored as a fraction of
 * carry, applied to the carry each shot actually had.
 */
export function sampleShotCloud(
  club: ClubParams,
  noise: NoiseBank,
  pattern?: PatternSource,
): ShotCloud {
  const n = noise.n;
  const carry = new Float64Array(n);
  const lateral = new Float64Array(n);
  const radius = new Float64Array(n);
  const angle = new Float64Array(n);
  const isMishit = new Uint8Array(n);

  const sigmaLong = club.carrySigmaPct * club.meanCarry;
  // Percentages are lateral yards per yard of carry, i.e. the tangent of the
  // offline angle. At these magnitudes atan matters little, but it keeps the
  // stored percentage meaning exactly what it says at every distance.
  const sigmaAngle = Math.atan(club.lateralSigmaPct);
  const biasAngle = Math.atan(club.lateralBiasPct);
  const mishitBiasAngle = Math.atan(club.mishitLateralBiasPct);

  const pool = pattern?.pool ?? [];
  const realWeight = pool.length > 0 ? (pattern?.realWeight ?? 0) : 0;

  for (let i = 0; i < n; i++) {
    // Bootstrap a logged shot, or fall back to the prior. The split is spec
    // 4.2's n/(n+k) shrinkage, applied per sample rather than per parameter --
    // which means the pattern's *shape* comes from real shots as soon as any
    // exist, instead of being averaged into a Gaussian that never had the
    // shape in the first place.
    if (realWeight > 0 && noise.uBlend[i] < realWeight) {
      const picked = pool[Math.min(pool.length - 1, Math.floor(noise.uIndex[i] * pool.length))];
      const rr = Math.max(5, club.meanCarry * picked.ratio);
      radius[i] = rr;
      angle[i] = picked.angle;
      carry[i] = rr * Math.cos(picked.angle);
      lateral[i] = rr * Math.sin(picked.angle);
      isMishit[i] = 0;
      continue;
    }

    const mishit = noise.uMishit[i] < club.mishitWeight;
    let r: number;
    let theta: number;
    if (mishit) {
      isMishit[i] = 1;
      const mult = club.mishitSigmaMult;
      r = club.meanCarry * club.mishitCarryMult + noise.zLong[i] * sigmaLong * mult;
      theta = biasAngle + mishitBiasAngle + noise.zLat[i] * sigmaAngle * mult;
    } else {
      r = club.meanCarry + noise.zLong[i] * sigmaLong;
      theta = biasAngle + noise.zLat[i] * sigmaAngle;
    }
    // A shot cannot travel backwards, and a topped one still goes somewhere.
    if (r < 5) r = 5;
    radius[i] = r;
    angle[i] = theta;
    carry[i] = r * Math.cos(theta);
    lateral[i] = r * Math.sin(theta);
  }

  return { n, carry, lateral, radius, angle, isMishit };
}

/**
 * A shot cloud centred on an arbitrary target distance rather than the club's
 * own carry.
 *
 * This is what the drag-and-drop page needs. Dragging a crosshair says "I want
 * the ball to finish here" -- the player will flight it or club down to suit --
 * so the pattern centres on the target and the spread scales with the distance
 * actually being hit, which is exactly why spec 4.1 stores sigma as a fraction
 * of carry rather than in yards.
 *
 * The mishit carry multiplier still applies, because coming up short is a
 * property of the strike, not of the target.
 */
export function sampleTargetCloud(
  club: ClubParams,
  noise: NoiseBank,
  targetDistance: number,
  pattern?: PatternSource,
): ShotCloud {
  const scaled: ClubParams = { ...club, meanCarry: Math.max(targetDistance, 1) };
  return sampleShotCloud(scaled, noise, pattern);
}

/**
 * The drawable envelope of a shot cloud: a wedge, described by a radius band
 * and an angle band.
 *
 * Measured from the samples rather than derived from the parameters, so the
 * arc on screen always bounds the dots on screen. With a mixture that has a
 * one-directional mishit component the cloud is skewed, and a shape computed
 * from the normal component alone would sit visibly off its own scatter.
 */
export interface PatternShape {
  meanRadius: number;
  sdRadius: number;
  meanAngle: number;
  sdAngle: number;
  /** Half-width of the drawn band, in standard deviations. */
  k: number;
  /** Arc width across the band at the mean radius, in yards. */
  widthYards: number;
  /** Depth of the band along the aim line, in yards. */
  depthYards: number;
}

export function patternShape(cloud: ShotCloud, k = 1.5): PatternShape {
  const n = cloud.n;
  let rSum = 0;
  let aSum = 0;
  for (let i = 0; i < n; i++) {
    rSum += cloud.radius[i];
    aSum += cloud.angle[i];
  }
  const meanRadius = rSum / n;
  const meanAngle = aSum / n;
  let rVar = 0;
  let aVar = 0;
  for (let i = 0; i < n; i++) {
    rVar += (cloud.radius[i] - meanRadius) ** 2;
    aVar += (cloud.angle[i] - meanAngle) ** 2;
  }
  const sdRadius = Math.sqrt(rVar / n);
  const sdAngle = Math.sqrt(aVar / n);
  return {
    meanRadius,
    sdRadius,
    meanAngle,
    sdAngle,
    k,
    widthYards: 2 * k * sdAngle * meanRadius,
    depthYards: 2 * k * sdRadius,
  };
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
