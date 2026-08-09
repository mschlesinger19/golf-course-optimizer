import { describe, expect, it } from 'vitest';
import { isPlayable, projectHole } from './course';
import { compileHole, resolveLie } from './geometry';
import { overpassQuery, parseOverpass, type OverpassResponse } from './osm';

/**
 * A miniature but structurally realistic Overpass response: two holes as
 * `golf=hole` centrelines, with a green, a fairway, a bunker and a pond around
 * them, plus a driving range far enough away to be dropped and a cart path that
 * should be ignored outright.
 *
 * Coordinates are a few hundred yards apart near 39N so the yardages come out
 * in a plausible range.
 */
const LAT = 39.0;
const LNG = -95.0;
/** Degrees per yard at this latitude, near enough for a fixture. */
const DY = 1 / 121740.4;
const DX = DY / Math.cos((LAT * Math.PI) / 180);

const at = (eastYd: number, northYd: number) => ({
  lat: LAT + northYd * DY,
  lon: LNG + eastYd * DX,
});

const ring = (cx: number, cy: number, r: number) => [
  at(cx - r, cy - r),
  at(cx + r, cy - r),
  at(cx + r, cy + r),
  at(cx - r, cy + r),
  at(cx - r, cy - r),
];

const FIXTURE: OverpassResponse = {
  elements: [
    {
      type: 'way',
      id: 1,
      tags: { golf: 'hole', ref: '1', par: '4' },
      geometry: [at(0, 0), at(0, 200), at(0, 400)],
    },
    {
      type: 'way',
      id: 2,
      tags: { golf: 'hole', ref: '2', par: '3' },
      geometry: [at(600, 0), at(600, 170)],
    },
    { type: 'way', id: 10, tags: { golf: 'green' }, geometry: ring(0, 395, 15) },
    { type: 'way', id: 11, tags: { golf: 'fairway' }, geometry: ring(0, 220, 30) },
    { type: 'way', id: 12, tags: { golf: 'bunker' }, geometry: ring(28, 250, 10) },
    { type: 'way', id: 13, tags: { golf: 'lateral_water_hazard' }, geometry: ring(-40, 300, 25) },
    { type: 'way', id: 14, tags: { golf: 'green' }, geometry: ring(600, 168, 14) },
    { type: 'way', id: 15, tags: { golf: 'tee' }, geometry: ring(600, 2, 6) },
    // Far from every centreline -- should be dropped.
    { type: 'way', id: 20, tags: { golf: 'driving_range' }, geometry: ring(0, 1400, 60) },
    // Not priceable; must be ignored rather than guessed at.
    { type: 'way', id: 21, tags: { golf: 'cartpath' }, geometry: ring(50, 100, 4) },
    { type: 'way', id: 22, tags: { highway: 'service' }, geometry: ring(70, 120, 4) },
  ],
};

describe('overpass query', () => {
  it('asks for golf ways and relations around a point, with inline geometry', () => {
    const q = overpassQuery(39.1234567, -95.7654321, 1200);
    expect(q).toContain('out geom;');
    expect(q).toContain('["golf"]');
    expect(q).toContain('around:1200,39.123457,-95.765432');
    expect(q).toContain('way(');
    expect(q).toContain('relation(');
  });
});

describe('parsing an Overpass response', () => {
  const result = parseOverpass(FIXTURE, 'Fixture Links');

  it('builds holes from golf=hole centrelines', () => {
    expect(result.course).not.toBeNull();
    const holes = result.course!.holes;
    expect(holes).toHaveLength(2);
    expect(holes.map((h) => h.number)).toEqual([1, 2]);
    expect(holes.map((h) => h.par)).toEqual([4, 3]);
  });

  it('takes the tee from the start of the centreline and the green from its end', () => {
    const h1 = result.course!.holes[0];
    expect(h1.tee!.lat).toBeCloseTo(LAT, 6);
    // 400 yards north of the tee.
    expect(h1.green!.lat).toBeCloseTo(LAT + 400 * DY, 5);
    expect(h1.centerline).toHaveLength(3);
  });

  it('assigns each polygon to the nearest hole', () => {
    const [h1, h2] = result.course!.holes;
    expect(h1.features.map((f) => f.type).sort()).toEqual(['bunker', 'fairway', 'green', 'water']);
    expect(h2.features.map((f) => f.type).sort()).toEqual(['green', 'tee']);
  });

  it('drops features far from every centreline and reports it', () => {
    expect(result.stats.unassigned).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/more than 200y/);
  });

  it('ignores tags it cannot price rather than guessing', () => {
    const all = result.course!.holes.flatMap((h) => h.features);
    expect(all.some((f) => f.id.includes('-21'))).toBe(false); // cartpath
    expect(all.some((f) => f.id.includes('-22'))).toBe(false); // highway
  });

  it('produces holes the optimizer can actually run on', () => {
    const h1 = result.course!.holes[0];
    expect(isPlayable(h1)).toBe(true);
    const compiled = compileHole(projectHole(h1)!.hole);
    // Probe the projected geometry at the places the fixture put things.
    expect(resolveLie(compiled, 0, 220).type).toBe('fairway');
    expect(resolveLie(compiled, 28, 250).type).toBe('bunker');
    expect(resolveLie(compiled, -40, 300).type).toBe('water');
    expect(resolveLie(compiled, 0, 395).type).toBe('green');
    expect(resolveLie(compiled, 150, 150).type).toBe('rough');
  });

  it('always warns that imported geometry is not surveyed', () => {
    expect(result.warnings.join(' ')).toMatch(/penalty modifiers/);
  });
});

describe('thin and empty coverage', () => {
  it('reports no holes rather than inventing a course', () => {
    const empty = parseOverpass({ elements: [] }, 'Nowhere GC');
    expect(empty.course).toBeNull();
    expect(empty.tooThin).toBe(true);
    expect(empty.warnings.join(' ')).toMatch(/not mapped in OpenStreetMap/);
  });

  it('flags a course that came back as an undifferentiated blob', () => {
    // Spec 9: coverage is bimodal, and under about two features per hole means
    // effectively unmapped.
    const thin = parseOverpass(
      {
        elements: [
          FIXTURE.elements[0],
          FIXTURE.elements[1],
          FIXTURE.elements[2], // one green between two holes
        ],
      },
      'Blob GC',
    );
    expect(thin.course).not.toBeNull();
    expect(thin.tooThin).toBe(true);
    expect(thin.stats.perHole).toBeLessThan(2);
    expect(thin.warnings.join(' ')).toMatch(/effectively unmapped/);
  });

  it('numbers a hole with no ref and says so', () => {
    const noRef = parseOverpass(
      { elements: [{ ...FIXTURE.elements[0], tags: { golf: 'hole' } }] },
      'Unlabelled GC',
    );
    expect(noRef.course!.holes[0].number).toBe(1);
    expect(noRef.warnings.join(' ')).toMatch(/no ref tag/);
  });
});

describe('par reporting', () => {
  it('warns only about the holes that actually lacked a par tag', () => {
    const both = parseOverpass(FIXTURE, 'Fixture Links');
    // Every fixture hole has a par, so there must be no par warning at all.
    expect(both.warnings.join(' ')).not.toMatch(/no par tag/);

    const oneMissing = parseOverpass(
      {
        elements: [
          FIXTURE.elements[0],
          { ...FIXTURE.elements[1], tags: { golf: 'hole', ref: '2' } },
          ...FIXTURE.elements.slice(2),
        ],
      },
      'Fixture Links',
    );
    expect(oneMissing.warnings.join(' ')).toMatch(/no par tag/);
    expect(oneMissing.course!.holes.find((h) => h.number === 2)!.par).toBe(4);
    expect(oneMissing.course!.holes.find((h) => h.number === 1)!.par).toBe(4);
  });
});
