/**
 * Sweeps the dispersion parameters and reports how far the recommendation
 * moves. This is the question the demo exists to answer: if the aim point and
 * club choice hold still across a plausible parameter range, then the
 * hierarchical pooling and Bayesian updating in spec 4.2 are buying less than
 * they appear to.
 *
 * Run with: npx vite-node scripts/sensitivity.ts
 */
import { DEFAULT_BAG } from '../src/data/clubs';
import { DEMO_HOLE } from '../src/data/demoHole';
import { makeNoiseBank } from '../src/model/dispersion';
import { angleBetweenDeg, compileHole, direction } from '../src/model/geometry';
import { optimizeShot } from '../src/model/optimizer';
import type { ClubParams } from '../src/model/types';

const compiled = compileHole(DEMO_HOLE);
const noise = makeNoiseBank(5000, 7);
const pinOffset = angleBetweenDeg({ x: 0, y: 1 }, direction(DEMO_HOLE.teePoint, DEMO_HOLE.pin));

function run(mutate: (c: ClubParams) => ClubParams, skillFactor = 1.15) {
  const bag = DEFAULT_BAG.map(mutate);
  const plan = optimizeShot(compiled, DEMO_HOLE.teePoint, 'tee', bag, noise, { skillFactor }, {
    sweepDeg: 45,
    stepDeg: 1.5,
  });
  const winner = plan.byClub[plan.bestClubIndex];
  const best = winner.candidates[winner.bestIndex];
  const driver = plan.byClub[0];
  const driverBest = driver.candidates[driver.bestIndex];
  return {
    club: winner.club.name,
    axisAngle: best.angleDeg + pinOffset,
    e: best.expectedStrokes,
    driverPenalty: driverBest.expectedStrokes - best.expectedStrokes,
    driverWater: driverBest.outcomeShare.water,
  };
}

function table(title: string, rows: Array<[string, ReturnType<typeof run>]>) {
  console.log(`\n${title}`);
  console.log('  ' + 'setting'.padEnd(22) + 'best club'.padEnd(12) + 'aim'.padEnd(10) + 'E'.padEnd(8) + 'driver costs  driver water');
  for (const [label, r] of rows) {
    console.log(
      '  ' +
        label.padEnd(22) +
        r.club.padEnd(12) +
        `${r.axisAngle >= 0 ? '+' : ''}${r.axisAngle.toFixed(1)}°`.padEnd(10) +
        r.e.toFixed(3).padEnd(8) +
        `+${r.driverPenalty.toFixed(3)}`.padEnd(14) +
        `${(r.driverWater * 100).toFixed(0)}%`,
    );
  }
}

console.log('Demo hole, tee shot. Aim angle is degrees right of the hole axis;');
console.log('"driver costs" is how much worse the driver\'s own best line is than the winner.');

table(
  'Lateral sigma, all clubs scaled together (baseline driver 7.5%)',
  [0.5, 0.7, 0.85, 1, 1.2, 1.5, 2].map((k) => [
    `x${k.toFixed(2)} (drv ${(0.075 * k * 100).toFixed(1)}%)`,
    run((c) => ({ ...c, lateralSigmaPct: c.lateralSigmaPct * k })),
  ]),
);

table(
  'Mishit weight (baseline driver 12%)',
  [0, 0.04, 0.08, 0.12, 0.18, 0.25].map((w) => [
    `${(w * 100).toFixed(0)}% of shots`,
    run((c) => ({ ...c, mishitWeight: w })),
  ]),
);

table(
  'Mishit lateral bias, driver (baseline 15y left)',
  [-0.12, -0.06, 0, 0.06, 0.12].map((b) => [
    b === 0 ? 'two-way' : `${Math.abs(b * 245).toFixed(0)}y ${b < 0 ? 'left' : 'right'}`,
    run((c) => (c.id === 'driver' ? { ...c, mishitLateralBiasPct: b } : c)),
  ]),
);

table(
  'Skill factor (cost model, not dispersion)',
  [1, 1.1, 1.15, 1.25, 1.4].map((s) => [`${s.toFixed(2)}x over scratch`, run((c) => c, s)]),
);

table(
  'Carry, all clubs shifted together',
  [-20, -10, 0, 10, 20].map((d) => [
    `${d >= 0 ? '+' : ''}${d}y`,
    run((c) => ({ ...c, meanCarry: c.meanCarry + d })),
  ]),
);
