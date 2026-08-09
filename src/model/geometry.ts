import type { FeatureType, Hole, HoleFeature, Point } from './types';

export function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Unit vector from `from` toward `to`. Returns +y if the points coincide. */
export function direction(from: Point, to: Point): Point {
  const d = sub(to, from);
  const len = Math.hypot(d.x, d.y);
  if (len < 1e-9) return { x: 0, y: 1 };
  return { x: d.x / len, y: d.y / len };
}

/** Right-hand perpendicular: for dir = (0,1) this returns (1,0), i.e. right. */
export function rightPerp(dir: Point): Point {
  return { x: dir.y, y: -dir.x };
}

/** Signed angle in degrees from `a` to `b`, positive clockwise (i.e. to the right). */
export function angleBetweenDeg(a: Point, b: Point): number {
  const cross = a.x * b.y - a.y * b.x;
  const dot = a.x * b.x + a.y * b.y;
  return -Math.atan2(cross, dot) * (180 / Math.PI);
}

/** Rotate a unit vector clockwise (to the right) by `deg`. */
export function rotateDeg(v: Point, deg: number): Point {
  const r = -deg * (Math.PI / 180);
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/**
 * A polygon flattened into a typed array with a precomputed bounding box.
 * The optimizer runs a few million point-in-polygon tests per recompute, so
 * the bbox reject is what keeps this interactive.
 */
export interface CompiledPolygon {
  id: string;
  type: FeatureType;
  penaltyModifier: number;
  /** [x0, y0, x1, y1, ...] */
  coords: Float64Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function compilePolygon(feature: HoleFeature): CompiledPolygon {
  const n = feature.polygon.length;
  const coords = new Float64Array(n * 2);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = feature.polygon[i];
    coords[i * 2] = p.x;
    coords[i * 2 + 1] = p.y;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    id: feature.id,
    type: feature.type,
    penaltyModifier: feature.penaltyModifier ?? 0,
    coords,
    minX,
    minY,
    maxX,
    maxY,
  };
}

/** Ray-cast point-in-polygon against a compiled polygon, bbox-rejected first. */
export function containsPoint(poly: CompiledPolygon, x: number, y: number): boolean {
  if (x < poly.minX || x > poly.maxX || y < poly.minY || y > poly.maxY) return false;
  const c = poly.coords;
  const n = c.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = c[i * 2];
    const yi = c[i * 2 + 1];
    const xj = c[j * 2];
    const yj = c[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Order in which overlapping features win when resolving a lie. Hazards beat
 * the surfaces they sit on, so a bunker traced on top of a fairway polygon
 * resolves as bunker without anyone having to cut a hole in the fairway.
 */
const LIE_PRIORITY: FeatureType[] = [
  'ob',
  'water',
  'bunker',
  'trees',
  'green',
  'fairway',
  'tee',
];

export interface CompiledHole {
  hole: Hole;
  /** Sorted by LIE_PRIORITY, so the first hit wins. */
  polygons: CompiledPolygon[];
}

export function compileHole(hole: Hole): CompiledHole {
  const polygons = hole.features
    .map(compilePolygon)
    .sort((a, b) => LIE_PRIORITY.indexOf(a.type) - LIE_PRIORITY.indexOf(b.type));
  return { hole, polygons };
}

export interface LieResult {
  type: FeatureType;
  penaltyModifier: number;
}

const IMPLICIT_ROUGH: LieResult = { type: 'rough', penaltyModifier: 0 };

/** Resolve what the ball is sitting on. Anything untraced is rough (spec 3.1). */
export function resolveLie(compiled: CompiledHole, x: number, y: number): LieResult {
  for (const poly of compiled.polygons) {
    if (containsPoint(poly, x, y)) {
      return { type: poly.type, penaltyModifier: poly.penaltyModifier };
    }
  }
  return IMPLICIT_ROUGH;
}

/**
 * The point `distance` yards along a polyline from its start. Clamps to the
 * final vertex. Used to turn "straight down the middle at driver distance"
 * into an actual aim target.
 */
export function pointAlongPolyline(polyline: Point[], distance: number): Point {
  if (polyline.length === 0) return { x: 0, y: 0 };
  if (polyline.length === 1 || distance <= 0) return polyline[0];
  let remaining = distance;
  for (let i = 1; i < polyline.length; i++) {
    const segLen = dist(polyline[i - 1], polyline[i]);
    if (remaining <= segLen) {
      const t = segLen < 1e-9 ? 0 : remaining / segLen;
      return {
        x: polyline[i - 1].x + (polyline[i].x - polyline[i - 1].x) * t,
        y: polyline[i - 1].y + (polyline[i].y - polyline[i - 1].y) * t,
      };
    }
    remaining -= segLen;
  }
  return polyline[polyline.length - 1];
}

/**
 * Walk back along the flight line from a point in a penalty area until the
 * ball is out of it, then step back a little further to clear the margin.
 * This approximates a lateral relief drop; it is not the Rules of Golf, and
 * a real implementation would need the actual crossing point plus the
 * player's relief options.
 */
export function findDropPoint(
  compiled: CompiledHole,
  landing: Point,
  dir: Point,
  origin: Point,
): Point {
  const maxBack = dist(landing, origin);
  const step = 2;
  for (let back = step; back <= maxBack; back += step) {
    const x = landing.x - dir.x * back;
    const y = landing.y - dir.y * back;
    const lie = resolveLie(compiled, x, y);
    if (lie.type !== 'water' && lie.type !== 'ob') {
      // Two more yards of margin so the drop is not sitting on the line.
      return { x: x - dir.x * 2, y: y - dir.y * 2 };
    }
  }
  return { x: origin.x, y: origin.y };
}
