import { overpassQuery, parseOverpass, type ImportResult, type OverpassResponse } from '../model/osm';

/**
 * Network access to OpenStreetMap, from the browser.
 *
 * Deliberately thin and deliberately loud. Everything here can fail for
 * mundane reasons -- a rate limit, an offline phone, a mirror having a bad day
 * -- and a silent failure on the first tee is worse than an ugly error string,
 * so failures surface verbatim rather than being folded into "something went
 * wrong".
 */

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

export interface PlaceHit {
  name: string;
  detail: string;
  lat: number;
  lng: number;
}

/** Look up a course by name. Nominatim asks callers to be identifiable and gentle. */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceHit[]> {
  const url =
    `${NOMINATIM}?format=jsonv2&limit=6&q=${encodeURIComponent(query)}` +
    `&extratags=1&namedetails=1`;
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // "Failed to fetch" on its own tells you nothing you can act on.
    throw new Error(
      `Could not reach OpenStreetMap's search (${(err as Error).message}). ` +
        `No signal, or the browser blocked the request. If you are standing on the course, ` +
        `use "I'm at the course" instead — or trace the hole, which needs no network at all.`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `OpenStreetMap search returned ${res.status} ${res.statusText}. ` +
        `Nominatim rate-limits hard; wait a moment and try again.`,
    );
  }
  const json = (await res.json()) as {
    display_name: string;
    name?: string;
    lat: string;
    lon: string;
  }[];
  return json.map((h) => ({
    name: h.name || h.display_name.split(',')[0],
    detail: h.display_name,
    lat: Number(h.lat),
    lng: Number(h.lon),
  }));
}

/**
 * Fetch golf geometry around a point, trying each mirror in turn.
 *
 * Overpass mirrors rate-limit independently, so a 429 from one is not a reason
 * to give up; a parse failure is.
 */
export async function fetchGolfCourse(
  lat: number,
  lng: number,
  courseName: string,
  radiusMetres = 1500,
  signal?: AbortSignal,
): Promise<ImportResult> {
  const body = overpassQuery(lat, lng, radiusMetres);
  const failures: string[] = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(body)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) {
        failures.push(`${new URL(endpoint).host}: ${res.status} ${res.statusText}`);
        continue;
      }
      const json = (await res.json()) as OverpassResponse;
      const result = parseOverpass(json, courseName);
      if (failures.length > 0) {
        result.warnings.unshift(`Fell back to ${new URL(endpoint).host} after: ${failures.join('; ')}`);
      }
      return result;
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      failures.push(`${new URL(endpoint).host}: ${(err as Error).message}`);
    }
  }

  throw new Error(
    `Every Overpass mirror failed. ${failures.join('; ')}. ` +
      `If you are on course data with no signal this will not work — trace the hole instead.`,
  );
}
