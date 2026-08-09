import { useMemo } from 'react';
import type { ClubResult } from '../model/optimizer';
import type { FeatureType, Hole, Point } from '../model/types';

const MIN_X = -105;
const MAX_X = 195;
const MIN_Y = -30;
const MAX_Y = 405;
const W = MAX_X - MIN_X;
const H = MAX_Y - MIN_Y;

/** Yards to SVG units. SVG y grows downward; the course frame grows toward the green. */
const sx = (x: number) => x - MIN_X;
const sy = (y: number) => MAX_Y - y;

const FILL: Record<FeatureType, string> = {
  ob: '#2a1f2e',
  water: '#1d4e79',
  bunker: '#d9c48f',
  trees: '#1c3524',
  green: '#5fbf6a',
  fairway: '#3f8a48',
  tee: '#7fa88a',
  rough: '#2d5b36',
};

const STROKE: Partial<Record<FeatureType, string>> = {
  ob: '#7a4a6a',
  water: '#3d7fb5',
  green: '#8ddf94',
};

function path(points: Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x)},${sy(p.y)}`).join(' ') + ' Z';
}

export interface HoleMapProps {
  hole: Hole;
  result: ClubResult;
  showBest: boolean;
  showNaive: boolean;
}

export function HoleMap({ hole, result, showBest, showNaive }: HoleMapProps) {
  const best = result.candidates[result.bestIndex];
  const naive = result.candidates[result.naiveIndex];
  const tee = hole.teePoint;

  const rings = useMemo(() => [150, 200, 250, 300], []);

  return (
    <svg className="hole-map" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      <rect x={0} y={0} width={W} height={H} fill={FILL.rough} />

      {/* Distance arcs from the tee, so the yardages on the panel have somewhere to land. */}
      {rings.map((r) => (
        <g key={r}>
          <circle
            cx={sx(tee.x)}
            cy={sy(tee.y)}
            r={r}
            fill="none"
            stroke="#ffffff"
            strokeOpacity={0.07}
            strokeWidth={0.8}
          />
          <text x={sx(tee.x) - 3} y={sy(tee.y + r) + 4} className="ring-label">
            {r}
          </text>
        </g>
      ))}

      {hole.features.map((f) => (
        <path
          key={f.id}
          d={path(f.polygon)}
          fill={FILL[f.type]}
          stroke={STROKE[f.type] ?? 'none'}
          strokeWidth={1}
        />
      ))}

      {/* Playing centreline -- what "straight down the middle" means on a dogleg. */}
      <path
        d={hole.centerline.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x)},${sy(p.y)}`).join(' ')}
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.22}
        strokeWidth={1}
        strokeDasharray="6 6"
      />

      {showNaive &&
        result.naiveScatter.map((p, i) => (
          <circle key={`n${i}`} cx={sx(p.x)} cy={sy(p.y)} r={1.6} fill="#f0a63c" fillOpacity={0.5} />
        ))}
      {showBest &&
        result.bestScatter.map((p, i) => (
          <circle key={`b${i}`} cx={sx(p.x)} cy={sy(p.y)} r={1.6} fill="#7fd4ff" fillOpacity={0.55} />
        ))}

      {showNaive && (
        <g>
          <line
            x1={sx(tee.x)}
            y1={sy(tee.y)}
            x2={sx(naive.aimPoint.x)}
            y2={sy(naive.aimPoint.y)}
            stroke="#f0a63c"
            strokeWidth={1.6}
            strokeDasharray="5 4"
          />
          <circle cx={sx(naive.aimPoint.x)} cy={sy(naive.aimPoint.y)} r={4} fill="#f0a63c" />
        </g>
      )}
      {showBest && (
        <g>
          <line
            x1={sx(tee.x)}
            y1={sy(tee.y)}
            x2={sx(best.aimPoint.x)}
            y2={sy(best.aimPoint.y)}
            stroke="#7fd4ff"
            strokeWidth={2}
          />
          <circle
            cx={sx(best.aimPoint.x)}
            cy={sy(best.aimPoint.y)}
            r={5}
            fill="none"
            stroke="#7fd4ff"
            strokeWidth={2}
          />
          <circle cx={sx(best.aimPoint.x)} cy={sy(best.aimPoint.y)} r={2} fill="#7fd4ff" />
        </g>
      )}

      {/* Pin */}
      <line
        x1={sx(hole.pin.x)}
        y1={sy(hole.pin.y)}
        x2={sx(hole.pin.x)}
        y2={sy(hole.pin.y) - 12}
        stroke="#ffffff"
        strokeWidth={1.2}
      />
      <path
        d={`M${sx(hole.pin.x)},${sy(hole.pin.y) - 12} l7,3 l-7,3 Z`}
        fill="#ff5b5b"
      />
      <circle cx={sx(hole.pin.x)} cy={sy(hole.pin.y)} r={2} fill="#ffffff" />

      {/* Tee */}
      <circle cx={sx(tee.x)} cy={sy(tee.y)} r={4} fill="#ffffff" />
    </svg>
  );
}
