import { describe, expect, it } from 'vitest';
import { makeNoiseBank, patternShape, sampleShotCloud } from './dispersion';
import { DEFAULT_QUESTIONNAIRE, ASSUMPTIONS, deriveBag } from './questionnaire';
import { buildPattern, measureShot, normalize, SHRINKAGE_K, type Shot } from './shots';

function shot(clubId: string, intended: number, actual: number, angleDeg: number): Shot {
  return {
    id: `${clubId}-${intended}-${actual}-${angleDeg}`,
    clubId,
    at: '2026-01-01T00:00:00.000Z',
    startLie: 'tee',
    endLie: 'fairway',
    intendedDistance: intended,
    actualDistance: actual,
    offlineAngle: (angleDeg * Math.PI) / 180,
    penalty: 0,
  };
}

describe('measuring a shot', () => {
  const start = { x: 0, y: 0 };

  it('reads a pure push as a positive angle', () => {
    // Aimed straight up the y axis, finished up and to the right.
    const m = measureShot(start, { x: 0, y: 200 }, { x: 100, y: 100 });
    expect(m.intendedDistance).toBeCloseTo(200, 6);
    expect(m.actualDistance).toBeCloseTo(Math.hypot(100, 100), 6);
    expect((m.offlineAngle * 180) / Math.PI).toBeCloseTo(45, 6);
  });

  it('reads a pull as a negative angle', () => {
    const m = measureShot(start, { x: 0, y: 200 }, { x: -50, y: 190 });
    expect(m.offlineAngle).toBeLessThan(0);
  });

  it('is measured against the intended line, not north', () => {
    // Aimed 90 degrees right; finishing straight along that line is dead straight.
    const m = measureShot(start, { x: 200, y: 0 }, { x: 180, y: 0 });
    expect(m.offlineAngle).toBeCloseTo(0, 6);
    expect(m.actualDistance / m.intendedDistance).toBeCloseTo(0.9, 6);
  });

  it('drops shots too short to belong to this model', () => {
    expect(normalize(shot('6i', 15, 14, 0))).toBeNull();
    expect(normalize(shot('6i', 150, 140, 0))).not.toBeNull();
  });
});

describe('building a pattern', () => {
  const shots = [
    shot('driver', 250, 240, 3),
    shot('driver', 250, 255, -2),
    shot('3w', 220, 210, 1),
    shot('5w', 200, 195, -1),
    shot('6i', 165, 160, 2),
  ];

  it('separates a club’s own shots from its family', () => {
    const p = buildPattern(shots, '3w');
    expect(p.ownCount).toBe(1);
    // 5-wood shares the wood family; driver and irons do not.
    expect(p.familyCount).toBe(1);
    expect(p.pool).toHaveLength(2);
  });

  it('gives the driver no family, because it has none', () => {
    const p = buildPattern(shots, 'driver');
    expect(p.ownCount).toBe(2);
    expect(p.familyCount).toBe(0);
  });

  it('grows trust in real data as shots accumulate', () => {
    const few = buildPattern([shot('6i', 165, 160, 1)], '6i');
    const many = buildPattern(
      Array.from({ length: SHRINKAGE_K }, (_, i) => shot('6i', 165, 160 + i, i - 6)),
      '6i',
    );
    expect(few.realWeight).toBeLessThan(0.2);
    // Spec 4.2's n/(n+k): at exactly k shots the split is even.
    expect(many.realWeight).toBeCloseTo(0.5, 2);
    expect(many.realWeight).toBeGreaterThan(few.realWeight);
  });

  it('reports zero trust with nothing logged', () => {
    expect(buildPattern([], 'driver').realWeight).toBe(0);
  });
});

describe('sampling from logged shots', () => {
  const noise = makeNoiseBank(8000, 3);
  const club = deriveBag(DEFAULT_QUESTIONNAIRE).clubs[0];

  it('takes the shape of the logged shots once there are enough', () => {
    // Every logged shot is a 12-degree block right. The pattern must lean that
    // way, which a symmetric fitted Gaussian could never represent.
    const blocks = Array.from({ length: 80 }, (_, i) => shot('driver', 250, 240 + (i % 5), 12));
    const pattern = buildPattern(blocks, 'driver');
    expect(pattern.realWeight).toBeGreaterThan(0.85);

    const withData = patternShape(sampleShotCloud(club, noise, pattern));
    const without = patternShape(sampleShotCloud(club, noise));
    expect((withData.meanAngle * 180) / Math.PI).toBeGreaterThan(9);
    expect(Math.abs((without.meanAngle * 180) / Math.PI)).toBeLessThan(4);
  });

  it('scales logged shots to whatever distance is being hit', () => {
    // A shot logged as "90% of intended, 5 degrees right" should reproduce at
    // any target distance, because it is stored dimensionless.
    const logged = Array.from({ length: 60 }, () => shot('6i', 165, 148.5, 5));
    const pattern = buildPattern(logged, '6i');
    const near = patternShape(sampleShotCloud({ ...club, meanCarry: 100 }, noise, pattern));
    const far = patternShape(sampleShotCloud({ ...club, meanCarry: 200 }, noise, pattern));
    expect(near.meanRadius / far.meanRadius).toBeCloseTo(0.5, 1);
    expect(near.meanAngle).toBeCloseTo(far.meanAngle, 3);
  });

  it('falls back to the prior when nothing is logged', () => {
    const a = patternShape(sampleShotCloud(club, noise, buildPattern([], 'driver')));
    const b = patternShape(sampleShotCloud(club, noise));
    expect(a.meanRadius).toBeCloseTo(b.meanRadius, 6);
  });
});

describe('questionnaire inference', () => {
  it('tightens dispersion as fairways hit rises', () => {
    const wild = deriveBag({ ...DEFAULT_QUESTIONNAIRE, fairwaysHit: 2 }).clubs[0];
    const straight = deriveBag({ ...DEFAULT_QUESTIONNAIRE, fairwaysHit: 12 }).clubs[0];
    expect(straight.lateralSigmaPct).toBeLessThan(wild.lateralSigmaPct);
  });

  it('drives the mishit weight from penalty strokes', () => {
    const clean = deriveBag({ ...DEFAULT_QUESTIONNAIRE, penaltiesPerRound: 0 }).clubs[0];
    const loose = deriveBag({ ...DEFAULT_QUESTIONNAIRE, penaltiesPerRound: 3 }).clubs[0];
    expect(loose.mishitWeight).toBeGreaterThan(clean.mishitWeight);
    expect(loose.mishitWeight).toBeCloseTo(
      3 / (ASSUMPTIONS.FULL_SHOTS_PER_ROUND * ASSUMPTIONS.PENALTY_GIVEN_MISHIT),
      6,
    );
  });

  it('treats a stated carry as the 75th percentile, not the mean', () => {
    const bag = deriveBag(DEFAULT_QUESTIONNAIRE).clubs;
    const driver = bag.find((c) => c.id === 'driver')!;
    // Spec section 5: apply the correction silently, but it must be applied.
    expect(driver.meanCarry).toBeLessThan(DEFAULT_QUESTIONNAIRE.carries.driver);
    expect(driver.meanCarry).toBeGreaterThan(DEFAULT_QUESTIONNAIRE.carries.driver - 25);
  });

  it('turns a one-way miss into a signed bias and a two-way miss into none', () => {
    const left = deriveBag({ ...DEFAULT_QUESTIONNAIRE, miss: 'left' }).clubs[0];
    const right = deriveBag({ ...DEFAULT_QUESTIONNAIRE, miss: 'right' }).clubs[0];
    const both = deriveBag({ ...DEFAULT_QUESTIONNAIRE, miss: 'two-way' }).clubs[0];
    expect(left.lateralBiasPct).toBeLessThan(0);
    expect(right.lateralBiasPct).toBeGreaterThan(0);
    expect(both.lateralBiasPct).toBe(0);
    // The bad miss leans further than the good one, in the same direction.
    expect(Math.abs(left.mishitLateralBiasPct)).toBeGreaterThan(Math.abs(left.lateralBiasPct));
    expect(Math.sign(left.mishitLateralBiasPct)).toBe(Math.sign(left.lateralBiasPct));
  });

  it('widens the longitudinal spread with the flush-to-thin gap', () => {
    const tight = deriveBag({ ...DEFAULT_QUESTIONNAIRE, flushThinGapYards: 8 }).clubs[0];
    const loose = deriveBag({ ...DEFAULT_QUESTIONNAIRE, flushThinGapYards: 40 }).clubs[0];
    expect(loose.carrySigmaPct).toBeGreaterThan(tight.carrySigmaPct);
  });

  it('orders clubs so the driver sprays more than the short irons', () => {
    const bag = deriveBag(DEFAULT_QUESTIONNAIRE).clubs;
    const driver = bag.find((c) => c.id === 'driver')!;
    const sixIron = bag.find((c) => c.id === '6i')!;
    expect(driver.lateralSigmaPct).toBeGreaterThan(sixIron.lateralSigmaPct);
    expect(driver.meanCarry).toBeGreaterThan(sixIron.meanCarry);
  });

  it('explains every inference it makes', () => {
    const { notes } = deriveBag(DEFAULT_QUESTIONNAIRE);
    expect(notes.length).toBeGreaterThanOrEqual(5);
    expect(notes.join(' ')).toMatch(/75th-percentile/);
    expect(notes.join(' ')).toMatch(/not recoverable/);
  });
});
