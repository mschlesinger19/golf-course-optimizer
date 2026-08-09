import { useMemo, useState } from 'react';
import {
  DEFAULT_CLUBS,
  DEFAULT_QUESTIONNAIRE,
  FAMILY_LABEL,
  deriveBag,
  type BagClub,
  type MissShape,
  type Questionnaire,
} from '../model/questionnaire';
import { buildPattern, SHRINKAGE_K } from '../model/shots';
import type { ClubFamily } from '../model/types';
import type { Profile } from '../store/profile';
import { Slider } from '../ui/Slider';

export interface BagProps {
  profile: Profile;
  onApply: (q: Questionnaire) => void;
  onClearShots: () => void;
}

const FAMILIES: ClubFamily[] = [
  'driver',
  'wood',
  'hybrid',
  'long_iron',
  'mid_iron',
  'short_iron',
  'wedge',
];

/** Reasonable family for a carry, used when adding a club. */
function familyForCarry(carry: number): ClubFamily {
  if (carry >= 235) return 'driver';
  if (carry >= 205) return 'wood';
  if (carry >= 190) return 'hybrid';
  if (carry >= 175) return 'long_iron';
  if (carry >= 150) return 'mid_iron';
  if (carry >= 128) return 'short_iron';
  return 'wedge';
}

export function Bag({ profile, onApply, onClearShots }: BagProps) {
  const [q, setQ] = useState<Questionnaire>(profile.questionnaire ?? DEFAULT_QUESTIONNAIRE);
  const derived = useMemo(() => deriveBag(q), [q]);
  const dirty = JSON.stringify(q) !== JSON.stringify(profile.questionnaire);

  const patterns = useMemo(
    () => derived.clubs.map((c) => ({ id: c.id, pattern: buildPattern(profile.shots, c, derived.clubs) })),
    [derived.clubs, profile.shots],
  );

  const set = <K extends keyof Questionnaire>(k: K, v: Questionnaire[K]) =>
    setQ((prev) => ({ ...prev, [k]: v }));

  const patchClub = (id: string, patch: Partial<BagClub>) =>
    set('clubs', q.clubs.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const addClub = () => {
    const carry = 150;
    let id = 'club-1';
    let n = 1;
    while (q.clubs.some((c) => c.id === id)) id = `club-${++n}`;
    set('clubs', [
      ...q.clubs,
      { id, name: 'New club', family: familyForCarry(carry), carry, inBag: true },
    ]);
  };

  const removeClub = (id: string) => set('clubs', q.clubs.filter((c) => c.id !== id));

  const shotsFor = (id: string) => profile.shots.filter((s) => s.clubId === id).length;

  return (
    <div className="play">
      {!profile.questionnaire && (
        <div className="banner">
          <strong>Your bag is still a placeholder.</strong> Set your real clubs and carries below,
          answer the five questions, and hit Apply. Until then the dispersion numbers are ones I
          made up, per spec §12 open #3.
        </div>
      )}

      <section className="card">
        <h3>Your clubs</h3>
        <p className="note">
          Carry is what you hit it when you catch it well — it is treated as your 75th percentile,
          not your average, and adjusted down silently. Family decides which clubs share logged
          shots when one of them has too few of its own.
        </p>

        <table className="club-table bag-editor">
          <thead>
            <tr>
              <th>in</th>
              <th>club</th>
              <th>family</th>
              <th>carry</th>
              <th>shots</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.clubs.map((c) => (
              <tr key={c.id} className={c.inBag ? '' : 'out'}>
                <td>
                  <input
                    type="checkbox"
                    checked={c.inBag}
                    onChange={(e) => patchClub(c.id, { inBag: e.target.checked })}
                    aria-label={`${c.name} in bag`}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={c.name}
                    onChange={(e) => patchClub(c.id, { name: e.target.value })}
                    className="club-name"
                  />
                </td>
                <td>
                  <select
                    value={c.family}
                    onChange={(e) => patchClub(c.id, { family: e.target.value as ClubFamily })}
                  >
                    {FAMILIES.map((f) => (
                      <option key={f} value={f}>{FAMILY_LABEL[f]}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    min={30}
                    max={360}
                    value={c.carry}
                    onChange={(e) => patchClub(c.id, { carry: Number(e.target.value) })}
                  />
                </td>
                <td className="risk-num">{shotsFor(c.id) || '—'}</td>
                <td>
                  <button
                    className="chip"
                    onClick={() => {
                      const n = shotsFor(c.id);
                      if (
                        n === 0 ||
                        confirm(
                          `${c.name} has ${n} logged shot${n === 1 ? '' : 's'}. Removing the club ` +
                            `keeps the shots but they will no longer pool with anything. Continue?`,
                        )
                      ) {
                        removeClub(c.id);
                      }
                    }}
                    aria-label={`Remove ${c.name}`}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="play-actions" style={{ marginTop: 10 }}>
          <button onClick={addClub}>Add club</button>
          <button onClick={() => set('clubs', DEFAULT_CLUBS)}>Reset to a common set</button>
        </div>
      </section>

      <section className="card">
        <h3>How you play</h3>
        <p className="note">
          Spec §5: nothing here asks for a spread or an average, because golfers report their best
          shot as their average. Counts and directions are reported accurately.
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
              <button key={m} className={q.miss === m ? 'chip on' : 'chip'} onClick={() => set('miss', m)}>
                {m === 'two-way' ? 'two-way' : `one-way ${m}`}
              </button>
            ))}
          </div>
          <span className="slider-hint">Large effect on recommended aim points.</span>
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
            <tr><th>club</th><th>mean carry</th><th>lateral σ</th><th>from logged</th></tr>
          </thead>
          <tbody>
            {derived.clubs.map((c) => {
              const p = patterns.find((x) => x.id === c.id)?.pattern;
              return (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.meanCarry}y</td>
                  <td>
                    {(c.lateralSigmaPct * 100).toFixed(1)}%
                    <span className="risk-num"> ±{(c.lateralSigmaPct * c.meanCarry).toFixed(0)}y</span>
                  </td>
                  <td>
                    {p && p.pool.length > 0 ? (
                      <>
                        <div
                          className="mini-bar"
                          title={`${p.ownCount} own + ${p.familyCount} family shots`}
                        >
                          <span style={{ width: `${p.realWeight * 100}%`, background: '#5aa86a' }} />
                        </div>
                        <span className="risk-num">{(p.realWeight * 100).toFixed(0)}%</span>
                      </>
                    ) : (
                      <span className="risk-num">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="note">
          The green bar is how much of each club's pattern comes from shots you actually hit rather
          than from the answers above. Spec §4.2's n/(n+k) with k={SHRINKAGE_K}, so a club trusts
          its own data half the time at {SHRINKAGE_K} shots. Family shots count for about a third
          of one of the club's own.
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
          The answers are yours; the mapping from answers to parameters is mine. Every constant in
          it is a modelling assumption rather than a citation — they are gathered as
          <code> ASSUMPTIONS</code> in <code>questionnaire.ts</code>. Logged shots overwrite all of
          this, which is the point of logging them.
        </p>
      </section>

      <section className="card">
        <h3>Logged shots</h3>
        {profile.shots.length === 0 ? (
          <p className="note">
            None yet. Log them from the Play page: set the ball, drag the target, hit the shot,
            then tap where it finished.
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
