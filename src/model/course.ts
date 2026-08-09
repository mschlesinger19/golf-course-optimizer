import { makeProjector, type LatLng, type Projector } from './projection';
import type { FeatureType, Hole, HoleFeature } from './types';

/**
 * Courses as the tracer produces them: lat/lng polygons, no projection baked
 * in. Everything the optimizer touches is derived from this by projecting
 * about the hole's tee, so re-tracing or importing never invalidates cached
 * geometry in a frame that has drifted.
 */

export interface GeoFeature {
  id: string;
  type: FeatureType;
  ring: LatLng[];
  penaltyModifier?: number;
  label?: string;
}

export interface GeoHole {
  id: string;
  number: number;
  par: number;
  /** Scorecard yardage, if known. Display only -- never used in the model. */
  yardage?: number;
  tee?: LatLng;
  green?: LatLng;
  /** Per-round pin. Falls back to `green` when not recorded (spec 3.1). */
  pin?: LatLng;
  centerline: LatLng[];
  features: GeoFeature[];
}

export interface GeoCourse {
  id: string;
  name: string;
  /** Imagery vintage note -- spec 9 warns a stale flyover produces confidently wrong polygons. */
  imageryNote?: string;
  holes: GeoHole[];
  updatedAt: string;
}

export function emptyHole(number: number): GeoHole {
  return { id: `hole-${number}`, number, par: 4, centerline: [], features: [] };
}

export function emptyCourse(name: string, holeCount = 18): GeoCourse {
  return {
    id: `course-${Math.abs(hashString(name))}`,
    name,
    holes: Array.from({ length: holeCount }, (_, i) => emptyHole(i + 1)),
    updatedAt: '',
  };
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** Enough geometry to run the model: a tee, a green, and at least one polygon. */
export function isPlayable(hole: GeoHole): boolean {
  return Boolean(hole.tee && hole.green && hole.features.length > 0);
}

export interface ProjectedHole {
  hole: Hole;
  projector: Projector;
}

/**
 * Project a traced hole into the optimizer's flat-yard frame, with the tee as
 * origin. Returns null when the hole has not been traced far enough to model.
 */
export function projectHole(geo: GeoHole): ProjectedHole | null {
  if (!geo.tee || !geo.green) return null;
  const projector = makeProjector(geo.tee);
  const toLocal = projector.toLocal;

  const features: HoleFeature[] = geo.features.map((f) => ({
    id: f.id,
    type: f.type,
    polygon: f.ring.map(toLocal),
    penaltyModifier: f.penaltyModifier,
    label: f.label,
  }));

  const greenCenter = toLocal(geo.green);
  const centerline = geo.centerline.length > 1 ? geo.centerline.map(toLocal) : [];

  return {
    projector,
    hole: {
      id: geo.id,
      number: geo.number,
      par: geo.par,
      name: `Hole ${geo.number}`,
      teePoint: toLocal(geo.tee),
      greenCenter,
      pin: geo.pin ? toLocal(geo.pin) : greenCenter,
      // Without a traced centreline, fall back to the straight tee-green line
      // so "down the middle" still means something.
      centerline: centerline.length > 1 ? centerline : [toLocal(geo.tee), greenCenter],
      features,
    },
  };
}

/** Centreline yardage, which is what a scorecard would print. */
export function centerlineYardage(geo: GeoHole): number | null {
  if (!geo.tee || !geo.green) return null;
  const proj = makeProjector(geo.tee);
  const pts = [geo.tee, ...geo.centerline.slice(1, -1), geo.green].map(proj.toLocal);
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return Math.round(total);
}
