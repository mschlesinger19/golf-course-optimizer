import { describe, expect, it } from 'vitest';
import { DEFAULT_BAG } from '../data/clubs';
import { buildDemoCourse } from '../data/demoCourse';
import { DEMO_HOLE } from '../data/demoHole';
import { centerlineYardage, isPlayable, projectHole } from './course';
import { makeNoiseBank } from './dispersion';
import { DEFAULT_COST_CONFIG } from './expectedStrokes';
import { compileHole, resolveLie } from './geometry';
import { distanceYards, makeProjector } from './projection';
import { evaluateTarget, suggestClub } from './optimizer';

describe('projection', () => {
  const origin = { lat: 38.9, lng: -95.6 };
  const proj = makeProjector(origin);

  it('round-trips local yards through lat/lng', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 120, y: 358 },
      { x: -85, y: 240 },
      { x: 250, y: -30 },
    ]) {
      const back = proj.toLocal(proj.toLatLng(p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('measures a known north-south offset', () => {
    // 100 yards north should read as 100 yards.
    const north = proj.toLatLng({ x: 0, y: 100 });
    expect(distanceYards(origin, north)).toBeCloseTo(100, 3);
  });

  it('keeps longitude scaling latitude-dependent', () => {
    const equator = makeProjector({ lat: 0, lng: 0 });
    const high = makeProjector({ lat: 60, lng: 0 });
    // One degree of longitude is about half as wide at 60 degrees latitude.
    const atEquator = equator.toLocal({ lat: 0, lng: 1 }).x;
    const atHigh = high.toLocal({ lat: 60, lng: 1 }).x;
    expect(atHigh / atEquator).toBeCloseTo(0.5, 2);
  });
});

describe('demo course', () => {
  const course = buildDemoCourse();
  const hole = course.holes[0];

  it('is playable and projects back to the original geometry', () => {
    expect(isPlayable(hole)).toBe(true);
    const projected = projectHole(hole);
    expect(projected).not.toBeNull();
    const compiled = compileHole(projected!.hole);

    // The same probe points from the flat-frame tests must still resolve the
    // same way after a trip through lat/lng.
    expect(resolveLie(compiled, 0, 200).type).toBe('fairway');
    expect(resolveLie(compiled, 0, 270).type).toBe('water');
    expect(resolveLie(compiled, 4, 232).type).toBe('bunker');
    expect(resolveLie(compiled, 120, 358).type).toBe('green');
    expect(resolveLie(compiled, -120, 200).type).toBe('ob');
  });

  it('preserves the pin and tee positions to within a yard', () => {
    const projected = projectHole(hole)!;
    expect(projected.hole.teePoint.x).toBeCloseTo(DEMO_HOLE.teePoint.x, 3);
    expect(projected.hole.teePoint.y).toBeCloseTo(DEMO_HOLE.teePoint.y, 3);
    expect(projected.hole.pin.x).toBeCloseTo(DEMO_HOLE.pin.x, 3);
    expect(projected.hole.pin.y).toBeCloseTo(DEMO_HOLE.pin.y, 3);
  });

  it('reports a sane centreline yardage', () => {
    const y = centerlineYardage(hole)!;
    expect(y).toBeGreaterThan(390);
    expect(y).toBeLessThan(440);
  });
});

describe('target evaluation', () => {
  const projected = projectHole(buildDemoCourse().holes[0])!;
  const compiled = compileHole(projected.hole);
  const noise = makeNoiseBank(3000, 11);
  const tee = projected.hole.teePoint;

  it('prices a perfect target with no dispersion model at all', () => {
    const t = { x: -20, y: 235 }; // lay-up zone, left of the bunker
    const r = evaluateTarget(compiled, tee, 'tee', t, DEFAULT_COST_CONFIG);
    expect(r.realistic).toBeUndefined();
    expect(r.targetLie).toBe('fairway');
    expect(r.distanceToTarget).toBeCloseTo(Math.hypot(20, 235), 3);

    // Gain is measured against the baseline expectation from the tee, not
    // against standing still, so a conservative lay-up sits slightly negative:
    // an average tee shot from 388 yards advances further than this. That sign
    // is correct and is exactly why the app compares options against each
    // other rather than reporting one number in isolation.
    expect(r.perfectGain).toBeGreaterThan(-0.2);
    expect(r.perfectGain).toBeLessThan(0.2);

    // What must hold is monotonicity: advancing further up the same fairway
    // has to price better than stopping short of it.
    const shorter = evaluateTarget(compiled, tee, 'tee', { x: -15, y: 170 }, DEFAULT_COST_CONFIG);
    expect(r.perfectGain).toBeGreaterThan(shorter.perfectGain);
  });

  it('charges a penalty for a target inside the water', () => {
    const dry = evaluateTarget(compiled, tee, 'tee', { x: -20, y: 235 }, DEFAULT_COST_CONFIG);
    const wet = evaluateTarget(compiled, tee, 'tee', { x: 0, y: 270 }, DEFAULT_COST_CONFIG);
    expect(wet.targetLie).toBe('water');
    expect(wet.perfectGain).toBeLessThan(dry.perfectGain);
    // Stroke plus distance-equivalent: the shot and the penalty, then replay.
    expect(wet.perfectStrokes).toBeCloseTo(wet.currentStrokes + 2, 6);
  });

  it('diverges from the perfect number when the miss pattern reaches a hazard', () => {
    // A target on the centreline just short of the pond: perfect execution is
    // fine, but the spread is not.
    const target = { x: 0, y: 240 };
    const driver = DEFAULT_BAG[0];
    const r = evaluateTarget(compiled, tee, 'tee', target, DEFAULT_COST_CONFIG, driver, noise);
    expect(r.realistic).toBeDefined();
    expect(r.realistic!.outcomeShare.water).toBeGreaterThan(0.05);
    // This is the whole argument for keeping dispersion: the realistic number
    // has to be worse than the one that assumes perfect execution.
    expect(r.realistic!.gain).toBeLessThan(r.perfectGain);
  });

  it('agrees with the perfect number when nothing can go wrong', () => {
    const target = { x: -10, y: 200 }; // middle of a wide fairway, no hazards near
    const robot = {
      ...DEFAULT_BAG[3],
      carrySigmaPct: 0.001,
      lateralSigmaPct: 0.001,
      lateralBiasPct: 0,
      mishitWeight: 0,
    };
    const r = evaluateTarget(compiled, tee, 'tee', target, DEFAULT_COST_CONFIG, robot, noise);
    expect(r.realistic!.gain).toBeCloseTo(r.perfectGain, 2);
  });

  it('scales dispersion with the distance actually being hit', () => {
    const club = DEFAULT_BAG[0];
    const near = evaluateTarget(compiled, tee, 'tee', { x: 0, y: 100 }, DEFAULT_COST_CONFIG, club, noise);
    const far = evaluateTarget(compiled, tee, 'tee', { x: 0, y: 240 }, DEFAULT_COST_CONFIG, club, noise);
    const spread = (pts: { x: number; y: number }[]) => {
      const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      return Math.sqrt(pts.reduce((a, p) => a + (p.x - mx) ** 2, 0) / pts.length);
    };
    // Spec 4.1: sigma is a fraction of carry, so a longer target must scatter wider.
    expect(spread(far.realistic!.scatter)).toBeGreaterThan(spread(near.realistic!.scatter) * 1.5);
  });

  it('suggests the club whose stock shot reaches the target', () => {
    expect(suggestClub(DEFAULT_BAG, 265)?.id).toBe('driver');
    expect(suggestClub(DEFAULT_BAG, 170)?.id).toBe('6i');
    expect(suggestClub([], 200)).toBeUndefined();
  });
});
