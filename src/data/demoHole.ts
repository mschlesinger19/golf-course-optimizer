import type { Hole, HoleFeature, Point } from '../model/types';

/*
 * =====================================================================
 *  INVENTED GEOMETRY -- these are not a real hole's coordinates
 * =====================================================================
 *
 * Built to the shape described in the brief: a dogleg with water where a
 * straight driver finishes, a bunker in the 3-wood zone, and a longer approach
 * from the lay-up. Every number below is made up. Replace them with the real
 * hole's measurements and the optimizer's answer becomes a claim about a shot
 * you are actually going to face.
 *
 * The format is deliberately the one the tracer will emit (spec section 9):
 * tagged polygons in a flat local frame, with an optional per-polygon penalty
 * modifier for local knowledge. Swapping traced geometry in later is a data
 * change, not a code change.
 */

/** Circle approximated as a polygon. Greens and bunkers are close enough to round. */
function circle(cx: number, cy: number, r: number, segments = 20, squash = 1): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r * squash });
  }
  return pts;
}

const features: HoleFeature[] = [
  {
    id: 'ob-left',
    type: 'ob',
    label: 'OB (property line)',
    polygon: [
      { x: -160, y: -20 },
      { x: -80, y: -20 },
      { x: -80, y: 420 },
      { x: -160, y: 420 },
    ],
  },
  {
    id: 'tee-box',
    type: 'tee',
    label: 'Tee',
    polygon: [
      { x: -6, y: -12 },
      { x: 6, y: -12 },
      { x: 6, y: 2 },
      { x: -6, y: 2 },
    ],
  },
  {
    // Corridor of half-width 26 around the centreline
    // (0,140) -> (0,262) -> (120,358), mitred at the dogleg.
    id: 'fairway',
    type: 'fairway',
    label: 'Fairway',
    polygon: [
      { x: -26, y: 140 },
      { x: -24.9, y: 274 },
      { x: 103.8, y: 378.3 },
      { x: 136.2, y: 337.7 },
      { x: 24.9, y: 250 },
      { x: 26, y: 140 },
    ],
  },
  {
    id: 'water',
    type: 'water',
    label: 'Pond',
    // Sits across the fairway at driver distance on the straight line. A
    // dead-straight drive of ~270 total finishes in it.
    polygon: circle(-8, 276, 36, 22, 0.83),
  },
  {
    id: 'bunker-layup',
    type: 'bunker',
    label: 'Fairway bunker',
    // In the lay-up zone, right of centre, so the 3-wood has to be worked left.
    polygon: circle(4, 232, 20, 16, 0.8),
    // Flat, no lip -- a mid-iron gets out and advances. Local knowledge that
    // satellite imagery cannot supply (spec 3.1).
    penaltyModifier: -0.1,
  },
  {
    // The right-hand treeline, running the whole length of the hole and
    // following the dogleg. Without a wall on this side the optimizer finds
    // the unbounded rough beyond the corridor and cheerfully recommends
    // aiming 150 yards right into an empty field -- correct arithmetic on
    // geometry that forgot to say where the hole ends.
    id: 'trees-right',
    type: 'trees',
    label: 'Trees (right)',
    polygon: [
      { x: 40, y: -30 },
      { x: 38, y: 248 },
      { x: 150, y: 336 },
      { x: 200, y: 445 },
      { x: 250, y: 445 },
      { x: 250, y: -30 },
    ],
    // Mature and tight -- a chip-out sideways, not a punch at the green.
    penaltyModifier: 0.25,
  },
  {
    id: 'trees-back',
    type: 'trees',
    label: 'Trees (behind green)',
    polygon: [
      { x: -80, y: 396 },
      { x: 205, y: 396 },
      { x: 205, y: 445 },
      { x: -80, y: 445 },
    ],
    penaltyModifier: 0.25,
  },
  {
    id: 'bunker-green-left',
    type: 'bunker',
    label: 'Greenside bunker',
    polygon: circle(100, 344, 11, 14),
    // Deep and revetted, short-sided from a back-right pin.
    penaltyModifier: 0.3,
  },
  {
    id: 'green',
    type: 'green',
    label: 'Green',
    polygon: circle(120, 358, 16, 24, 0.95),
  },
];

export const DEMO_HOLE: Hole = {
  id: 'demo-1',
  number: 1,
  par: 4,
  name: 'Demo — dogleg right, water at the straight-driver finish',
  teePoint: { x: 0, y: 0 },
  greenCenter: { x: 120, y: 358 },
  // Per-round pin, back-right. Falls back to greenCenter when not recorded.
  pin: { x: 128, y: 366 },
  centerline: [
    { x: 0, y: 0 },
    { x: 0, y: 150 },
    { x: 0, y: 262 },
    { x: 120, y: 358 },
  ],
  features,
};

/** Centreline yardage, which is what a scorecard would print. */
export const DEMO_HOLE_YARDAGE = 415;
