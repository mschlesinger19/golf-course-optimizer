import { rollFactor, sampleShotCloud, type NoiseBank, type ShotCloud } from './dispersion';
import { expectedStrokes, type CostConfig } from './expectedStrokes';
import {
  angleBetweenDeg,
  containsPoint,
  direction,
  dist,
  findDropPoint,
  pointAlongPolyline,
  resolveLie,
  rightPerp,
  rotateDeg,
  type CompiledHole,
} from './geometry';
import type { ClubParams, FeatureType, Lie, Point } from './types';

/** How a sample finished. `water` and `ob` are recorded before relief is taken. */
export type Outcome = 'fairway' | 'green' | 'rough' | 'bunker' | 'trees' | 'water' | 'ob';

export const OUTCOMES: Outcome[] = [
  'green',
  'fairway',
  'rough',
  'bunker',
  'trees',
  'water',
  'ob',
];

function featureToLie(type: FeatureType): Lie {
  switch (type) {
    case 'bunker':
      return 'sand';
    case 'trees':
      return 'recovery';
    case 'green':
      return 'green';
    case 'fairway':
      return 'fairway';
    case 'tee':
      return 'tee';
    default:
      return 'rough';
  }
}

export interface Candidate {
  /** Degrees right of the reference line. Negative is left. */
  angleDeg: number;
  /** Where the aim line puts the club's mean carry -- what gets drawn. */
  aimPoint: Point;
  /** Expected total strokes to hole out, including this shot. */
  expectedStrokes: number;
  /** Fraction of samples finishing in each outcome. Sums to 1. */
  outcomeShare: Record<Outcome, number>;
  /** Mean remaining distance to the pin over non-penalty samples, in yards. */
  meanRemaining: number;
}

export interface ClubResult {
  club: ClubParams;
  candidates: Candidate[];
  /** Index of the lowest expected-strokes candidate. */
  bestIndex: number;
  /** Index of the candidate aimed straight at the pin (angle 0). */
  pinIndex: number;
  /**
   * Index of the candidate aimed down the centreline at this club's carry --
   * the line a golfer takes without thinking about it, and the honest thing
   * to measure a recommendation against on a dogleg.
   */
  naiveIndex: number;
  /** Landing points of a subset of samples on the best line, for the scatter plot. */
  bestScatter: Point[];
  /** Landing points on the naive line, for the scatter plot. */
  naiveScatter: Point[];
}

export interface OptimizeOptions {
  /** Half-width of the angle sweep, in degrees. */
  sweepDeg?: number;
  /** Angular resolution, in degrees. */
  stepDeg?: number;
  /** How many sample landing points to retain for plotting. */
  scatterCount?: number;
}

interface SampleAccumulator {
  total: number;
  counts: Int32Array;
  remainingSum: number;
  remainingCount: number;
}

/**
 * Evaluate one aim direction.
 *
 * Sample resolution follows spec section 8, with two additions the pseudocode
 * leaves out: the ball rolls after it lands (and the roll depends on what it
 * landed on, which is what lets a drive trickle into a hazard it carried), and
 * a water ball takes relief near where it went in rather than being replayed.
 */
function evaluateDirection(
  compiled: CompiledHole,
  start: Point,
  dir: Point,
  cloud: ShotCloud,
  club: ClubParams,
  config: CostConfig,
  startCost: number,
  pin: Point,
  scatterOut: Point[] | null,
  scatterStride: number,
): SampleAccumulator {
  const perp = rightPerp(dir);
  const counts = new Int32Array(OUTCOMES.length);
  let total = 0;
  let remainingSum = 0;
  let remainingCount = 0;

  for (let i = 0; i < cloud.n; i++) {
    const carry = cloud.carry[i];
    const lat = cloud.lateral[i];
    let x = start.x + dir.x * carry + perp.x * lat;
    let y = start.y + dir.y * carry + perp.y * lat;

    let lie = resolveLie(compiled, x, y);

    if (lie.type === 'ob') {
      // Stroke and distance (spec 3.1): the penalty stroke plus a replay from
      // where this shot started. Combined with the leading stroke below this
      // resolves to E(original position) + 2.
      counts[OUTCOMES.indexOf('ob')]++;
      total += 1 + 1 + startCost;
      if (scatterOut && i % scatterStride === 0) scatterOut.push({ x, y });
      continue;
    }

    if (lie.type === 'water') {
      counts[OUTCOMES.indexOf('water')]++;
      const drop = findDropPoint(compiled, { x, y }, dir, start);
      const dropLie = resolveLie(compiled, drop.x, drop.y);
      const dropCost = expectedStrokes(
        dist(drop, pin),
        featureToLie(dropLie.type),
        config,
        dropLie.penaltyModifier,
      );
      total += 1 + 1 + dropCost;
      if (scatterOut && i % scatterStride === 0) scatterOut.push({ x, y });
      continue;
    }

    // Roll out, then re-resolve -- a drive can carry the bunker and run in.
    const roll = club.rollFairway * rollFactor(lie.type);
    if (roll > 0) {
      x += dir.x * roll;
      y += dir.y * roll;
      lie = resolveLie(compiled, x, y);

      if (lie.type === 'ob') {
        counts[OUTCOMES.indexOf('ob')]++;
        total += 1 + 1 + startCost;
        if (scatterOut && i % scatterStride === 0) scatterOut.push({ x, y });
        continue;
      }
      if (lie.type === 'water') {
        counts[OUTCOMES.indexOf('water')]++;
        const drop = findDropPoint(compiled, { x, y }, dir, start);
        const dropLie = resolveLie(compiled, drop.x, drop.y);
        total +=
          1 +
          1 +
          expectedStrokes(
            dist(drop, pin),
            featureToLie(dropLie.type),
            config,
            dropLie.penaltyModifier,
          );
        if (scatterOut && i % scatterStride === 0) scatterOut.push({ x, y });
        continue;
      }
    }

    const remaining = Math.hypot(x - pin.x, y - pin.y);
    const outcome: Outcome =
      lie.type === 'green'
        ? 'green'
        : lie.type === 'fairway' || lie.type === 'tee'
          ? 'fairway'
          : lie.type === 'bunker'
            ? 'bunker'
            : lie.type === 'trees'
              ? 'trees'
              : 'rough';
    counts[OUTCOMES.indexOf(outcome)]++;
    total += 1 + expectedStrokes(remaining, featureToLie(lie.type), config, lie.penaltyModifier);
    remainingSum += remaining;
    remainingCount++;
    if (scatterOut && i % scatterStride === 0) scatterOut.push({ x, y });
  }

  return { total, counts, remainingSum, remainingCount };
}

/**
 * Sweep aim directions for one club and return the whole cost curve, not just
 * the argmin.
 *
 * The spec's pseudocode grids over candidate aim *points* in 2D. For a full
 * shot with a chosen club the carry is set by the club, so an aim point only
 * carries one degree of freedom -- the direction -- and the sweep is 1D. That
 * is the same search, ~40x cheaper, and it has the side benefit of producing a
 * cost-versus-angle curve, which is the thing that actually shows how sharply
 * the recommendation is defined. Club choice supplies the second dimension by
 * running this per club (spec section 8).
 */
export function optimizeClub(
  compiled: CompiledHole,
  start: Point,
  startLie: Lie,
  club: ClubParams,
  noise: NoiseBank,
  config: CostConfig,
  options: OptimizeOptions = {},
): ClubResult {
  const sweepDeg = options.sweepDeg ?? 45;
  const stepDeg = options.stepDeg ?? 1;
  const scatterCount = options.scatterCount ?? 400;

  const pin = compiled.hole.pin;
  const referenceDir = direction(start, pin);
  const cloud = sampleShotCloud(club, noise);
  const startCost = expectedStrokes(dist(start, pin), startLie, config);
  const scatterStride = Math.max(1, Math.floor(noise.n / scatterCount));

  // "Straight down the middle" for this club: the centreline point at roughly
  // where this club finishes, expressed as an angle off the pin line.
  const naiveTarget =
    compiled.hole.centerline.length > 1
      ? pointAlongPolyline(compiled.hole.centerline, club.meanCarry + club.rollFairway)
      : pin;
  const naiveAngle = angleBetweenDeg(referenceDir, direction(start, naiveTarget));

  const candidates: Candidate[] = [];
  let bestIndex = 0;
  let pinIndex = 0;
  let naiveIndex = 0;

  for (let angle = -sweepDeg; angle <= sweepDeg + 1e-9; angle += stepDeg) {
    const dir = rotateDeg(referenceDir, angle);
    const acc = evaluateDirection(
      compiled,
      start,
      dir,
      cloud,
      club,
      config,
      startCost,
      pin,
      null,
      scatterStride,
    );

    const outcomeShare = {} as Record<Outcome, number>;
    for (let k = 0; k < OUTCOMES.length; k++) {
      outcomeShare[OUTCOMES[k]] = acc.counts[k] / cloud.n;
    }

    const index = candidates.length;
    candidates.push({
      angleDeg: angle,
      aimPoint: { x: start.x + dir.x * club.meanCarry, y: start.y + dir.y * club.meanCarry },
      expectedStrokes: acc.total / cloud.n,
      outcomeShare,
      meanRemaining: acc.remainingCount > 0 ? acc.remainingSum / acc.remainingCount : NaN,
    });
    if (candidates[index].expectedStrokes < candidates[bestIndex].expectedStrokes) {
      bestIndex = index;
    }
    if (Math.abs(angle) < Math.abs(candidates[pinIndex].angleDeg)) {
      pinIndex = index;
    }
    if (Math.abs(angle - naiveAngle) < Math.abs(candidates[naiveIndex].angleDeg - naiveAngle)) {
      naiveIndex = index;
    }
  }

  const scatterFor = (index: number): Point[] => {
    const out: Point[] = [];
    evaluateDirection(
      compiled,
      start,
      rotateDeg(referenceDir, candidates[index].angleDeg),
      cloud,
      club,
      config,
      startCost,
      pin,
      out,
      scatterStride,
    );
    return out;
  };

  return {
    club,
    candidates,
    bestIndex,
    pinIndex,
    naiveIndex,
    bestScatter: scatterFor(bestIndex),
    naiveScatter: scatterFor(naiveIndex),
  };
}

export interface PlanResult {
  byClub: ClubResult[];
  /** Index into byClub of the club with the lowest achievable expected strokes. */
  bestClubIndex: number;
}

export function optimizeShot(
  compiled: CompiledHole,
  start: Point,
  startLie: Lie,
  clubs: ClubParams[],
  noise: NoiseBank,
  config: CostConfig,
  options: OptimizeOptions = {},
): PlanResult {
  const byClub = clubs.map((club) =>
    optimizeClub(compiled, start, startLie, club, noise, config, options),
  );
  let bestClubIndex = 0;
  for (let i = 1; i < byClub.length; i++) {
    const a = byClub[i].candidates[byClub[i].bestIndex].expectedStrokes;
    const b = byClub[bestClubIndex].candidates[byClub[bestClubIndex].bestIndex].expectedStrokes;
    if (a < b) bestClubIndex = i;
  }
  return { byClub, bestClubIndex };
}

/** Is this point inside any polygon of the given type? Used by the map renderer. */
export function pointIsType(compiled: CompiledHole, p: Point, type: FeatureType): boolean {
  return compiled.polygons.some((poly) => poly.type === type && containsPoint(poly, p.x, p.y));
}
