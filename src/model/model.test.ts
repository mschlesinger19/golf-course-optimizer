import { describe, expect, it } from 'vitest';
import { DEFAULT_BAG } from '../data/clubs';
import { DEMO_HOLE } from '../data/demoHole';
import { makeNoiseBank, patternShape, sampleShotCloud } from './dispersion';
import { DEFAULT_COST_CONFIG, expectedStrokes } from './expectedStrokes';
import { angleBetweenDeg, compileHole, direction, resolveLie, rotateDeg } from './geometry';
import { optimizeClub, optimizeShot } from './optimizer';

const compiled = compileHole(DEMO_HOLE);

describe('geometry', () => {
  it('resolves the demo hole features at known points', () => {
    expect(resolveLie(compiled, 0, 0).type).toBe('tee');
    expect(resolveLie(compiled, 0, 200).type).toBe('fairway');
    // Where a dead-straight driver finishes.
    expect(resolveLie(compiled, 0, 270).type).toBe('water');
    // The lay-up bunker.
    expect(resolveLie(compiled, 4, 232).type).toBe('bunker');
    expect(resolveLie(compiled, 120, 358).type).toBe('green');
    expect(resolveLie(compiled, -120, 200).type).toBe('ob');
    // Untraced ground is rough (spec 3.1).
    expect(resolveLie(compiled, -60, 200).type).toBe('rough');
  });

  it('gives hazards priority over the surface they sit on', () => {
    // The pond overlaps the fairway corridor; water has to win.
    expect(resolveLie(compiled, -10, 265).type).toBe('water');
  });

  it('rotates clockwise for positive angles', () => {
    const up = { x: 0, y: 1 };
    const right = rotateDeg(up, 90);
    expect(right.x).toBeCloseTo(1, 6);
    expect(right.y).toBeCloseTo(0, 6);
    expect(angleBetweenDeg(up, right)).toBeCloseTo(90, 6);
  });

  it('measures the pin as right of the hole axis on a dogleg right', () => {
    const toPin = direction(DEMO_HOLE.teePoint, DEMO_HOLE.pin);
    expect(angleBetweenDeg({ x: 0, y: 1 }, toPin)).toBeGreaterThan(10);
  });
});

describe('expected strokes', () => {
  it('increases with distance from every lie', () => {
    for (const lie of ['fairway', 'rough', 'sand', 'recovery'] as const) {
      for (let d = 30; d < 260; d += 10) {
        expect(expectedStrokes(d + 10, lie)).toBeGreaterThan(expectedStrokes(d, lie));
      }
    }
  });

  it('ranks lies from the same distance', () => {
    const d = 150;
    expect(expectedStrokes(d, 'fairway')).toBeLessThan(expectedStrokes(d, 'rough'));
    expect(expectedStrokes(d, 'rough')).toBeLessThan(expectedStrokes(d, 'sand'));
    expect(expectedStrokes(d, 'sand')).toBeLessThan(expectedStrokes(d, 'recovery'));
  });

  it('applies the penalty modifier on top of the lie', () => {
    expect(expectedStrokes(40, 'sand', DEFAULT_COST_CONFIG, 0.3)).toBeCloseTo(
      expectedStrokes(40, 'sand') + 0.3,
      9,
    );
  });

  it('scales strokes above one by the skill factor', () => {
    const scratch = expectedStrokes(150, 'fairway', { skillFactor: 1 });
    const worse = expectedStrokes(150, 'fairway', { skillFactor: 1.3 });
    expect(worse).toBeGreaterThan(scratch);
    expect(worse - 1).toBeCloseTo((scratch - 1) * 1.3, 9);
  });

  it('prices a tap-in at just over one stroke', () => {
    expect(expectedStrokes(0.3, 'green', { skillFactor: 1 })).toBeLessThan(1.1);
  });
});

describe('dispersion', () => {
  it('reproduces the requested moments for the normal component', () => {
    const club = { ...DEFAULT_BAG[0], mishitWeight: 0 };
    const cloud = sampleShotCloud(club, makeNoiseBank(40000));
    let radiusSum = 0;
    let carrySum = 0;
    let latSum = 0;
    for (let i = 0; i < cloud.n; i++) {
      radiusSum += cloud.radius[i];
      carrySum += cloud.carry[i];
      latSum += cloud.lateral[i];
    }
    // The club's carry is the distance the ball travels, which is the radius.
    expect(radiusSum / cloud.n).toBeCloseTo(club.meanCarry, 0);
    expect(latSum / cloud.n).toBeCloseTo(club.lateralBiasPct * club.meanCarry, 0);

    // The component *along the aim line* is shorter than the carry, because
    // an offline shot spends part of its distance sideways. Small, but real,
    // and a consequence of dispersion being angular rather than rectangular.
    const meanAlong = carrySum / cloud.n;
    expect(meanAlong).toBeLessThan(club.meanCarry);
    expect(meanAlong).toBeGreaterThan(club.meanCarry - 2);
  });

  it('spreads proportionally with the distance hit, not as a fixed offset', () => {
    // The defining property of an angular cone: halve the carry and the
    // sideways spread halves too.
    const noise = makeNoiseBank(40000);
    const long = sampleShotCloud({ ...DEFAULT_BAG[0], mishitWeight: 0 }, noise);
    const short = sampleShotCloud(
      { ...DEFAULT_BAG[0], meanCarry: DEFAULT_BAG[0].meanCarry / 2, mishitWeight: 0 },
      noise,
    );
    const sd = (a: Float64Array) => {
      let m = 0;
      for (let i = 0; i < a.length; i++) m += a[i];
      m /= a.length;
      let v = 0;
      for (let i = 0; i < a.length; i++) v += (a[i] - m) ** 2;
      return Math.sqrt(v / a.length);
    };
    expect(sd(short.lateral)).toBeCloseTo(sd(long.lateral) / 2, 0);
  });

  it('describes the cloud with a wedge that bounds its own scatter', () => {
    const cloud = sampleShotCloud(DEFAULT_BAG[0], makeNoiseBank(20000));
    const shape = patternShape(cloud, 1.5);
    expect(shape.meanRadius).toBeCloseTo(DEFAULT_BAG[0].meanCarry, -1);
    expect(shape.widthYards).toBeGreaterThan(0);
    // Roughly 87% of samples should fall inside a 1.5-sigma band on each axis.
    let inside = 0;
    for (let i = 0; i < cloud.n; i++) {
      if (
        Math.abs(cloud.angle[i] - shape.meanAngle) <= 1.5 * shape.sdAngle &&
        Math.abs(cloud.radius[i] - shape.meanRadius) <= 1.5 * shape.sdRadius
      ) {
        inside++;
      }
    }
    expect(inside / cloud.n).toBeGreaterThan(0.6);
  });

  it('fattens the tail when the mishit component is switched on', () => {
    const noise = makeNoiseBank(40000);
    const clean = sampleShotCloud({ ...DEFAULT_BAG[0], mishitWeight: 0 }, noise);
    const mixed = sampleShotCloud({ ...DEFAULT_BAG[0], mishitWeight: 0.15 }, noise);
    const wide = (c: typeof clean) => {
      let n = 0;
      for (let i = 0; i < c.n; i++) if (Math.abs(c.lateral[i]) > 45) n++;
      return n / c.n;
    };
    // The whole argument for the mixture (spec 4.1) is that a single Gaussian
    // underestimates this tail.
    expect(wide(mixed)).toBeGreaterThan(wide(clean) * 1.5);
  });

  it('is deterministic for a given seed', () => {
    const a = sampleShotCloud(DEFAULT_BAG[0], makeNoiseBank(5000, 42));
    const b = sampleShotCloud(DEFAULT_BAG[0], makeNoiseBank(5000, 42));
    expect(Array.from(a.carry.slice(0, 20))).toEqual(Array.from(b.carry.slice(0, 20)));
  });
});

describe('optimizer', () => {
  const noise = makeNoiseBank(3000, 7);

  it('prices an out-of-bounds sample as E(start) + 2', () => {
    // A club that cannot miss, aimed from a spot where every ball is OB.
    const perfect = {
      ...DEFAULT_BAG[0],
      meanCarry: 60,
      carrySigmaPct: 0,
      lateralSigmaPct: 0,
      lateralBiasPct: 0,
      mishitWeight: 0,
      rollFairway: 0,
    };
    const start = { x: -70, y: 200 };
    const result = optimizeClub(compiled, start, 'rough', perfect, noise, DEFAULT_COST_CONFIG, {
      sweepDeg: 0,
      stepDeg: 1,
    });
    // Aimed at the pin from here the ball is safe, so force the OB direction
    // by checking a sample that lands left instead.
    const obStart = expectedStrokes(
      Math.hypot(DEMO_HOLE.pin.x - start.x, DEMO_HOLE.pin.y - start.y),
      'rough',
    );
    const obCandidate = optimizeClub(
      compiled,
      start,
      'rough',
      // Enough left bias to put every ball over the property line.
      { ...perfect, lateralBiasPct: -2 },
      noise,
      DEFAULT_COST_CONFIG,
      { sweepDeg: 0, stepDeg: 1 },
    );
    expect(obCandidate.candidates[0].outcomeShare.ob).toBe(1);
    expect(obCandidate.candidates[0].expectedStrokes).toBeCloseTo(obStart + 2, 6);
    expect(result.candidates[0].outcomeShare.ob).toBe(0);
  });

  it('never recommends an aim line worse than straight down the middle', () => {
    for (const club of DEFAULT_BAG) {
      const r = optimizeClub(compiled, DEMO_HOLE.teePoint, 'tee', club, noise, DEFAULT_COST_CONFIG);
      expect(r.candidates[r.bestIndex].expectedStrokes).toBeLessThanOrEqual(
        r.candidates[r.naiveIndex].expectedStrokes + 1e-9,
      );
    }
  });

  it('keeps the driver out of the pond it would find aimed straight', () => {
    const driver = DEFAULT_BAG[0];
    const r = optimizeClub(compiled, DEMO_HOLE.teePoint, 'tee', driver, noise, DEFAULT_COST_CONFIG);
    // Straight down the hole axis is the pond; the reference line here is the
    // pin, so check the axis explicitly.
    const axisIndex = r.candidates.reduce((best, c, i) => {
      const axisAngle = -angleBetweenDeg(
        { x: 0, y: 1 },
        direction(DEMO_HOLE.teePoint, DEMO_HOLE.pin),
      );
      return Math.abs(c.angleDeg - axisAngle) < Math.abs(r.candidates[best].angleDeg - axisAngle)
        ? i
        : best;
    }, 0);
    expect(r.candidates[axisIndex].outcomeShare.water).toBeGreaterThan(0.25);
    expect(r.candidates[r.bestIndex].outcomeShare.water).toBeLessThan(
      r.candidates[axisIndex].outcomeShare.water,
    );
  });

  it('produces a smooth cost curve rather than Monte Carlo hash', () => {
    // Common random numbers should make neighbouring angles differ by far less
    // than the spread across the whole sweep. Without shared draws this fails.
    const r = optimizeClub(
      compiled,
      DEMO_HOLE.teePoint,
      'tee',
      DEFAULT_BAG[0],
      noise,
      DEFAULT_COST_CONFIG,
    );
    const vals = r.candidates.map((c) => c.expectedStrokes);
    let maxStep = 0;
    for (let i = 1; i < vals.length; i++) maxStep = Math.max(maxStep, Math.abs(vals[i] - vals[i - 1]));
    const spread = Math.max(...vals) - Math.min(...vals);
    expect(maxStep).toBeLessThan(spread / 4);
  });

  it('compares clubs and returns a winner', () => {
    const plan = optimizeShot(
      compiled,
      DEMO_HOLE.teePoint,
      'tee',
      DEFAULT_BAG,
      noise,
      DEFAULT_COST_CONFIG,
    );
    expect(plan.byClub).toHaveLength(DEFAULT_BAG.length);
    const best = plan.byClub[plan.bestClubIndex];
    for (const r of plan.byClub) {
      expect(best.candidates[best.bestIndex].expectedStrokes).toBeLessThanOrEqual(
        r.candidates[r.bestIndex].expectedStrokes + 1e-9,
      );
    }
  });

  it('outcome shares form a distribution', () => {
    const r = optimizeClub(
      compiled,
      DEMO_HOLE.teePoint,
      'tee',
      DEFAULT_BAG[0],
      noise,
      DEFAULT_COST_CONFIG,
    );
    for (const c of r.candidates) {
      const sum = Object.values(c.outcomeShare).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 9);
    }
  });
});
