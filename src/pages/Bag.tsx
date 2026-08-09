import { useMemo, useState } from 'react';
import {
  DEFAULT_QUESTIONNAIRE,
  deriveBag,
  type MissShape,
  type Questionnaire,
} from '../model/questionnaire';
import { buildPattern, SHRINKAGE_K } from '../model/shots';
import type { Profile } from '../store/profile';
import { Slider } from '../ui/Slider';

export interface BagProps {
  profile: Profile;
  onApply: (q: Questionnaire) => void;
  onClearShots: () => void;
}

/**
 * Onboarding and data status.
 *
 * The point of the questionnaire is that its answers are *yours*, so the bag
 * stops being invented. The page is explicit about which parts of the result
 * were inferred and on what assumption, because the inference is mine even
 * when the answers are not.
 */
export function Bag({ profile, onApply, onClearShots }: BagProps) {
  const [q, setQ] = useState<Questionnaire>(profile.questionnaire ?? DEFAULT_QUESTIONNAIRE);
  const derived = useMemo(() => deriveBag(q), [q]);
  const dirty = JSON.stringify(q) !== JSON.stringify(profile.questionnaire);

  const patterns = useMemo(
    () => profile.bag.map((c) => ({ club: c, pattern: buildPattern(profile.shots, c.id) })),
    [profile.bag, profile.shots],
  );

  const set = <K extends keyof Questionnaire>(k: K, v: Questionnaire[K]) =>
    setQ((prev) => ({ ...prev, [k]: v }));

  return (
    <div className="play">
      {!profile.questionnaire && (
        <div className="banner">
          <strong>Your bag is still invented.</strong> Nothing below describes how you actually
          play until you answer these and hit Apply. Until then the dispersion numbers are
          placeholders I made up, per spec §12 open #3.
        </div>
      )}

      <section className="card">
        <h3>How you play</h3>
        <p className="note">
          Spec §5: no question here asks for a spread or an average, because golfers report
          their best shot as their average. Counts and directions are reported accurately.
        </p>

        <Slider
          label="Fairways hit, out of 14"
          value={q.fairwaysHit}
          min={0}
          max={14}
          step={1}
          onChange={(v) => set('fairwaysHit', v)}
          format={(v) => `${v} / 14`}
        />
        <Slider
          label="Greens in regulation, out of 18"
          value={q.greensInRegulation}
          min={0}
          max={18}
          step={1}
          onChange={(v) => set('greensInRegulation', v)}
          format={(v) => `${v} / 18`}
        />
        <Slider
          label="Penalty or OB strokes in a typical round"
          value={q.penaltiesPerRound}
          min={0}
          max={6}
          step={0.5}
          onChange={(v) => set('penaltiesPerRound', v)}
          format={(v) => `${v}`}
          hint="Sets the mishit weight, which is otherwise unrecoverable from aggregate stats."
        />
        <Slider
          label="Flush a 7-iron vs catch it thin — yardage gap"
          value={q.flushThinGapYards}
          min={5}
          max={50}
          step={1}
          onChange={(v) => set('flushThinGapYards', v)}
          format={(v) => `${v} y`}
          hint="People answer this far better than they answer for a mean or a spread."
        />

        <div className="slider">
          <span className="slider-head">
            <span className="slider-label">Is your miss one-way or two-way?</span>
          </span>
          <div className="mode-row">
            {(['left', 'two-way', 'right'] as MissShape[]).map((m) => (
              <button
                key={m}
                className={q.miss === m ? 'chip on' : 'chip'}
                onClick={() => set('miss', m)}
              >
                {m === 'two-way' ? 'two-way' : `one-way ${m}`}
              </button>
            ))}
          </div>
          <span className="slider-hint">Large effect on recommended aim points.</span>
        </div>

        <h3 style={{ marginTop: 18 }}>Carries</h3>
        <p className="note">
          Give the number you hit when you catch it well. It is treated as your 75th
          percentile, not your average, and adjusted down silently.
        </p>
        <div className="carry-grid">
          {Object.keys(DEFAULT_QUESTIONNAIRE.carries).map((id) => (
            <label key={id}>
              <span>{id}</span>
              <input
                type="number"
                min={60}
                max={340}
                value={q.carries[id] ?? 0}
                onChange={(e) => set('carries', { ...q.carries, [id]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>

        <div className="play-actions" style={{ marginTop: 14 }}>
          <button onClick={() => onApply(q)} disabled={!dirty}>
            {dirty ? 'Apply to bag' : 'Applied'}
          </button>
          <button onClick={() => setQ(DEFAULT_QUESTIONNAIRE)}>Reset answers</button>
        </div>
      </section>

      <section className="card">
        <h3>What that implies</h3>
        <table className="club-table">
          <thead>
            <tr><th>club</th><th>mean carry</th><th>lateral σ</th><th>logged</th></tr>
          </thead>
          <tbody>
            {derived.clubs.map((c) => {
              const p = patterns.find((x) => x.club.id === c.id)?.pattern;
              return (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.meanCarry}y</td>
                  <td>
                    {(c.lateralSigmaPct * 100).toFixed(1)}%
                    <span className="risk-num"> ±{(c.lateralSigmaPct * c.meanCarry).toFixed(0)}y</span>
                  </td>
                  <td>
                    {p ? (
                      <>
                        {p.ownCount}
                        {p.familyCount > 0 && <span className="risk-num"> +{p.familyCount} fam</span>}
                        <div className="mini-bar" title={`${(p.realWeight * 100).toFixed(0)}% of the pattern comes from logged shots`}>
                          <span style={{ width: `${p.realWeight * 100}%`, background: '#5aa86a' }} />
                        </div>
                      </>
                    ) : (
                      '0'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="note">
          The green bar is how much of each club's pattern comes from shots you actually hit,
          rather than from the answers above. It follows spec §4.2's n/(n+k) shrinkage with
          k={SHRINKAGE_K}, so a club trusts its own data half the time at {SHRINKAGE_K} shots.
          Family shots count for a third of one of the club's own.
        </p>
      </section>

      <section className="card">
        <h3>How each number was reached</h3>
        <ul className="derivation">
          {derived.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
        <p className="note warn">
          The answers are yours; the mapping from answers to parameters is mine. Every constant
          in it is a modelling assumption rather than a citation — they are gathered as
          <code> ASSUMPTIONS</code> in <code>questionnaire.ts</code>. Logged shots overwrite all
          of this, which is the point of logging them.
        </p>
      </section>

      <section className="card">
        <h3>Logged shots</h3>
        {profile.shots.length === 0 ? (
          <p className="note">
            None yet. Log them from the Play page: set the ball, drag the target, hit the shot,
            then tap where it finished. Each one stores the ratio of actual to intended distance
            and the offline angle — both dimensionless, so a shot logged at 150y informs the
            pattern drawn at 200y.
          </p>
        ) : (
          <>
            <p className="note">
              {profile.shots.length} shot{profile.shots.length === 1 ? '' : 's'} recorded.
            </p>
            <div className="play-actions">
              <button
                onClick={() => {
                  if (confirm(`Delete all ${profile.shots.length} logged shots?`)) onClearShots();
                }}
              >
                Clear shot history
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
