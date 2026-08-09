/**
 * Core types for the aim optimizer.
 *
 * Coordinate system: local planar yards. Origin is the tee of the hole under
 * consideration, +y points down the initial hole axis, +x points right when
 * standing on the tee looking at the green. Real courses will arrive as
 * lat/lon polygons and get projected into this frame at round start; keeping
 * the optimizer in flat yards means it never has to think about geodesy.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * Feature types per spec 3.1. `rough` is implicit -- anything inside the hole
 * corridor that is not another feature resolves to rough, which is why it is
 * not usually traced as a polygon.
 */
export type FeatureType =
  | 'tee'
  | 'fairway'
  | 'green'
  | 'bunker'
  | 'water'
  | 'ob'
  | 'trees'
  | 'rough';

/**
 * Lies the expected-strokes model knows how to price. Narrower than
 * FeatureType: bunker maps to sand, trees maps to recovery, and water/ob are
 * never terminal lies (they resolve to a drop or a replay before pricing).
 */
export type Lie = 'tee' | 'fairway' | 'rough' | 'sand' | 'recovery' | 'green';

export interface HoleFeature {
  id: string;
  type: FeatureType;
  polygon: Point[];
  /**
   * Manual cost adjustment on top of the feature type, in strokes. Spec 3.1:
   * a flat fairway bunker and a lipped-out greenside bunker are both
   * `bunker` and differ by most of a stroke. This is where local knowledge
   * lands. Positive = harder than the type's default.
   */
  penaltyModifier?: number;
  label?: string;
}

export interface Hole {
  id: string;
  number: number;
  par: number;
  name: string;
  teePoint: Point;
  greenCenter: Point;
  /** Per-round pin. Falls back to greenCenter when not recorded. */
  pin: Point;
  /**
   * Playing centreline, tee to green. OSM supplies this directly as the
   * `golf=hole` way (spec 9), and the tracer should capture it too: on a
   * dogleg it is the only thing that defines what "straight down the middle"
   * means, and without it the only available comparison is "aimed at the pin,"
   * which on this hole means aimed into the trees.
   */
  centerline: Point[];
  features: HoleFeature[];
}

/**
 * A club's shot dispersion, as a 2D mixture in (longitudinal, lateral)
 * coordinates relative to the aim line. Spec 4.1.
 *
 * Sigmas are stored as a fraction of carry so that one club's data can inform
 * its neighbours once hierarchical pooling exists (spec 4.2). None of that
 * pooling is implemented here -- this slice takes the parameters directly
 * from the sliders.
 */
export interface ClubParams {
  id: string;
  name: string;
  /** Mean carry in yards for the normal (non-mishit) component. */
  meanCarry: number;
  /** Longitudinal sigma as a fraction of carry. */
  carrySigmaPct: number;
  /** Lateral sigma as a fraction of carry. */
  lateralSigmaPct: number;
  /** Signed lateral bias as a fraction of carry. Negative leaks left. */
  lateralBiasPct: number;
  /** Mixture weight of the mishit component, typically 0.05-0.15. */
  mishitWeight: number;
  /** Sigma multiplier on the mishit component, typically 2-3x. */
  mishitSigmaMult: number;
  /** Signed lateral bias of the mishit component, as a fraction of carry. */
  mishitLateralBiasPct: number;
  /**
   * Carry multiplier on the mishit component. Not in the spec's
   * club_posteriors, but mishits come up short as well as sideways, and
   * without this the model puts thin/heavy misses at full distance.
   */
  mishitCarryMult: number;
  /** Roll in yards after landing in fairway. Scaled down by lie on landing. */
  rollFairway: number;
  inBag: boolean;
}
