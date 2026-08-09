import L from 'leaflet';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { cloneBag } from '../data/clubs';
import { centerlineYardage, isPlayable, projectHole, type GeoCourse } from '../model/course';
import { makeNoiseBank } from '../model/dispersion';
import { PROVISIONAL_BASELINE } from '../model/expectedStrokes';
import { compileHole, resolveLie } from '../model/geometry';
import { evaluateTarget, OUTCOMES, suggestClub, type Outcome } from '../model/optimizer';
import { rotateDeg } from '../model/geometry';
import type { LatLng } from '../model/projection';
import type { Lie, Point } from '../model/types';
import { MapView, type TileSourceKey } from '../ui/MapView';

const OUTCOME_COLOR: Record<Outcome, string> = {
  green: '#8ddf94',
  fairway: '#4fa85a',
  rough: '#6d7f5f',
  bunker: '#d9c48f',
  trees: '#2f5c3c',
  water: '#3d7fb5',
  ob: '#a05a86',
};

function featureToLie(type: string): Lie {
  switch (type) {
    case 'bunker':
      return 'sand';
    case 'trees':
      return 'recovery';
    case 'green':
      return 'green';
    case 'fairway':
      return 'fairway';
    case 'tee':
      return 'tee';
    default:
      return 'rough';
  }
}

function gainClass(v: number): string {
  if (v > 0.03) return 'gain good';
  if (v < -0.03) return 'gain bad';
  return 'gain flat';
}

function fmtGain(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
}

export interface PlayProps {
  courses: GeoCourse[];
  onLoadDemo: () => void;
  tileSource: TileSourceKey;
  onTileSource: (k: TileSourceKey) => void;
  skillFactor: number;
}

export function Play({ courses, onLoadDemo, tileSource, onTileSource, skillFactor }: PlayProps) {
  const playable = useMemo(
    () =>
      courses
        .map((c) => ({ course: c, holes: c.holes.filter(isPlayable) }))
        .filter((c) => c.holes.length > 0),
    [courses],
  );

  const [courseId, setCourseId] = useState<string>('');
  const [holeId, setHoleId] = useState<string>('');
  const active = playable.find((p) => p.course.id === courseId) ?? playable[0];
  const hole = active?.holes.find((h) => h.id === holeId) ?? active?.holes[0];

  const [ball, setBall] = useState<LatLng | null>(null);
  const [target, setTarget] = useState<LatLng | null>(null);
  const [clubId, setClubId] = useState<string>('auto');
  const [showPattern, setShowPattern] = useState(true);
  const [gpsError, setGpsError] = useState<string | null>(null);

  const bag = useMemo(() => cloneBag(), []);
  const overlayRef = useRef<L.LayerGroup | null>(null);
  const targetMarkerRef = useRef<L.Marker | null>(null);

  // Reset ball and target when the hole changes.
  useEffect(() => {
    if (!hole?.tee) return;
    setBall(hole.tee);
    setTarget(hole.pin ?? hole.green ?? hole.tee);
  }, [hole?.id, hole?.tee, hole?.pin, hole?.green]);

  const projected = useMemo(() => (hole ? projectHole(hole) : null), [hole]);
  const compiled = useMemo(() => (projected ? compileHole(projected.hole) : null), [projected]);
  const noise = useMemo(() => makeNoiseBank(2000, 7), []);

  const deferredTarget = useDeferredValue(target);
  const stale = deferredTarget !== target;

  const evaluation = useMemo(() => {
    if (!compiled || !projected || !ball || !deferredTarget) return null;
    const startP: Point = projected.projector.toLocal(ball);
    const targetP: Point = projected.projector.toLocal(deferredTarget);
    const startLie = featureToLie(resolveLie(compiled, startP.x, startP.y).type);
    const distance = Math.hypot(targetP.x - startP.x, targetP.y - startP.y);
    const club =
      clubId === 'auto' ? suggestClub(bag, distance) : bag.find((c) => c.id === clubId);
    // Nothing stops you dragging the crosshair 380 yards, but simulating a
    // shot no club in the bag can hit produces a confident number about an
    // impossible shot -- exactly the failure mode the provisional baselines
    // are already guarded against. Flag it rather than quietly answering.
    const maxReach = Math.max(
      ...bag.filter((c) => c.inBag).map((c) => c.meanCarry + c.rollFairway),
    );
    return {
      startLie,
      outOfRange: distance > maxReach * 1.03,
      maxReach,
      result: evaluateTarget(
        compiled,
        startP,
        startLie,
        targetP,
        { skillFactor },
        club,
        noise,
      ),
    };
  }, [compiled, projected, ball, deferredTarget, clubId, bag, noise, skillFactor]);

  // Draw the aim line, the miss pattern and the crosshair.
  const handleReady = useCallback((_map: L.Map, overlay: L.LayerGroup) => {
    overlayRef.current = overlay;
  }, []);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !projected || !ball || !target) return;
    overlay.clearLayers();
    const toLatLng = projected.projector.toLatLng;

    L.polyline(
      [
        [ball.lat, ball.lng],
        [target.lat, target.lng],
      ],
      { color: '#ffffff', weight: 2, opacity: 0.9 },
    ).addTo(overlay);

    if (showPattern && evaluation?.result.realistic) {
      for (const p of evaluation.result.realistic.scatter) {
        const ll = toLatLng(p);
        L.circleMarker([ll.lat, ll.lng], {
          radius: 2.5,
          color: '#f0a63c',
          weight: 0,
          fillColor: '#f0a63c',
          fillOpacity: 0.55,
        }).addTo(overlay);
      }

      // The wedge. Dispersion is angular, so the band of equal distance is an
      // arc struck from the ball, not a straight line across the aim -- which
      // is why the width marker bows away from you and grows with the club.
      const shape = evaluation.result.realistic.shape;
      const startP = projected.projector.toLocal(ball);
      const dir = {
        x: (projected.projector.toLocal(target).x - startP.x) / evaluation.result.distanceToTarget,
        y: (projected.projector.toLocal(target).y - startP.y) / evaluation.result.distanceToTarget,
      };
      const at = (radius: number, angleRad: number) => {
        const d = rotateDeg(dir, (angleRad * 180) / Math.PI);
        return toLatLng({ x: startP.x + d.x * radius, y: startP.y + d.y * radius });
      };

      const halfAngle = shape.k * shape.sdAngle;
      const arcPts: [number, number][] = [];
      const STEPS = 24;
      for (let i = 0; i <= STEPS; i++) {
        const a = shape.meanAngle - halfAngle + (2 * halfAngle * i) / STEPS;
        const ll = at(shape.meanRadius, a);
        arcPts.push([ll.lat, ll.lng]);
      }
      L.polyline(arcPts, { color: '#ffffff', weight: 1.6, opacity: 0.85 }).addTo(overlay);

      // End ticks, so the arc reads as a measured span rather than a stray line.
      for (const side of [-1, 1]) {
        const a = shape.meanAngle + side * halfAngle;
        const inner = at(shape.meanRadius - shape.k * shape.sdRadius * 0.45, a);
        const outer = at(shape.meanRadius + shape.k * shape.sdRadius * 0.45, a);
        L.polyline(
          [
            [inner.lat, inner.lng],
            [outer.lat, outer.lng],
          ],
          { color: '#ffffff', weight: 1.4, opacity: 0.7 },
        ).addTo(overlay);
      }

      const near = at(shape.meanRadius - shape.k * shape.sdRadius, shape.meanAngle);
      const far = at(shape.meanRadius + shape.k * shape.sdRadius, shape.meanAngle);
      L.polyline(
        [
          [near.lat, near.lng],
          [far.lat, far.lng],
        ],
        { color: '#ffffff', weight: 1.6, opacity: 0.85 },
      ).addTo(overlay);

      const label = (
        p: { lat: number; lng: number },
        text: string,
        title: string,
        anchor: [number, number],
      ) =>
        L.marker([p.lat, p.lng], {
          interactive: false,
          icon: L.divIcon({
            className: 'pattern-label-icon',
            html: `<div class="pattern-label" title="${title}">${text}</div>`,
            iconSize: [110, 20],
            iconAnchor: anchor,
          }),
        }).addTo(overlay);

      label(
        at(shape.meanRadius, shape.meanAngle - halfAngle * 1.9),
        `${shape.widthYards.toFixed(0)} yd wide`,
        `Span of ±${shape.k}σ of offline angle at this distance`,
        [95, 10],
      );
      // Labelled "avg" on purpose: this is the mean distance the ball actually
      // travels, which sits short of the target because the mishit component
      // carries short. Without the word it reads as an arithmetic error.
      label(far, `${shape.meanRadius.toFixed(0)} yd avg`, 'Mean carry across the pattern', [55, 24]);
    }

    L.circleMarker([ball.lat, ball.lng], {
      radius: 6,
      color: '#ffffff',
      weight: 2,
      fillColor: '#2f6f9f',
      fillOpacity: 1,
    }).addTo(overlay);

    const icon = L.divIcon({
      className: 'crosshair-icon',
      html: '<div class="crosshair"></div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    const marker = L.marker([target.lat, target.lng], { icon, draggable: true }).addTo(overlay);
    marker.on('drag', (e) => {
      const ll = (e.target as L.Marker).getLatLng();
      setTarget({ lat: ll.lat, lng: ll.lng });
    });
    targetMarkerRef.current = marker;
  }, [projected, ball, target, evaluation, showPattern]);

  const useGps = () => {
    setGpsError(null);
    if (!navigator.geolocation) {
      setGpsError('This browser exposes no geolocation API.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setBall({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => setGpsError(`${err.message}. Tap the map to drop the ball instead.`),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  if (!active || !hole) {
    return (
      <div className="card empty">
        <h2>No traced holes yet</h2>
        <p className="note">
          The drag-and-drop page needs real geometry underneath it. Open <strong>Trace</strong>,
          set a tee and a green, and draw at least one polygon — that is enough to start pricing
          targets. Every number here is computed from those polygons.
        </p>
        <div className="play-actions">
          <button onClick={onLoadDemo}>Load the synthetic demo hole</button>
        </div>
        <p className="note">
          The demo hole has invented coordinates over open farmland, so the imagery will not
          match. It exists to make the interaction real before you have traced anything.
        </p>
      </div>
    );
  }

  const r = evaluation?.result;
  const yardage = centerlineYardage(hole);

  return (
    <div className="play">
      <div className="play-bar">
        <select value={active.course.id} onChange={(e) => { setCourseId(e.target.value); setHoleId(''); }}>
          {playable.map((p) => (
            <option key={p.course.id} value={p.course.id}>{p.course.name}</option>
          ))}
        </select>
        <select value={hole.id} onChange={(e) => setHoleId(e.target.value)}>
          {active.holes.map((h) => (
            <option key={h.id} value={h.id}>
              Hole {h.number} · par {h.par}
              {centerlineYardage(h) ? ` · ${centerlineYardage(h)}y` : ''}
            </option>
          ))}
        </select>
        <select value={tileSource} onChange={(e) => onTileSource(e.target.value as TileSourceKey)}>
          <option value="naip">NAIP</option>
          <option value="usgs">USGS</option>
          <option value="esri">Esri</option>
          <option value="none">No imagery</option>
        </select>
      </div>

      <MapView
        center={hole.tee!}
        features={hole.features}
        fitTo={[hole.tee!, hole.green!]}
        tileSource={tileSource}
        onMapClick={(p) => setTarget(p)}
        onReady={handleReady}
      />

      <div className="play-actions">
        <button onClick={useGps}>Use GPS for ball</button>
        <button onClick={() => hole.tee && setBall(hole.tee)}>Ball to tee</button>
        <label className="inline-check">
          <input type="checkbox" checked={showPattern} onChange={(e) => setShowPattern(e.target.checked)} />
          miss pattern
        </label>
      </div>
      {gpsError && <p className="note warn">{gpsError}</p>}

      {r && (
        <section className={`card readout ${stale ? 'stale' : ''}`}>
          <div className="yardages">
            <div>
              <span className="k">to target</span>
              <span className="v">{r.distanceToTarget.toFixed(0)}<em>y</em></span>
            </div>
            <div>
              <span className="k">target to pin</span>
              <span className="v">{r.distanceTargetToPin.toFixed(0)}<em>y</em></span>
            </div>
            <div>
              <span className="k">lands in</span>
              <span className="v small">{r.targetLie}</span>
            </div>
          </div>

          {evaluation.outOfRange && (
            <p className="note warn oor">
              No club in the bag reaches {r.distanceToTarget.toFixed(0)}y — the longest is{' '}
              {evaluation.maxReach.toFixed(0)}y. The realistic number below assumes you could hit
              it that far, so treat it as hypothetical rather than a plan.
            </p>
          )}

          <div className="layers">
            <div className="layer">
              <span className="layer-label">if you hit it exactly here</span>
              <span className={gainClass(r.perfectGain)}>{fmtGain(r.perfectGain)}</span>
              <span className="layer-sub">
                strokes gained · needs no dispersion model
              </span>
            </div>
            <div className="layer">
              <span className="layer-label">
                realistic{r.realistic ? ` · ${r.realistic.club.name}` : ''}
              </span>
              {r.realistic ? (
                <>
                  <span className={gainClass(r.realistic.gain)}>{fmtGain(r.realistic.gain)}</span>
                  <span className="layer-sub">
                    across your miss pattern at {r.distanceToTarget.toFixed(0)}y
                  </span>
                </>
              ) : (
                <>
                  <span className="gain flat">—</span>
                  <span className="layer-sub">pick a club to price the miss</span>
                </>
              )}
            </div>
          </div>

          {r.realistic && (
            <>
              <div className="outcome-bar">
                {OUTCOMES.map((o) =>
                  r.realistic!.outcomeShare[o] > 0.001 ? (
                    <span
                      key={o}
                      style={{
                        width: `${r.realistic!.outcomeShare[o] * 100}%`,
                        background: OUTCOME_COLOR[o],
                      }}
                      title={`${o} ${(r.realistic!.outcomeShare[o] * 100).toFixed(0)}%`}
                    />
                  ) : null,
                )}
              </div>
              <ul className="chips">
                {OUTCOMES.filter((o) => r.realistic!.outcomeShare[o] >= 0.005).map((o) => (
                  <li key={o}>
                    <span className="dot" style={{ background: OUTCOME_COLOR[o] }} />
                    {o} <strong>{(r.realistic!.outcomeShare[o] * 100).toFixed(0)}%</strong>
                  </li>
                ))}
              </ul>
              {Math.abs(r.perfectGain - r.realistic.gain) > 0.15 && (
                <p className="note divergence">
                  The two numbers disagree by{' '}
                  <strong>{Math.abs(r.perfectGain - r.realistic.gain).toFixed(2)}</strong> strokes.
                  That gap is the cost of your miss pattern, and it is the entire reason the
                  target that looks best is not always the one to aim at.
                </p>
              )}
            </>
          )}

          <div className="club-row">
            <label>
              club
              <select value={clubId} onChange={(e) => setClubId(e.target.value)}>
                <option value="auto">auto (nearest carry)</option>
                {bag.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} · {c.meanCarry}y</option>
                ))}
              </select>
            </label>
            <span className="note">
              par {hole.par}{yardage ? ` · ${yardage}y` : ''} · playing from {evaluation.startLie}
            </span>
          </div>
        </section>
      )}

      {PROVISIONAL_BASELINE && (
        <p className="note">
          Strokes-gained values use a provisional expected-strokes table (spec §12 #4). Treat the
          comparison between the two layers as informative and the absolute numbers as decorative.
        </p>
      )}
    </div>
  );
}
