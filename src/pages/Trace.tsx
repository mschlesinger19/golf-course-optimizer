import L from 'leaflet';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  centerlineYardage,
  isPlayable,
  type GeoCourse,
  type GeoFeature,
  type GeoHole,
} from '../model/course';
import type { LatLng } from '../model/projection';
import type { FeatureType } from '../model/types';
import { FEATURE_STYLE, MapView, type TileSourceKey } from '../ui/MapView';
import { createCourse, exportCourse, importCourse } from '../store/courses';
import { OsmImport } from '../ui/OsmImport';

type Mode = 'tee' | 'green' | 'pin' | 'centerline' | 'polygon';

/**
 * Feature palette, ordered by the per-hole workflow spec 9 asks for --
 * tee, fairway, hazards, green -- so that working straight down the list
 * leaves nothing untraced.
 *
 * `rough` is deliberately absent. Spec 3.1: rough is implicit, anything in the
 * corridor that is not another feature. Tracing it explicitly is wasted work
 * unless a hole genuinely has a heavy/light distinction worth modelling.
 */
const PALETTE: { type: FeatureType; label: string }[] = [
  { type: 'fairway', label: 'Fairway' },
  { type: 'bunker', label: 'Bunker' },
  { type: 'water', label: 'Water' },
  { type: 'trees', label: 'Trees' },
  { type: 'ob', label: 'OB' },
  { type: 'green', label: 'Green' },
  { type: 'tee', label: 'Tee box' },
];

export interface TraceProps {
  courses: GeoCourse[];
  onLoadDemo: () => void;
  onSave: (c: GeoCourse) => void;
  onDelete: (id: string) => void;
  tileSource: TileSourceKey;
  onTileSource: (k: TileSourceKey) => void;
}

export function Trace({ courses, onLoadDemo, onSave, onDelete, tileSource, onTileSource }: TraceProps) {
  const [courseId, setCourseId] = useState(courses[0]?.id ?? '');
  const course = courses.find((c) => c.id === courseId) ?? courses[0];
  const [holeNumber, setHoleNumber] = useState(1);
  const [mode, setMode] = useState<Mode>('tee');
  const [featureType, setFeatureType] = useState<FeatureType>('fairway');
  const [draft, setDraft] = useState<LatLng[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const hole: GeoHole | undefined =
    course?.holes.find((h) => h.number === holeNumber) ?? course?.holes[0];

  const patchHole = useCallback(
    (patch: Partial<GeoHole>) => {
      if (!course || !hole) return;
      const holes = course.holes.map((h) => (h.number === hole.number ? { ...h, ...patch } : h));
      onSave({ ...course, holes });
    },
    [course, hole, onSave],
  );

  const handleClick = useCallback(
    (p: LatLng) => {
      if (!hole) return;
      switch (mode) {
        case 'tee':
          patchHole({ tee: p });
          setStatus('Tee set. Switch to Green next.');
          break;
        case 'green':
          patchHole({ green: p });
          setStatus('Green centre set.');
          break;
        case 'pin':
          patchHole({ pin: p });
          setStatus('Pin set for this round.');
          break;
        case 'centerline':
        case 'polygon':
          setDraft((d) => [...d, p]);
          break;
      }
    },
    [mode, hole, patchHole],
  );

  const commitDraft = () => {
    if (!hole) return;
    if (mode === 'centerline') {
      if (draft.length < 2) {
        setStatus('A centreline needs at least two points.');
        return;
      }
      patchHole({ centerline: draft });
      setStatus(`Centreline saved (${draft.length} points).`);
    } else {
      if (draft.length < 3) {
        setStatus('A polygon needs at least three vertices.');
        return;
      }
      const feature: GeoFeature = {
        id: `${featureType}-${hole.features.length + 1}-${draft.length}`,
        type: featureType,
        ring: draft,
        label: PALETTE.find((p) => p.type === featureType)?.label,
      };
      patchHole({ features: [...hole.features, feature] });
      setStatus(`${feature.label} saved.`);
    }
    setDraft([]);
  };

  // Draft geometry and the placed points.
  const handleReady = useCallback((_m: L.Map, overlay: L.LayerGroup) => {
    overlayRef.current = overlay;
  }, []);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !hole) return;
    overlay.clearLayers();

    const mark = (p: LatLng, color: string, label: string) =>
      L.circleMarker([p.lat, p.lng], {
        radius: 6,
        color: '#0b0f0c',
        weight: 2,
        fillColor: color,
        fillOpacity: 1,
      })
        .bindTooltip(label, { permanent: false })
        .addTo(overlay);

    if (hole.tee) mark(hole.tee, '#ffffff', 'Tee');
    if (hole.green) mark(hole.green, '#8ddf94', 'Green centre');
    if (hole.pin) mark(hole.pin, '#ff5b5b', 'Pin');
    if (hole.centerline.length > 1) {
      L.polyline(hole.centerline.map((p) => [p.lat, p.lng] as [number, number]), {
        color: '#ffffff',
        weight: 2,
        opacity: 0.5,
        dashArray: '6 6',
      }).addTo(overlay);
    }

    if (draft.length > 0) {
      const pts = draft.map((p) => [p.lat, p.lng] as [number, number]);
      const style = FEATURE_STYLE[featureType];
      if (mode === 'polygon' && draft.length >= 3) {
        L.polygon(pts, {
          color: style.color,
          fillColor: style.fill,
          fillOpacity: 0.35,
          weight: 2,
          dashArray: '4 4',
        }).addTo(overlay);
      } else {
        L.polyline(pts, { color: style.color, weight: 2, dashArray: '4 4' }).addTo(overlay);
      }
      draft.forEach((p, i) =>
        L.circleMarker([p.lat, p.lng], {
          radius: 4,
          color: '#ffffff',
          weight: 1,
          fillColor: style.color,
          fillOpacity: 1,
        })
          .bindTooltip(`${i + 1}`)
          .addTo(overlay),
      );
    }
  }, [hole, draft, mode, featureType]);

  const doExport = () => {
    if (!course) return;
    const blob = new Blob([exportCourse(course)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${course.name.replace(/\s+/g, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = (file: File) => {
    file
      .text()
      .then((t) => {
        const imported = importCourse(t);
        onSave(imported);
        setCourseId(imported.id);
        setStatus(`Imported ${imported.name}.`);
      })
      .catch((e) => setStatus(`Import failed: ${(e as Error).message}`));
  };

  const center: LatLng = hole?.tee ?? hole?.green ?? { lat: 39.8283, lng: -98.5795 };
  const fitTo = useMemo(
    () => [hole?.tee, hole?.green].filter(Boolean) as LatLng[],
    [hole?.tee, hole?.green],
  );

  if (!course) {
    return (
      <div className="card empty">
        <h2>No courses yet</h2>
        <p className="note">
          Spec §9 treats the tracer as the primary geometry path — OSM coverage is patchy and
          private clubs are systematically the gap, so assume any course needs tracing.
        </p>
        <NewCourse onCreate={(c) => { onSave(c); setCourseId(c.id); }} />
        <div className="play-actions">
          <button onClick={onLoadDemo}>Load the synthetic demo hole</button>
        </div>
        <OsmImport onImport={(c) => { onSave(c); setCourseId(c.id); }} />
      </div>
    );
  }

  return (
    <div className="trace">
      <div className="play-bar">
        <select value={course.id} onChange={(e) => setCourseId(e.target.value)}>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select value={holeNumber} onChange={(e) => { setHoleNumber(Number(e.target.value)); setDraft([]); }}>
          {course.holes.map((h) => (
            <option key={h.id} value={h.number}>
              Hole {h.number}{isPlayable(h) ? ' ✓' : ''}
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
        center={center}
        zoom={hole?.tee ? 17 : 4}
        features={hole?.features ?? []}
        fitTo={fitTo.length > 0 ? fitTo : undefined}
        tileSource={tileSource}
        onMapClick={handleClick}
        onReady={handleReady}
      />

      <div className="mode-row">
        {(['tee', 'green', 'pin', 'centerline', 'polygon'] as Mode[]).map((m) => (
          <button
            key={m}
            className={mode === m ? 'chip on' : 'chip'}
            onClick={() => { setMode(m); setDraft([]); }}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === 'polygon' && (
        <div className="mode-row">
          {PALETTE.map((p) => (
            <button
              key={p.type}
              className={featureType === p.type ? 'chip on' : 'chip'}
              style={featureType === p.type ? { borderColor: FEATURE_STYLE[p.type].color } : undefined}
              onClick={() => setFeatureType(p.type)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {(mode === 'polygon' || mode === 'centerline') && (
        <div className="play-actions">
          <button onClick={commitDraft} disabled={draft.length < (mode === 'polygon' ? 3 : 2)}>
            Finish {mode === 'polygon' ? featureType : 'centreline'} ({draft.length})
          </button>
          <button onClick={() => setDraft((d) => d.slice(0, -1))} disabled={draft.length === 0}>
            Undo vertex
          </button>
          <button onClick={() => setDraft([])} disabled={draft.length === 0}>Clear</button>
        </div>
      )}

      {status && <p className="note">{status}</p>}

      {hole && (
        <section className="card">
          <h3>Hole {hole.number}</h3>
          <div className="hole-meta">
            <label>
              par
              <input
                type="number"
                min={3}
                max={6}
                value={hole.par}
                onChange={(e) => patchHole({ par: Number(e.target.value) })}
              />
            </label>
            <span className="note">
              {hole.tee ? 'tee ✓' : 'tee ✗'} · {hole.green ? 'green ✓' : 'green ✗'} ·{' '}
              {hole.pin ? 'pin ✓' : 'pin from centre'} ·{' '}
              {centerlineYardage(hole) ? `${centerlineYardage(hole)}y` : 'no yardage'}
            </span>
          </div>

          {hole.features.length === 0 ? (
            <p className="note">
              No polygons yet. Anything you do not trace resolves to rough, which is the intended
              behaviour — trace the fairway, the green and whatever can actually cost you a stroke.
            </p>
          ) : (
            <table className="club-table">
              <thead>
                <tr><th>feature</th><th>pts</th><th>penalty mod</th><th /></tr>
              </thead>
              <tbody>
                {hole.features.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <span className="dot" style={{ background: FEATURE_STYLE[f.type].fill }} />
                      {f.label ?? f.type}
                    </td>
                    <td>{f.ring.length}</td>
                    <td>
                      <input
                        type="number"
                        step={0.05}
                        value={f.penaltyModifier ?? 0}
                        onChange={(e) =>
                          patchHole({
                            features: hole.features.map((g) =>
                              g.id === f.id ? { ...g, penaltyModifier: Number(e.target.value) } : g,
                            ),
                          })
                        }
                      />
                    </td>
                    <td>
                      <button
                        className="chip"
                        onClick={() =>
                          patchHole({ features: hole.features.filter((g) => g.id !== f.id) })
                        }
                      >
                        delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="note">
            Penalty modifier is the local-knowledge field from spec §3.1 — a flat fairway bunker
            you can advance a mid-iron from and a lipped-out greenside bunker are both
            <em> bunker</em> and differ by most of a stroke. Positive means harder.
          </p>
        </section>
      )}

      <section className="card">
        <h3>Course</h3>
        <div className="play-actions">
          <button onClick={doExport}>Export JSON</button>
          <button onClick={() => fileRef.current?.click()}>Import JSON</button>
          <button
            onClick={() => {
              if (confirm(`Delete "${course.name}" and all its traced geometry?`)) {
                onDelete(course.id);
                setCourseId('');
              }
            }}
          >
            Delete course
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])}
          />
        </div>
        <label className="slider">
          <span className="slider-head"><span className="slider-label">imagery vintage note</span></span>
          <input
            type="text"
            placeholder="e.g. NAIP 2023 — bunkers renovated 2024, check 7th"
            value={course.imageryNote ?? ''}
            onChange={(e) => onSave({ ...course, imageryNote: e.target.value })}
          />
          <span className="slider-hint">
            Spec §9: a flyover predating a renovation produces confidently wrong polygons.
          </span>
        </label>
        <NewCourse onCreate={(c) => { onSave(c); setCourseId(c.id); }} />
      </section>

      <OsmImport onImport={(c) => { onSave(c); setCourseId(c.id); }} />
    </div>
  );
}

function NewCourse({ onCreate }: { onCreate: (c: GeoCourse) => void }) {
  const [name, setName] = useState('');
  const [holes, setHoles] = useState(18);
  return (
    <div className="play-actions">
      <input
        type="text"
        placeholder="New course name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        type="number"
        min={1}
        max={18}
        value={holes}
        onChange={(e) => setHoles(Number(e.target.value))}
        style={{ width: 70 }}
      />
      <button onClick={() => name.trim() && onCreate(createCourse(name.trim(), holes))}>
        Create
      </button>
    </div>
  );
}
