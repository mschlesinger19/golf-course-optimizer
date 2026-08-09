import { useState } from 'react';
import type { GeoCourse } from '../model/course';
import type { ImportResult } from '../model/osm';
import { fetchGolfCourse, searchPlaces, type PlaceHit } from '../store/osmFetch';

export interface OsmImportProps {
  onImport: (c: GeoCourse) => void;
}

/**
 * Import a course from OpenStreetMap, spec section 9's second path.
 *
 * Two ways in, because both fail differently: search by name works from the
 * sofa the night before, and "I'm standing on it" works when you did not think
 * to do that. Whatever comes back lands in the tracer as editable geometry.
 */
export function OsmImport({ onImport }: OsmImportProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PlaceHit[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(ImportResult & { name: string }) | null>(null);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const doSearch = () =>
    run('Searching…', async () => {
      setHits(null);
      setResult(null);
      const found = await searchPlaces(query.trim());
      setHits(found);
      if (found.length === 0) {
        setError(`Nothing matched "${query.trim()}". Try adding the town or state.`);
      }
    });

  const importAt = (lat: number, lng: number, name: string) =>
    run('Fetching geometry…', async () => {
      const r = await fetchGolfCourse(lat, lng, name);
      setResult({ ...r, name });
      setHits(null);
    });

  const useLocation = () =>
    run('Locating…', async () => {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error('This browser exposes no geolocation API.'));
          return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
        });
      });
      await importAt(pos.coords.latitude, pos.coords.longitude, query.trim() || 'Course here');
    });

  return (
    <section className="card">
      <h3>Import from OpenStreetMap</h3>
      <p className="note">
        Spec §9 keeps the tracer as the primary path — coverage is patchy and private clubs are
        systematically the gap. This is worth a try first because when it works it saves an hour.
      </p>

      <div className="play-actions">
        <input
          type="text"
          placeholder="Course name, e.g. Forest Hill Golf Club, NJ"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && query.trim() && doSearch()}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button onClick={doSearch} disabled={!query.trim() || busy !== null}>
          Search
        </button>
        <button onClick={useLocation} disabled={busy !== null}>
          I'm at the course
        </button>
      </div>

      {busy && <p className="note">{busy}</p>}
      {error && <p className="note warn">{error}</p>}

      {hits && hits.length > 0 && (
        <ul className="hit-list">
          {hits.map((h, i) => (
            <li key={i}>
              <button className="hit" onClick={() => importAt(h.lat, h.lng, h.name)} disabled={busy !== null}>
                <strong>{h.name}</strong>
                <span>{h.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {result && (
        <div className={`import-result ${result.tooThin ? 'thin' : 'ok'}`}>
          {result.course ? (
            <>
              <p>
                <strong>{result.stats.holes}</strong> holes and{' '}
                <strong>{result.stats.polygons}</strong> mapped features —{' '}
                {result.stats.perHole.toFixed(1)} per hole.
              </p>
              <ul className="derivation">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
              <div className="play-actions">
                <button onClick={() => onImport(result.course!)}>
                  Import {result.name} ({result.stats.holes} holes)
                </button>
                <button onClick={() => setResult(null)}>Discard</button>
              </div>
            </>
          ) : (
            <ul className="derivation">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
