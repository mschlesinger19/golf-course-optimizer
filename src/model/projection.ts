import type { Point } from './types';

/**
 * Local tangent-plane projection, lat/lng <-> yards.
 *
 * Courses arrive as lat/lng from the tracer; the optimizer works in flat
 * yards. Over a single golf hole (under 1km) an equirectangular projection
 * about a local origin is accurate to a few centimetres, which is far below
 * the noise floor of everything else in this app. Nothing here should be
 * reused for anything course-sized without checking that claim again.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const YARDS_PER_DEGREE_LAT = 121740.4; // 111132.95 m/deg * 1.09361 yd/m

export interface Projector {
  origin: LatLng;
  toLocal(p: LatLng): Point;
  toLatLng(p: Point): LatLng;
}

export function makeProjector(origin: LatLng): Projector {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const yardsPerDegreeLng = YARDS_PER_DEGREE_LAT * cosLat;
  return {
    origin,
    toLocal(p: LatLng): Point {
      return {
        x: (p.lng - origin.lng) * yardsPerDegreeLng,
        y: (p.lat - origin.lat) * YARDS_PER_DEGREE_LAT,
      };
    },
    toLatLng(p: Point): LatLng {
      return {
        lat: origin.lat + p.y / YARDS_PER_DEGREE_LAT,
        lng: origin.lng + p.x / yardsPerDegreeLng,
      };
    },
  };
}

/** Great-circle-free distance in yards between two nearby points. */
export function distanceYards(a: LatLng, b: LatLng): number {
  const proj = makeProjector(a);
  const p = proj.toLocal(b);
  return Math.hypot(p.x, p.y);
}
