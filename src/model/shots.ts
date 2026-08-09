import { direction, dist, rightPerp } from './geometry';
import type { FeatureType, Point } from './types';

/**
 * Logged shots, and the empirical dispersion pattern built from them.
 *
 * This is the piece that eventually retires most of spec 4.2. A fitted mixture
 * with hierarchical shrinkage exists to squeeze a shape out of very few
 * observations; once the observations themselves are stored, the pattern *is*
 * the data and there is nothing left to fit. Pooling a club toward its family
 * stops being a shrinkage formula and becomes list concatenation.
 */

export interface Shot {
  id: string;
  clubId: string;
  /** ISO timestamp. */
  at: string;
  courseId?: string;
  holeId?: string;
  startLie: FeatureType;
  endLie: FeatureType;
  /** Yards from start to where the ball was aimed. */
  intendedDistance: number;
  /** Yards from start to where the ball finished. */
  actualDistance: number;
  /**
   * Signed offline angle in radians, positive right, measured against the
   * intended line.
   */
  offlineAngle: number;
  penalty: number;
}

/**
 * A shot reduced to two dimensionless numbers.
 *
 * Storing the ratio rather than the yardage is what lets a shot logged at 150
 * yards inform a pattern drawn at 200. It is the same assumption spec 4.1
 * makes when it stores sigma as a fraction of carry, applied to observations
 * instead of parameters.
 */
export interface NormalizedShot {
  /** actual distance / intended distance. 1.0 is pin-high. */
  ratio: number;
  /** Signed offline angle in radians; positive is right. */
  angle: number;
}

/**
 * Derive a loggable shot from three points: where it started, where it was
 * aimed, and where it finished.
 */
export function measureShot(start: Point, intended: Point, end: Point): {
  intendedDistance: number;
  actualDistance: number;
  offlineAngle: number;
} {
  const intendedDistance = dist(start, intended);
  const actualDistance = dist(start, end);
  if (intendedDistance < 1e-6 || actualDistance < 1e-6) {
    return { intendedDistance, actualDistance, offlineAngle: 0 };
  }
  const aim = direction(start, intended);
  const perp = rightPerp(aim);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const along = dx * aim.x + dy * aim.y;
  const across = dx * perp.x + dy * perp.y;
  return { intendedDistance, actualDistance, offlineAngle: Math.atan2(across, along) };
}

export function normalize(shot: Shot): NormalizedShot | null {
  if (shot.intendedDistance < 20) return null; // Putts and chips are a different model.
  return { ratio: shot.actualDistance / shot.intendedDistance, angle: shot.offlineAngle };
}

/**
 * Which clubs pool together when a club has too few shots of its own.
 * Spec 4.2's family level, minus the shrinkage arithmetic.
 */
export const FAMILY: Record<string, string> = {
  driver: 'driver',
  '3w': 'wood',
  '5w': 'wood',
  '4i': 'long_iron',
  '6i': 'mid_iron',
};

export interface PatternSource {
  own: NormalizedShot[];
  family: NormalizedShot[];
  /** Own shots plus family shots, in that order. What the sampler draws from. */
  pool: NormalizedShot[];
  ownCount: number;
  familyCount: number;
  /**
   * Weight given to observed shots against the questionnaire prior, using the
   * pseudo-count form from spec 4.2: n / (n + k). At k = 12 a club with 12
   * logged shots trusts its own data half the time.
   */
  realWeight: number;
}

export const SHRINKAGE_K = 12;

export function buildPattern(shots: Shot[], clubId: string): PatternSource {
  const own: NormalizedShot[] = [];
  const family: NormalizedShot[] = [];
  const wantFamily = FAMILY[clubId];
  for (const s of shots) {
    const n = normalize(s);
    if (!n) continue;
    if (s.clubId === clubId) own.push(n);
    else if (wantFamily && FAMILY[s.clubId] === wantFamily) family.push(n);
  }
  // Family shots count, but a club's own data should dominate once it exists.
  const effective = own.length + family.length * 0.35;
  return {
    own,
    family,
    pool: [...own, ...family],
    ownCount: own.length,
    familyCount: family.length,
    realWeight: effective / (effective + SHRINKAGE_K),
  };
}
