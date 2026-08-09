/**
 * Prints the optimizer's answer for the demo hole to the terminal.
 * Run with: npx vite-node scripts/inspect.ts
 */
import { DEFAULT_BAG } from '../src/data/clubs';
import { DEMO_HOLE } from '../src/data/demoHole';
import { makeNoiseBank } from '../src/model/dispersion';
import { DEFAULT_COST_CONFIG } from '../src/model/expectedStrokes';
import { angleBetweenDeg, compileHole, direction } from '../src/model/geometry';
import { OUTCOMES, optimizeShot } from '../src/model/optimizer';

const compiled = compileHole(DEMO_HOLE);
const noise = makeNoiseBank(6000, 7);
const t0 = Date.now();
const plan = optimizeShot(
  compiled,
  DEMO_HOLE.teePoint,
  'tee',
  DEFAULT_BAG,
  noise,
  DEFAULT_COST_CONFIG,
);
const ms = Date.now() - t0;

const pinDir = direction(DEMO_HOLE.teePoint, DEMO_HOLE.pin);
const pinAngleFromAxis = angleBetweenDeg({ x: 0, y: 1 }, pinDir);
console.log(`${DEMO_HOLE.name}\npar ${DEMO_HOLE.par}, pin bears ${pinAngleFromAxis.toFixed(1)}° right of the hole axis`);
console.log(`swept ${plan.byClub[0].candidates.length} aim lines x ${DEFAULT_BAG.length} clubs x ${noise.n} samples in ${ms}ms\n`);

for (let i = 0; i < plan.byClub.length; i++) {
  const r = plan.byClub[i];
  const best = r.candidates[r.bestIndex];
  const ref = r.candidates[r.naiveIndex];
  const mark = i === plan.bestClubIndex ? ' <-- best club' : '';
  console.log(`${r.club.name}${mark}`);
  console.log(
    `  down middle: E=${ref.expectedStrokes.toFixed(3)}  ` +
      OUTCOMES.filter((o) => ref.outcomeShare[o] > 0.005)
        .map((o) => `${o} ${(ref.outcomeShare[o] * 100).toFixed(0)}%`)
        .join('  '),
  );
  console.log(
    `  best aim   : E=${best.expectedStrokes.toFixed(3)}  ${best.angleDeg.toFixed(0)}° from pin ` +
      `(${(best.angleDeg + pinAngleFromAxis).toFixed(0)}° from axis), leaves ${best.meanRemaining.toFixed(0)}y  ` +
      OUTCOMES.filter((o) => best.outcomeShare[o] > 0.005)
        .map((o) => `${o} ${(best.outcomeShare[o] * 100).toFixed(0)}%`)
        .join('  '),
  );
  console.log(`  gain over aiming at the pin: ${(ref.expectedStrokes - best.expectedStrokes).toFixed(3)} strokes\n`);
}
