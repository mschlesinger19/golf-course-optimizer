import type { ClubParams } from './types';

/**
 * Questionnaire onboarding, spec section 5.
 *
 * The design rule the spec insists on: do not ask for sigma, and do not ask for
 * "average" distance. Golfers report their best shot as their average, usually
 * by 8-12 yards. Ask for counts and directions, which people report accurately,
 * and infer the spread.
 *
 * =====================================================================
 *  What is sourced here and what is not
 * =====================================================================
 *
 * The *answers* are real: they describe how you actually play. That is what
 * makes this materially better than the invented bag in `clubs.ts`, and it is
 * why it sidesteps spec 12 open #3 -- no published handicap-band prior is
 * needed if the player tells you their own fairway rate.
 *
 * The *mapping* from answers to parameters is mine. Every constant below is a
 * modelling assumption, not a citation. They are gathered at the top, named,
 * and exported so they can be argued with, overridden, or replaced wholesale
 * when real calibration data exists. None of them is a number I found; they
 * are numbers I chose, and the inferences are only as good as they are.
 */
export const ASSUMPTIONS = {
  /** Half-width of a fairway at driving distance, yards. */
  FAIRWAY_HALF_WIDTH: 16,
  /** Effective radius of a green, yards. */
  GREEN_RADIUS: 10,
  /** Approach distance the GIR rate is treated as representing, yards. */
  GIR_REFERENCE_DISTANCE: 150,
  /** Full swings per round that could produce a penalty. */
  FULL_SHOTS_PER_ROUND: 30,
  /** Fraction of mishits that actually end up penalised on a typical course. */
  PENALTY_GIVEN_MISHIT: 0.35,
  /** A one-way miss is modelled as a bias of this many sigma. */
  ONE_WAY_BIAS_SIGMA: 0.6,
  /** The flush-versus-thin gap is treated as spanning the 10th to 90th percentile. */
  GAP_SIGMA_SPAN: 2.563,
  /** Stated carry is treated as the 75th percentile, per spec section 5 item 5. */
  STATED_CARRY_Z: 0.674,
  /** Mishit spread multiplier. Not recoverable from any question here. */
  MISHIT_SIGMA_MULT: 2.4,
  /** Mishits carry this fraction of a normal strike. Also not recoverable. */
  MISHIT_CARRY_MULT: 0.83,
  /** A one-way player's bad miss leans this many times further than the good one. */
  MISHIT_BIAS_MULT: 3,
} as const;

export type MissShape = 'left' | 'right' | 'two-way';

export interface Questionnaire {
  /** Out of 14. Spec section 5 item 1. */
  fairwaysHit: number;
  /** Penalty or OB strokes in a typical round. Item 2 -- sets the mishit weight. */
  penaltiesPerRound: number;
  /** Greens in regulation, out of 18. Item 3. */
  greensInRegulation: number;
  /** Item 4. Large effect on aim points, per the spec. */
  miss: MissShape;
  /** Item 6: "flush a 7-iron versus catch it thin -- what's the yardage gap?" */
  flushThinGapYards: number;
  /** Item 5: stated carries, treated as the 75th percentile, not the mean. */
  carries: Record<string, number>;
}

export const DEFAULT_QUESTIONNAIRE: Questionnaire = {
  fairwaysHit: 6,
  penaltiesPerRound: 1.5,
  greensInRegulation: 5,
  miss: 'two-way',
  flushThinGapYards: 20,
  carries: { driver: 245, '3w': 220, '5w': 202, '4i': 185, '6i': 165 },
};

/** Standard normal CDF, Abramowitz & Stegun 26.2.17. */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Solve for the lateral sigma that reproduces an observed hit rate through a
 * strip of half-width `halfWidth`, allowing for a directional bias expressed
 * in sigma.
 *
 * Bisection rather than an inverse CDF because the biased case has no closed
 * form, and because a monotone search is easy to reason about when the answer
 * is an inference rather than a measurement.
 */
function sigmaFromStripHitRate(hitRate: number, halfWidth: number, biasSigma: number): number {
  const p = Math.min(0.95, Math.max(0.05, hitRate));
  const rate = (sigma: number) => {
    const b = biasSigma * sigma;
    return normalCdf((halfWidth - b) / sigma) - normalCdf((-halfWidth - b) / sigma);
  };
  let lo = 0.5;
  let hi = 200;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    // Hit rate falls as sigma grows, so search accordingly.
    if (rate(mid) > p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Sigma from a greens-in-regulation rate, treating the green as a circular
 * target and the miss as radially symmetric.
 *
 * GIR is a 2D condition -- it needs both line and distance -- so a purely
 * lateral inversion would blame direction for distance errors and overstate
 * the spread. The Rayleigh form at least splits the blame evenly.
 *
 * It still conflates a great deal: GIR also depends on how often you are in
 * the fairway and how long the approach is. Treat the output as a starting
 * point that logged shots should overwrite quickly.
 */
function sigmaFromGirRate(hitRate: number): number {
  const p = Math.min(0.9, Math.max(0.03, hitRate));
  return ASSUMPTIONS.GREEN_RADIUS / Math.sqrt(-2 * Math.log(1 - p));
}

export interface DerivedBag {
  clubs: ClubParams[];
  /** Human-readable account of how each number was reached. */
  notes: string[];
}

/**
 * Turn questionnaire answers into a bag.
 *
 * Two anchors are inferred -- the driver from the fairway rate, a mid-iron
 * from the GIR rate -- and everything between is interpolated on carry. That
 * is spec 4.2's family pooling in its crudest useful form: neighbouring clubs
 * share a shape because there is no evidence they differ.
 */
export function deriveBag(q: Questionnaire): DerivedBag {
  const notes: string[] = [];
  const biasSigma =
    q.miss === 'two-way' ? 0 : ASSUMPTIONS.ONE_WAY_BIAS_SIGMA * (q.miss === 'left' ? -1 : 1);

  const driverCarryStated = q.carries.driver ?? 245;

  // Longitudinal spread, from the flush-versus-thin gap.
  const sigmaLongYards = q.flushThinGapYards / ASSUMPTIONS.GAP_SIGMA_SPAN;
  const midIronCarry = q.carries['6i'] ?? 165;
  const carrySigmaPct = Math.min(0.12, Math.max(0.02, sigmaLongYards / midIronCarry));
  notes.push(
    `Longitudinal σ ≈ ${sigmaLongYards.toFixed(1)}y from a ${q.flushThinGapYards}y flush-to-thin gap ` +
      `(assumed to span the 10th–90th percentile), i.e. ${(carrySigmaPct * 100).toFixed(1)}% of carry.`,
  );

  // Driver lateral spread, from fairways hit.
  const driverLateralYards = sigmaFromStripHitRate(
    q.fairwaysHit / 14,
    ASSUMPTIONS.FAIRWAY_HALF_WIDTH,
    biasSigma,
  );
  const driverAnglePct = driverLateralYards / driverCarryStated;
  notes.push(
    `Driver lateral σ ≈ ${driverLateralYards.toFixed(1)}y from ${q.fairwaysHit}/14 fairways ` +
      `through an assumed ${ASSUMPTIONS.FAIRWAY_HALF_WIDTH}y half-width, i.e. ` +
      `${(driverAnglePct * 100).toFixed(1)}% of carry. Fairway misses caused by distance rather ` +
      `than direction are blamed on direction here, so this errs wide.`,
  );

  // Mid-iron lateral spread, from GIR.
  const ironLateralYards = sigmaFromGirRate(q.greensInRegulation / 18);
  const ironAnglePct = ironLateralYards / ASSUMPTIONS.GIR_REFERENCE_DISTANCE;
  notes.push(
    `Iron lateral σ ≈ ${ironLateralYards.toFixed(1)}y at ${ASSUMPTIONS.GIR_REFERENCE_DISTANCE}y ` +
      `from ${q.greensInRegulation}/18 greens, i.e. ${(ironAnglePct * 100).toFixed(1)}% of carry.`,
  );

  // Mishit weight, from penalties. Spec section 5 item 2 -- otherwise unrecoverable.
  const mishitWeight = Math.min(
    0.35,
    Math.max(
      0.02,
      q.penaltiesPerRound /
        (ASSUMPTIONS.FULL_SHOTS_PER_ROUND * ASSUMPTIONS.PENALTY_GIVEN_MISHIT),
    ),
  );
  notes.push(
    `Mishit weight ${(mishitWeight * 100).toFixed(1)}% from ${q.penaltiesPerRound} penalty strokes ` +
      `per round, assuming ${ASSUMPTIONS.FULL_SHOTS_PER_ROUND} full swings and that ` +
      `${(ASSUMPTIONS.PENALTY_GIVEN_MISHIT * 100).toFixed(0)}% of mishits end up penalised.`,
  );

  const ids = ['driver', '3w', '5w', '4i', '6i'];
  const names: Record<string, string> = {
    driver: 'Driver',
    '3w': '3-wood',
    '5w': '5-wood',
    '4i': '4-iron',
    '6i': '6-iron',
  };
  const rolls: Record<string, number> = { driver: 22, '3w': 16, '5w': 13, '4i': 10, '6i': 7 };

  const clubs: ClubParams[] = ids.map((id) => {
    const stated = q.carries[id] ?? DEFAULT_QUESTIONNAIRE.carries[id];
    // Interpolate the lateral percentage between the two anchors on carry.
    const t = Math.min(
      1,
      Math.max(0, (stated - midIronCarry) / Math.max(1, driverCarryStated - midIronCarry)),
    );
    const lateralSigmaPct = ironAnglePct + (driverAnglePct - ironAnglePct) * t;

    // Stated carry is the 75th percentile, so the mean sits below it. Applied
    // silently -- spec section 5: don't argue with the user about their 7-iron.
    const meanCarry = stated - ASSUMPTIONS.STATED_CARRY_Z * carrySigmaPct * stated;

    const lateralBiasPct = biasSigma * lateralSigmaPct;
    return {
      id,
      name: names[id],
      meanCarry: Math.round(meanCarry),
      carrySigmaPct,
      lateralSigmaPct,
      lateralBiasPct,
      mishitWeight,
      mishitSigmaMult: ASSUMPTIONS.MISHIT_SIGMA_MULT,
      mishitLateralBiasPct: lateralBiasPct * ASSUMPTIONS.MISHIT_BIAS_MULT,
      mishitCarryMult: ASSUMPTIONS.MISHIT_CARRY_MULT,
      rollFairway: rolls[id],
      inBag: true,
    };
  });

  notes.push(
    `Stated carries reduced by ${ASSUMPTIONS.STATED_CARRY_Z}σ to convert a 75th-percentile ` +
      `figure into a mean — e.g. a stated ${driverCarryStated}y driver becomes ` +
      `${clubs[0].meanCarry}y.`,
  );
  notes.push(
    'Mishit spread multiplier, mishit carry loss and mishit bias are not recoverable from any ' +
      'question here and remain assumed defaults until shots are logged.',
  );

  return { clubs, notes };
}
