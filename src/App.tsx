import { useEffect, useState } from 'react';
import { buildDemoCourse } from './data/demoCourse';
import type { GeoCourse } from './model/course';
import { PROVISIONAL_BASELINE } from './model/expectedStrokes';
import type { Questionnaire } from './model/questionnaire';
import type { Shot } from './model/shots';
import { Bag } from './pages/Bag';
import { Lab } from './pages/Lab';
import { Play } from './pages/Play';
import { Trace } from './pages/Trace';
import { deleteCourse, loadCourses, upsertCourse } from './store/courses';
import { addShot, applyQuestionnaire, loadProfile, saveProfile, type Profile } from './store/profile';
import { Slider } from './ui/Slider';
import type { TileSourceKey } from './ui/MapView';

type Tab = 'play' | 'trace' | 'bag' | 'lab';

const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: 'play', label: 'Play', blurb: 'Drag a target, price it' },
  { id: 'trace', label: 'Trace', blurb: 'Draw the course' },
  { id: 'bag', label: 'Bag', blurb: 'How you actually play' },
  { id: 'lab', label: 'Lab', blurb: 'Sweep the model' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const h = window.location.hash.replace('#', '');
    return h === 'trace' || h === 'lab' || h === 'bag' ? h : 'play';
  });
  const [courses, setCourses] = useState<GeoCourse[]>(() => loadCourses());
  const [profile, setProfile] = useState<Profile>(() => loadProfile());
  const [tileSource, setTileSource] = useState<TileSourceKey>('naip');
  const [skillFactor, setSkillFactor] = useState(1.15);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    window.location.hash = tab;
  }, [tab]);

  const handleSave = (c: GeoCourse) => setCourses(upsertCourse(c));
  const handleDelete = (id: string) => setCourses(deleteCourse(id));
  const handleLoadDemo = () => setCourses(upsertCourse(buildDemoCourse()));
  const handleLogShot = (s: Shot) => setProfile((p) => addShot(p, s));
  const handleQuestionnaire = (q: Questionnaire) => setProfile((p) => applyQuestionnaire(p, q));
  const handleClearShots = () => setProfile((p) => saveProfile({ ...p, shots: [] }));

  return (
    <div className="app">
      <header className="app-head">
        <div>
          <h1>Golf course optimizer</h1>
          <p className="sub">{TABS.find((t) => t.id === tab)?.blurb}</p>
        </div>
        <button className="chip" onClick={() => setShowSettings((s) => !s)}>settings</button>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'tab on' : 'tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {showSettings && (
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
          {PROVISIONAL_BASELINE && (
            <p className="note warn">
              The expected-strokes table is still an invented placeholder (spec §12 open #4).
              Club dispersion comes from your answers on the <strong>Bag</strong> page, and from
              logged shots once they exist.
            </p>
          )}
        </section>
      )}

      {tab === 'play' && (
        <Play
          courses={courses}
          profile={profile}
          onLogShot={handleLogShot}
          onLoadDemo={handleLoadDemo}
          tileSource={tileSource}
          onTileSource={setTileSource}
          skillFactor={skillFactor}
        />
      )}
      {tab === 'trace' && (
        <Trace
          courses={courses}
          onLoadDemo={handleLoadDemo}
          onSave={handleSave}
          onDelete={handleDelete}
          tileSource={tileSource}
          onTileSource={setTileSource}
        />
      )}
      {tab === 'bag' && (
        <Bag profile={profile} onApply={handleQuestionnaire} onClearShots={handleClearShots} />
      )}
      {tab === 'lab' && <Lab />}
    </div>
  );
}
