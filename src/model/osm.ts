import type { GeoCourse, GeoFeature, GeoHole } from './course';
import { distanceYards, type LatLng } from './projection';
import type { FeatureType } from './types';

/**
 * OpenStreetMap ingest, spec section 9's second path.
 *
 * The tracer remains primary: spec 9 found OSM coverage patchy and private
 * clubs systematically missing, so this is an optimisation that sometimes
 * saves work rather than a source to rely on. Everything imported lands in the
 * tracer as editable geometry, because OSM polygons carry no penalty modifiers
 * and are often coarse.
 *
 * Coverage is bimodal -- a course is either fully mapped or a single
 * undifferentiated blob -- so this reports what it found and says plainly when
 * the answer is "not enough, go trace it."
 */

export interface OverpassElement {
  type: 'way' | 'relation' | 'node';
  id: number;
  tags?: Record<string, string>;
  /** Present when the query used `out geom`. */
  geometry?: { lat: number; lon: number }[];
  lat?: number;
  lon?: number;
}

export interface OverpassResponse {
  elements: OverpassElement[];
}

/** Overpass QL for every golf feature near a point. `out geom` inlines coordinates. */
export function overpassQuery(lat: number, lng: number, radiusMetres = 1500): string {
  const around = `${Math.round(radiusMetres)},${lat.toFixed(6)},${lng.toFixed(6)}`;
  return `[out:json][timeout:40];
(
  way(around:${around})["golf"];
  relation(around:${around})["golf"];
);
out geom;`;
}

/** OSM `golf=*` values we can price. Anything else is ignored, not guessed at. */
const GOLF_TO_FEATURE: Record<string, FeatureType> = {
  green: 'green',
  fairway: 'fairway',
  bunker: 'bunker',
  tee: 'tee',
  rough: 'rough',
  water_hazard: 'water',
  lateral_water_hazard: 'water',
  driving_range: 'rough',
};

const IGNORED_GOLF = new Set([
  'hole',
  'path',
  'cartpath',
  'clubhouse',
  'pin',
  'practice',
  'ground_under_repair',
]);

function centroid(ring: LatLng[]): LatLng {
  let lat = 0;
  let lng = 0;
  for (const p of ring) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / ring.length, lng: lng / ring.length };
}

/** Shortest distance in yards from a point to a polyline. */
function distanceToPolyline(p: LatLng, line: LatLng[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return distanceYards(p, line[0]);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const bb = line[i];
    // Work in yards about `a` so the projection is planar and cheap.
    const ab = { x: (bb.lng - a.lng), y: (bb.lat - a.lat) };
    const ap = { x: (p.lng - a.lng), y: (p.lat - a.lat) };
    const len2 = ab.x * ab.x + ab.y * ab.y;
    const t = len2 < 1e-18 ? 0 : Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y) / len2));
    const proj = { lat: a.lat + ab.y * t, lng: a.lng + ab.x * t };
    const d = distanceYards(p, proj);
    if (d < best) best = d;
  }
  return best;
}

export interface ImportResult {
  course: GeoCourse | null;
  /** Everything the caller should say out loud rather than silently swallow. */
  warnings: string[];
  stats: { holes: number; polygons: number; unassigned: number; perHole: number };
  /** True when coverage is too thin to model and the tracer is the right answer. */
  tooThin: boolean;
}

/**
 * Turn an Overpass response into a course.
 *
 * `golf=hole` ways are the skeleton: each carries the hole number in `ref` and
 * usually `par`, and its geometry is the playing centreline, so its first point
 * is the tee and its last is the green. Every polygon is then assigned to the
 * nearest centreline, because OSM polygons rarely say which hole they belong to.
 */
export function parseOverpass(res: OverpassResponse, courseName: string): ImportResult {
  const warnings: string[] = [];
  const elements = res.elements ?? [];

  const holeWays = elements.filter(
    (e) => e.tags?.golf === 'hole' && (e.geometry?.length ?? 0) >= 2,
  );

  const holes: GeoHole[] = holeWays
    .map((w) => {
      const line: LatLng[] = w.geometry!.map((g) => ({ lat: g.lat, lng: g.lon }));
      const refRaw = w.tags?.ref ?? w.tags?.name ?? '';
      const number = Number.parseInt(refRaw.replace(/\D+/g, ''), 10);
      const par = Number.parseInt(w.tags?.par ?? '', 10);
      return {
        id: `osm-hole-${w.id}`,
        number: Number.isFinite(number) && number > 0 ? number : 0,
        par: Number.isFinite(par) && par >= 3 && par <= 6 ? par : 4,
        tee: line[0],
        green: line[line.length - 1],
        centerline: line,
        features: [] as GeoFeature[],
      };
    })
    .sort((a, b) => a.number - b.number);

  // Number anything OSM left unlabelled, in the order it came back.
  let next = 1;
  for (const h of holes) {
    if (h.number === 0) {
      while (holes.some((o) => o.number === next)) next++;
      h.number = next;
      warnings.push(`A hole had no ref tag; numbered it ${next} — check it against the card.`);
    }
    h.id = `hole-${h.number}`;
  }
  holes.sort((a, b) => a.number - b.number);

  if (holes.length === 0) {
    return {
      course: null,
      warnings: [
        'No golf=hole ways found here. Either the course is not mapped in OpenStreetMap, or the ' +
          'search point was too far from it. Spec §9 expects this on private clubs — trace it instead.',
      ],
      stats: { holes: 0, polygons: 0, unassigned: 0, perHole: 0 },
      tooThin: true,
    };
  }

  let polygons = 0;
  let unassigned = 0;
  // Count the ways that carried no usable par, rather than asking whether *any*
  // way had one -- which would report either none or all of them.
  const missingPar = holeWays.filter((w) => {
    const par = Number.parseInt(w.tags?.par ?? '', 10);
    return !(Number.isFinite(par) && par >= 3 && par <= 6);
  }).length;

  for (const el of elements) {
    const golf = el.tags?.golf;
    if (!golf || IGNORED_GOLF.has(golf)) continue;
    const type = GOLF_TO_FEATURE[golf];
    if (!type) continue;
    const ring: LatLng[] = (el.geometry ?? []).map((g) => ({ lat: g.lat, lng: g.lon }));
    if (ring.length < 3) continue;

    const c = centroid(ring);
    let bestHole = holes[0];
    let bestDistance = Infinity;
    for (const h of holes) {
      const d = distanceToPolyline(c, h.centerline);
      if (d < bestDistance) {
        bestDistance = d;
        bestHole = h;
      }
    }
    // A feature 200 yards from every centreline belongs to the practice ground,
    // a neighbouring hole that was not mapped, or nothing at all.
    if (bestDistance > 200) {
      unassigned++;
      continue;
    }
    bestHole.features.push({
      id: `osm-${el.type}-${el.id}`,
      type,
      ring,
      label: golf.replace(/_/g, ' '),
    });
    polygons++;
  }

  const perHole = polygons / holes.length;
  // Spec §9: fewer than about two features per hole means the course came back
  // as an undifferentiated blob and should be routed to the tracer.
  const tooThin = perHole < 2;
  if (tooThin) {
    warnings.push(
      `Only ${perHole.toFixed(1)} mapped features per hole. Spec §9 treats that as effectively ` +
        `unmapped — the geometry is here to edit, but expect to trace most of it.`,
    );
  }
  if (unassigned > 0) {
    warnings.push(
      `${unassigned} polygon${unassigned === 1 ? '' : 's'} sat more than 200y from every hole ` +
        `centreline and ${unassigned === 1 ? 'was' : 'were'} dropped — usually the practice ground.`,
    );
  }
  if (missingPar > 0) {
    warnings.push('Some holes had no par tag and defaulted to 4. Check them against the card.');
  }
  warnings.push(
    'Imported geometry has no penalty modifiers and OSM polygons are often coarse. Spec §9 ' +
      'expects you to edit it in the tracer rather than trust it as surveyed.',
  );

  return {
    course: {
      id: `course-osm-${courseName.toLowerCase().replace(/\W+/g, '-')}`,
      name: courseName,
      imageryNote: 'Imported from OpenStreetMap — not surveyed, and not checked against imagery.',
      updatedAt: '',
      holes,
    },
    warnings,
    stats: { holes: holes.length, polygons, unassigned, perHole },
    tooThin,
  };
}
