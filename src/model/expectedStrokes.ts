import type { Lie } from './types';

/*
 * =====================================================================
 *  PROVISIONAL BASELINE -- NOT A CITED SOURCE
 * =====================================================================
 *
 * Spec section 12, open decision #4, flags the expected-strokes table as one of
 * the two places "a coding agent will happily invent plausible numbers rather
 * than flag the gap, and the app will still run and still produce confident
 * output built on fabricated baselines."
 *
 * That is exactly what these numbers are. They are hand-constructed to the
 * right *shape* -- flat from 40 to 120 yards, rising thereafter, with lie
 * offsets that behave sensibly -- and they are in the neighbourhood of the
 * published PGA Tour benchmarks, but they are NOT transcribed from Broadie's
 * tables and no value here should be treated as sourced.
 *
 * What they are good for: exercising the optimizer and answering the question
 * this build exists to answer -- does the recommended aim point differ from
 * the obvious one, and how hard does it move when the inputs move? The
 * *ranking* of aim points is driven far more by hazard costs and dispersion
 * than by the second decimal place of the fairway curve.
 *
 * What they are NOT good for: reporting strokes gained, or any claim about
 * absolute stroke counts.
 *
 * TO REPLACE: overwrite the anchor arrays below with the real tables from
 * Broadie, *Every Shot Counts*. The interpolation and the calling code do not
 * change. Then delete PROVISIONAL_BASELINE and the banner it drives.
 */
export const PROVISIONAL_BASELINE = true;

/**
 * Anchor points: [distance in yards, expected strokes to hole out].
 *
 * Each lie gets its own table rather than a shared curve plus a scalar offset.
 * The spec (section 7) describes the lie penalty as "an offset that shrinks
 * with distance," but the published data does not clearly behave that way --
 * the rough-vs-fairway gap is roughly flat or mildly widening from 100 to 200
 * yards, and only the very short range shows the shrinking pattern. Per-lie
 * tables sidestep the question: whatever shape the real numbers have, they
 * drop straight in.
 */
type Anchors = ReadonlyArray<readonly [number, number]>;

const FAIRWAY: Anchors = [
  [20, 2.4],
  [40, 2.6],
  [60, 2.7],
  [80, 2.75],
  [100, 2.8],
  [120, 2.85],
  [140, 2.91],
  [160, 2.99],
  [180, 3.08],
  [200, 3.19],
  [220, 3.32],
  [240, 3.45],
  [260, 3.58],
  [280, 3.71],
  [300, 3.84],
];

const ROUGH: Anchors = [
  [20, 2.59],
  [40, 2.78],
  [60, 2.91],
  [80, 2.98],
  [100, 3.03],
  [120, 3.09],
  [140, 3.17],
  [160, 3.25],
  [180, 3.36],
  [200, 3.48],
  [220, 3.61],
  [240, 3.74],
  [260, 3.88],
  [280, 4.02],
  [300, 4.16],
];

const SAND: Anchors = [
  [20, 2.53],
  [40, 2.82],
  [60, 2.98],
  [80, 3.05],
  [100, 3.1],
  [120, 3.17],
  [140, 3.25],
  [160, 3.35],
  [180, 3.47],
  [200, 3.6],
  [220, 3.74],
  [240, 3.89],
  [260, 4.04],
  [280, 4.19],
  [300, 4.34],
];

/** Trees / no shot at the green. Dominated by the cost of getting back in play. */
const RECOVERY: Anchors = [
  [20, 3.0],
  [40, 3.2],
  [60, 3.35],
  [80, 3.45],
  [100, 3.55],
  [120, 3.64],
  [140, 3.73],
  [160, 3.82],
  [180, 3.92],
  [200, 4.03],
  [220, 4.15],
  [240, 4.28],
  [260, 4.41],
  [280, 4.54],
  [300, 4.67],
];

/** Teeing ground: marginally better than the fairway at the same distance. */
const TEE: Anchors = [
  [100, 2.72],
  [150, 2.88],
  [200, 3.1],
  [250, 3.4],
  [300, 3.72],
  [350, 3.9],
  [400, 4.03],
  [450, 4.2],
  [500, 4.45],
  [550, 4.75],
  [600, 5.1],
];

/** On the green, indexed by FEET, not yards. */
const GREEN_FEET: Anchors = [
  [1, 1.001],
  [2, 1.01],
  [3, 1.04],
  [4, 1.13],
  [5, 1.23],
  [6, 1.34],
  [7, 1.42],
  [8, 1.5],
  [9, 1.56],
  [10, 1.61],
  [15, 1.78],
  [20, 1.87],
  [25, 1.93],
  [30, 1.98],
  [40, 2.06],
  [50, 2.14],
  [60, 2.21],
  [90, 2.4],
];

const TABLES: Record<Exclude<Lie, 'green'>, Anchors> = {
  fairway: FAIRWAY,
  rough: ROUGH,
  sand: SAND,
  recovery: RECOVERY,
  tee: TEE,
};

/** Linear interpolation across anchors, clamped at both ends. */
function interpolate(anchors: Anchors, x: number): number {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (x <= first[0]) return first[1];
  if (x >= last[0]) {
    // Extrapolate along the final segment rather than flattening, so a
    // 340-yard tee shot does not price the same as a 300-yard one.
    const prev = anchors[anchors.length - 2];
    const slope = (last[1] - prev[1]) / (last[0] - prev[0]);
    return last[1] + slope * (x - last[0]);
  }
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i];
    if (x <= x1) {
      const [x0, y0] = anchors[i - 1];
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return last[1];
}

/**
 * Skill scaling. The published baselines are Tour, and spec section 7 is
 * emphatic that the optimizer's cost function has to be the *player's* own
 * recovery ability, not the field's -- "the optimal aim point depends on your
 * own recovery ability, not the Tour's."
 *
 * Until enough personal shot history exists to fit a real curve, this is a
 * single knob: strokes above 1 are scaled by `skillFactor`. It is crude, and
 * it is PROVISIONAL for the same reason everything else in this file is, but
 * it has the property that matters -- a worse player pays proportionally more
 * for a bad lie, which is what shifts the aim point away from the hazard.
 */
export interface CostConfig {
  skillFactor: number;
}

export const DEFAULT_COST_CONFIG: CostConfig = { skillFactor: 1.15 };

/**
 * Expected strokes to hole out from `distanceYards` on `lie`.
 *
 * `penaltyModifier` is the per-polygon local-knowledge adjustment from spec
 * 3.1, applied after skill scaling because it describes the feature, not the
 * player.
 */
export function expectedStrokes(
  distanceYards: number,
  lie: Lie,
  config: CostConfig = DEFAULT_COST_CONFIG,
  penaltyModifier = 0,
): number {
  let base: number;
  if (lie === 'green') {
    base = interpolate(GREEN_FEET, Math.max(0, distanceYards) * 3);
  } else {
    base = interpolate(TABLES[lie], Math.max(0, distanceYards));
  }
  return 1 + (base - 1) * config.skillFactor + penaltyModifier;
}
