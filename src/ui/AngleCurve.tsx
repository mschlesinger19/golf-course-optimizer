import type { ClubResult } from '../model/optimizer';

const W = 320;
const H = 120;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 20;

/**
 * Expected strokes against aim angle, for one club.
 *
 * This chart is the reason the sweep returns the whole curve rather than just
 * the argmin. A deep narrow trough means the aim point is worth getting right;
 * a flat basin means the recommendation is nearly free to ignore, and that any
 * effort spent tightening the dispersion model is being spent on a decision
 * that barely moves.
 */
export function AngleCurve({ result }: { result: ClubResult }) {
  const vals = result.candidates.map((c) => c.expectedStrokes);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = Math.max(hi - lo, 0.05);
  const angles = result.candidates.map((c) => c.angleDeg);
  const aMin = angles[0];
  const aMax = angles[angles.length - 1];

  const px = (a: number) => PAD_L + ((a - aMin) / (aMax - aMin)) * (W - PAD_L - PAD_R);
  // Cost increases upward, so the recommendation reads as a trough.
  const py = (v: number) => H - PAD_B - ((v - lo) / span) * (H - PAD_T - PAD_B);

  const d = result.candidates
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${px(c.angleDeg).toFixed(2)},${py(c.expectedStrokes).toFixed(2)}`)
    .join(' ');

  const best = result.candidates[result.bestIndex];
  const naive = result.candidates[result.naiveIndex];

  // A band within 0.05 strokes of the optimum: anything in here is a coin flip.
  const tolerance = lo + 0.05;
  let bandStart: number | null = null;
  let bandEnd: number | null = null;
  for (const c of result.candidates) {
    if (c.expectedStrokes <= tolerance) {
      if (bandStart === null) bandStart = c.angleDeg;
      bandEnd = c.angleDeg;
    }
  }

  return (
    <svg className="angle-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <text x={PAD_L} y={PAD_T + 4} className="axis-label">
        {hi.toFixed(2)}
      </text>
      <text x={PAD_L} y={H - PAD_B - 2} className="axis-label">
        {lo.toFixed(2)} best
      </text>
      {bandStart !== null && bandEnd !== null && (
        <rect
          x={px(bandStart)}
          y={PAD_T}
          width={Math.max(px(bandEnd) - px(bandStart), 1)}
          height={H - PAD_T - PAD_B}
          fill="#7fd4ff"
          fillOpacity={0.12}
        />
      )}
      <line
        x1={px(naive.angleDeg)}
        y1={PAD_T}
        x2={px(naive.angleDeg)}
        y2={H - PAD_B}
        stroke="#f0a63c"
        strokeWidth={1.5}
        strokeDasharray="4 3"
      />
      <line
        x1={px(best.angleDeg)}
        y1={PAD_T}
        x2={px(best.angleDeg)}
        y2={H - PAD_B}
        stroke="#7fd4ff"
        strokeWidth={1.5}
      />
      <path d={d} fill="none" stroke="#e8ede9" strokeWidth={1.6} />
      <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} stroke="#ffffff" strokeOpacity={0.2} />
      <text x={PAD_L} y={H - 6} className="axis-label">
        {aMin.toFixed(0)}° left
      </text>
      <text x={W - PAD_R} y={H - 6} textAnchor="end" className="axis-label">
        {aMax.toFixed(0)}° right
      </text>
      <text x={W / 2} y={H - 6} textAnchor="middle" className="axis-label">
        aim angle, relative to the pin
      </text>
    </svg>
  );
}
