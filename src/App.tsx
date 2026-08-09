import { useDeferredValue, useMemo, useState } from 'react';
import { DEFAULT_BAG, cloneBag } from './data/clubs';
import { DEMO_HOLE, DEMO_HOLE_YARDAGE } from './data/demoHole';
import { makeNoiseBank } from './model/dispersion';
import { PROVISIONAL_BASELINE } from './model/expectedStrokes';
import { compileHole, dist } from './model/geometry';
import { OUTCOMES, optimizeShot, type Candidate, type Outcome } from './model/optimizer';
import type { ClubParams } from './model/types';
import { AngleCurve } from './ui/AngleCurve';
import { HoleMap } from './ui/HoleMap';
import { Slider } from './ui/Slider';

const compiled = compileHole(DEMO_HOLE);

const OUTCOME_COLOR: Record<Outcome, string> = {
  green: '#8ddf94',
  fairway: '#4fa85a',
  rough: '#6d7f5f',
  bunker: '#d9c48f',
  trees: '#2f5c3c',
  water: '#3d7fb5',
  ob: '#a05a86',
};

function OutcomeBar({ candidate }: { candidate: Candidate }) {
  return (
    <div className="outcome-bar" role="img" aria-label="outcome distribution">
      {OUTCOMES.map((o) =>
        candidate.outcomeShare[o] > 0.001 ? (
          <span
            key={o}
            style={{ width: `${candidate.outcomeShare[o] * 100}%`, background: OUTCOME_COLOR[o] }}
            title={`${o} ${(candidate.outcomeShare[o] * 100).toFixed(0)}%`}
          />
        ) : null,
      )}
    </div>
  );
}

function OutcomeList({ candidate }: { candidate: Candidate }) {
  const shown = OUTCOMES.filter((o) => candidate.outcomeShare[o] >= 0.005);
  return (
    <ul className="outcome-list">
      {shown.map((o) => (
        <li key={o}>
          <span className="dot" style={{ background: OUTCOME_COLOR[o] }} />
          {o} <strong>{(candidate.outcomeShare[o] * 100).toFixed(0)}%</strong>
        </li>
      ))}
    </ul>
  );
}

export default function App() {
  const [bag, setBag] = useState<ClubParams[]>(() => cloneBag());
  const [selectedId, setSelectedId] = useState('driver');
  const [skillFactor, setSkillFactor] = useState(1.15);
  const [samples, setSamples] = useState(2500);
  const [showBest, setShowBest] = useState(true);
  const [showNaive, setShowNaive] = useState(true);

  // Keep the UI responsive while a slider is being dragged: React renders the
  // control immediately and recomputes the optimizer against the settled value.
  const deferred = useDeferredValue({ bag, skillFactor, samples });
  const stale = deferred.bag !== bag || deferred.skillFactor !== skillFactor;

  const plan = useMemo(() => {
    const noise = makeNoiseBank(deferred.samples, 7);
    return optimizeShot(
      compiled,
      DEMO_HOLE.teePoint,
      'tee',
      deferred.bag,
      noise,
      { skillFactor: deferred.skillFactor },
      { sweepDeg: 45, stepDeg: 1.5 },
    );
  }, [deferred]);

  const selectedIndex = Math.max(
    0,
    deferred.bag.findIndex((c) => c.id === selectedId),
  );
  const result = plan.byClub[selectedIndex];
  const best = result.candidates[result.bestIndex];
  const naive = result.candidates[result.naiveIndex];
  const bestClub = plan.byClub[plan.bestClubIndex];
  const bestClubValue = bestClub.candidates[bestClub.bestIndex].expectedStrokes;

  const offsetYards = dist(best.aimPoint, naive.aimPoint);
  const offsetSide = best.angleDeg > naive.angleDeg ? 'right' : 'left';
  const aimGain = naive.expectedStrokes - best.expectedStrokes;
  const clubGain = result.candidates[result.bestIndex].expectedStrokes - bestClubValue;

  const editSelected = (patch: Partial<ClubParams>) => {
    setBag((prev) => prev.map((c) => (c.id === selectedId ? { ...c, ...patch } : c)));
  };
  const club = bag.find((c) => c.id === selectedId) ?? bag[0];

  return (
    <div className="app">
      <header>
        <h1>Aim optimizer</h1>
        <p className="sub">
          {DEMO_HOLE.name} · par {DEMO_HOLE.par} · {DEMO_HOLE_YARDAGE}y
        </p>
      </header>

      {PROVISIONAL_BASELINE && (
        <div className="banner" role="note">
          <strong>Provisional baselines.</strong> The expected-strokes table, the handicap scaling
          and the hole coordinates are all invented, not sourced. Spec §12 opens #3 and #4. Treat
          the <em>comparisons</em> as informative and the absolute stroke numbers as decorative.
        </div>
      )}

      <div className="layout">
        <div className="map-pane">
          <HoleMap hole={DEMO_HOLE} result={result} showBest={showBest} showNaive={showNaive} />
          <div className="legend">
            <label>
              <input type="checkbox" checked={showBest} onChange={(e) => setShowBest(e.target.checked)} />
              <span className="swatch" style={{ background: '#7fd4ff' }} /> recommended
            </label>
            <label>
              <input type="checkbox" checked={showNaive} onChange={(e) => setShowNaive(e.target.checked)} />
              <span className="swatch" style={{ background: '#f0a63c' }} /> down the middle
            </label>
          </div>
        </div>

        <div className="panel">
          <section className={`card recommendation ${stale ? 'stale' : ''}`}>
            <h2>
              {club.name}
              {selectedIndex === plan.bestClubIndex && <span className="pill">best club</span>}
            </h2>
            <p className="headline">
              {offsetYards < 4 ? (
                <>Aim straight down the middle.</>
              ) : (
                <>
                  Aim <strong>{offsetYards.toFixed(0)} yards {offsetSide}</strong> of the middle.
                </>
              )}
            </p>

            <div className="compare">
              <div>
                <span className="compare-label">down the middle</span>
                <span className="compare-value">{naive.expectedStrokes.toFixed(2)}</span>
                <OutcomeBar candidate={naive} />
                <OutcomeList candidate={naive} />
              </div>
              <div>
                <span className="compare-label">recommended line</span>
                <span className="compare-value">{best.expectedStrokes.toFixed(2)}</span>
                <OutcomeBar candidate={best} />
                <OutcomeList candidate={best} />
              </div>
            </div>

            <p className="delta">
              Re-aiming this club saves <strong>{aimGain.toFixed(2)}</strong> strokes.
              {clubGain > 0.005 && (
                <>
                  {' '}
                  Switching to <strong>{bestClub.club.name}</strong> saves{' '}
                  <strong>{clubGain.toFixed(2)}</strong> more.
                </>
              )}
            </p>
            <p className="delta muted">
              Leaves {best.meanRemaining.toFixed(0)}y in on average, against{' '}
              {naive.meanRemaining.toFixed(0)}y down the middle.
            </p>
          </section>

          <section className="card">
            <h3>Cost by aim angle</h3>
            <AngleCurve result={result} />
            <p className="note">
              The shaded band is every aim line within 0.05 strokes of the best one. A wide band
              means the exact aim point barely matters here.
            </p>
          </section>

          <section className="card">
            <h3>Club comparison</h3>
            <table className="club-table">
              <thead>
                <tr>
                  <th>club</th>
                  <th>best E</th>
                  <th>leaves</th>
                  <th>risk</th>
                </tr>
              </thead>
              <tbody>
                {plan.byClub.map((r, i) => {
                  const c = r.candidates[r.bestIndex];
                  const trouble = c.outcomeShare.water + c.outcomeShare.ob + c.outcomeShare.trees;
                  return (
                    <tr
                      key={r.club.id}
                      className={[
                        r.club.id === selectedId ? 'selected' : '',
                        i === plan.bestClubIndex ? 'winner' : '',
                      ].join(' ')}
                      onClick={() => setSelectedId(r.club.id)}
                    >
                      <td>{r.club.name}</td>
                      <td>{c.expectedStrokes.toFixed(2)}</td>
                      <td>{Number.isNaN(c.meanRemaining) ? '—' : `${c.meanRemaining.toFixed(0)}y`}</td>
                      <td>
                        <div className="mini-bar">
                          <span style={{ width: `${trouble * 100}%` }} />
                        </div>
                        <span className="risk-num">{(trouble * 100).toFixed(0)}%</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="note">Risk is water + OB + trees on the club's own best line.</p>
          </section>

          <section className="card">
            <h3>{club.name} dispersion</h3>
            <p className="note">
              Sweep these and watch the recommendation. If the aim point holds still across a
              plausible range, the model does not need to be precise to be useful.
            </p>
            <Slider
              label="Carry"
              value={club.meanCarry}
              min={120}
              max={300}
              step={1}
              onChange={(v) => editSelected({ meanCarry: v })}
              format={(v) => `${v.toFixed(0)} y`}
            />
            <Slider
              label="Lateral σ"
              value={club.lateralSigmaPct}
              min={0.02}
              max={0.14}
              step={0.002}
              onChange={(v) => editSelected({ lateralSigmaPct: v })}
              format={(v) => `${(v * 100).toFixed(1)}% (±${(v * club.meanCarry).toFixed(0)}y)`}
            />
            <Slider
              label="Carry σ"
              value={club.carrySigmaPct}
              min={0.02}
              max={0.12}
              step={0.002}
              onChange={(v) => editSelected({ carrySigmaPct: v })}
              format={(v) => `${(v * 100).toFixed(1)}% (±${(v * club.meanCarry).toFixed(0)}y)`}
            />
            <Slider
              label="Lateral bias"
              value={club.lateralBiasPct}
              min={-0.08}
              max={0.08}
              step={0.002}
              onChange={(v) => editSelected({ lateralBiasPct: v })}
              format={(v) =>
                Math.abs(v) < 0.0011
                  ? 'centred'
                  : `${Math.abs(v * club.meanCarry).toFixed(0)}y ${v < 0 ? 'left' : 'right'}`
              }
            />
            <Slider
              label="Mishit weight"
              value={club.mishitWeight}
              min={0}
              max={0.3}
              step={0.005}
              onChange={(v) => editSelected({ mishitWeight: v })}
              format={(v) => `${(v * 100).toFixed(1)}% of shots`}
              hint="Spec §4.1: the tail is what decides whether to bail out."
            />
            <Slider
              label="Mishit σ multiplier"
              value={club.mishitSigmaMult}
              min={1}
              max={4}
              step={0.05}
              onChange={(v) => editSelected({ mishitSigmaMult: v })}
              format={(v) => `${v.toFixed(2)}×`}
            />
            <Slider
              label="Mishit bias"
              value={club.mishitLateralBiasPct}
              min={-0.15}
              max={0.15}
              step={0.005}
              onChange={(v) => editSelected({ mishitLateralBiasPct: v })}
              format={(v) =>
                Math.abs(v) < 0.003
                  ? 'two-way miss'
                  : `${Math.abs(v * club.meanCarry).toFixed(0)}y ${v < 0 ? 'left' : 'right'}`
              }
            />
            <Slider
              label="Roll out"
              value={club.rollFairway}
              min={0}
              max={40}
              step={1}
              onChange={(v) => editSelected({ rollFairway: v })}
              format={(v) => `${v.toFixed(0)} y on fairway`}
            />
            <button className="reset" onClick={() => setBag(cloneBag(DEFAULT_BAG))}>
              Reset bag
            </button>
          </section>

          <section className="card">
            <h3>Cost model</h3>
            <Slider
              label="Skill factor"
              value={skillFactor}
              min={1}
              max={1.5}
              step={0.01}
              onChange={setSkillFactor}
              format={(v) => `${v.toFixed(2)}× over scratch`}
              hint="Scales strokes above 1. Spec §7(b): the optimizer should cost recovery at your ability, not the Tour's."
            />
            <Slider
              label="Samples per aim line"
              value={samples}
              min={500}
              max={8000}
              step={500}
              onChange={setSamples}
              format={(v) => v.toFixed(0)}
              hint="Shared across every candidate, so the curve stays smooth even at low counts."
            />
          </section>
        </div>
      </div>
    </div>
  );
}
