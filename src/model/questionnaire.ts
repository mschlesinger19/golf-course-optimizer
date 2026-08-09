import type { ClubFamily, ClubParams } from './types';

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
 * makes this materially better than an invented bag, and it is why it sidesteps
 * spec 12 open #3 -- no published handicap-band prior is needed if the player
 * reports their own fairway rate.
 *
 * The *mapping* from answers to parameters is mine. Every constant below is a
 * modelling assumption, not a citation. They are gathered here, named, and
 * exported so they can be argued with, overridden, or replaced wholesale when
 * real calibration data exists. None of them is a number I found; they are
 * numbers I chose, and the inferences are only as good as they are.
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

/** Roll-out on fairway by family, yards. Steeper clubs stop faster. */
export const FAMILY_ROLL: Record<ClubFamily, number> = {
  driver: 22,
  wood: 16,
  hybrid: 12,
  long_iron: 10,
  mid_iron: 8,
  short_iron: 5,
  wedge: 3,
  putter: 0,
};

export const FAMILY_LABEL: Record<ClubFamily, string> = {
  driver: 'Driver',
  wood: 'Wood',
  hybrid: 'Hybrid',
  long_iron: 'Long iron',
  mid_iron: 'Mid iron',
  short_iron: 'Short iron',
  wedge: 'Wedge',
  putter: 'Putter',
};

export type MissShape = 'left' | 'right' | 'two-way';

/**
 * A club as the player describes it. The bag is user-defined: nobody carries
 * the same fourteen, and a hardcoded set silently prices shots with a club that
 * is not in the bag.
 */
export interface BagClub {
  id: string;
  name: string;
  family: ClubFamily;
  /** Stated carry, treated as the 75th percentile rather than the mean. */
  carry: number;
  inBag: boolean;
}

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
  /** Item 5: the player's actual clubs and their stated carries. */
  clubs: BagClub[];
}

/** A common full set, offered as a starting point and entirely editable. */
export const DEFAULT_CLUBS: BagClub[] = [
  { id: 'driver', name: 'Driver', family: 'driver', carry: 245, inBag: true },
  { id: '3w', name: '3-wood', family: 'wood', carry: 220, inBag: true },
  { id: '4h', name: '4-hybrid', family: 'hybrid', carry: 200, inBag: true },
  { id: '5i', name: '5-iron', family: 'long_iron', carry: 185, inBag: true },
  { id: '6i', name: '6-iron', family: 'mid_iron', carry: 172, inBag: true },
  { id: '7i', name: '7-iron', family: 'mid_iron', carry: 160, inBag: true },
  { id: '8i', name: '8-iron', family: 'short_iron', carry: 147, inBag: true },
  { id: '9i', name: '9-iron', family: 'short_iron', carry: 134, inBag: true },
  { id: 'pw', name: 'Pitching wedge', family: 'wedge', carry: 120, inBag: true },
  { id: 'gw', name: 'Gap wedge', family: 'wedge', carry: 105, inBag: true },
  { id: 'sw', name: 'Sand wedge', family: 'wedge', carry: 90, inBag: true },
];

export const DEFAULT_QUESTIONNAIRE: Questionnaire = {
  fairwaysHit: 6,
  penaltiesPerRound: 1.5,
  greensInRegulation: 5,
  miss: 'two-way',
  flushThinGapYards: 20,
  clubs: DEFAULT_CLUBS,
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
 * in sigma. Bisection, because the biased case has no closed form.
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
    if (rate(mid) > p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Sigma from a greens-in-regulation rate, treating the green as a circular
 * target and the miss as radially symmetric. GIR needs both line and distance,
 * so a purely lateral inversion would blame direction for distance errors; the
 * Rayleigh form at least splits the blame. It still conflates fairway rate and
 * approach length, so logged shots should overwrite it quickly.
 */
function sigmaFromGirRate(hitRate: number): number {
  const p = Math.min(0.9, Math.max(0.03, hitRate));
  return ASSUMPTIONS.GREEN_RADIUS / Math.sqrt(-2 * Math.log(1 - p));
}

export interface DerivedBag {
  clubs: ClubParams[];
  notes: string[];
}

/**
 * Turn questionnaire answers into a bag.
 *
 * Two anchors are inferred -- the longest club from the fairway rate, and
 * whichever club is nearest the GIR reference distance from the greens rate --
 * and everything between is interpolated on carry. That is spec 4.2's family
 * pooling in its crudest useful form: neighbouring clubs share a shape because
 * there is no evidence they differ.
 */
export function deriveBag(q: Questionnaire): DerivedBag {
  const notes: string[] = [];
  const inBag = q.clubs.filter((c) => c.inBag && c.carry > 0);
  if (inBag.length === 0) {
    return { clubs: [], notes: ['No clubs in the bag — add at least one on the Bag page.'] };
  }

  const biasSigma =
    q.miss === 'two-way' ? 0 : ASSUMPTIONS.ONE_WAY_BIAS_SIGMA * (q.miss === 'left' ? -1 : 1);

  const longest = inBag.reduce((a, b) => (b.carry > a.carry ? b : a));
  // The club that best represents the GIR answer is the one nearest the
  // reference approach distance, not an arbitrary named iron.
  const ironAnchor = inBag.reduce((a, b) =>
    Math.abs(b.carry - ASSUMPTIONS.GIR_REFERENCE_DISTANCE) <
    Math.abs(a.carry - ASSUMPTIONS.GIR_REFERENCE_DISTANCE)
      ? b
      : a,
  );

  const sigmaLongYards = q.flushThinGapYards / ASSUMPTIONS.GAP_SIGMA_SPAN;
  const carrySigmaPct = Math.min(0.12, Math.max(0.02, sigmaLongYards / ironAnchor.carry));
  notes.push(
    `Longitudinal σ ≈ ${sigmaLongYards.toFixed(1)}y from a ${q.flushThinGapYards}y flush-to-thin gap ` +
      `(assumed to span the 10th–90th percentile), i.e. ${(carrySigmaPct * 100).toFixed(1)}% of carry.`,
  );

  const longLateralYards = sigmaFromStripHitRate(
    q.fairwaysHit / 14,
    ASSUMPTIONS.FAIRWAY_HALF_WIDTH,
    biasSigma,
  );
  const longAnglePct = longLateralYards / longest.carry;
  notes.push(
    `${longest.name} lateral σ ≈ ${longLateralYards.toFixed(1)}y from ${q.fairwaysHit}/14 fairways ` +
      `through an assumed ${ASSUMPTIONS.FAIRWAY_HALF_WIDTH}y half-width, i.e. ` +
      `${(longAnglePct * 100).toFixed(1)}% of carry. Fairway misses caused by distance rather than ` +
      `direction are blamed on direction here, so this errs wide.`,
  );

  const ironLateralYards = sigmaFromGirRate(q.greensInRegulation / 18);
  const ironAnglePct = ironLateralYards / ASSUMPTIONS.GIR_REFERENCE_DISTANCE;
  notes.push(
    `${ironAnchor.name} lateral σ ≈ ${ironLateralYards.toFixed(1)}y at ` +
      `${ASSUMPTIONS.GIR_REFERENCE_DISTANCE}y from ${q.greensInRegulation}/18 greens, i.e. ` +
      `${(ironAnglePct * 100).toFixed(1)}% of carry.`,
  );

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

  const span = Math.max(1, longest.carry - ironAnchor.carry);
  const clubs: ClubParams[] = inBag
    .slice()
    .sort((a, b) => b.carry - a.carry)
    .map((c) => {
      const t = Math.min(1, Math.max(0, (c.carry - ironAnchor.carry) / span));
      const lateralSigmaPct = ironAnglePct + (longAnglePct - ironAnglePct) * t;
      // Stated carry is the 75th percentile, so the mean sits below it. Applied
      // silently -- spec section 5: don't argue with the user about their 7-iron.
      const meanCarry = c.carry - ASSUMPTIONS.STATED_CARRY_Z * carrySigmaPct * c.carry;
      const lateralBiasPct = biasSigma * lateralSigmaPct;
      return {
        id: c.id,
        name: c.name,
        family: c.family,
        meanCarry: Math.round(meanCarry),
        carrySigmaPct,
        lateralSigmaPct,
        lateralBiasPct,
        mishitWeight,
        mishitSigmaMult: ASSUMPTIONS.MISHIT_SIGMA_MULT,
        mishitLateralBiasPct: lateralBiasPct * ASSUMPTIONS.MISHIT_BIAS_MULT,
        mishitCarryMult: ASSUMPTIONS.MISHIT_CARRY_MULT,
        rollFairway: FAMILY_ROLL[c.family],
        inBag: true,
      };
    });

  notes.push(
    `Stated carries reduced by ${ASSUMPTIONS.STATED_CARRY_Z}σ to convert a 75th-percentile figure ` +
      `into a mean — e.g. a stated ${longest.carry}y ${longest.name} becomes ${clubs[0].meanCarry}y.`,
  );
  notes.push(
    'Mishit spread multiplier, mishit carry loss and mishit bias are not recoverable from any ' +
      'question here and remain assumed defaults until shots are logged.',
  );

  return { clubs, notes };
}
