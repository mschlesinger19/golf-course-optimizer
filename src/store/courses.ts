import { emptyCourse, type GeoCourse } from '../model/course';

/**
 * Local-first course storage.
 *
 * Spec 2 makes offline non-negotiable: cell coverage on courses is unreliable
 * and the app is useless if it cannot compute an aim point without signal.
 * Everything lives in localStorage and nothing here talks to a network. When
 * Supabase arrives it syncs *from* this, not the other way round.
 */

const KEY = 'gco.courses.v1';

export function loadCourses(): GeoCourse[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GeoCourse[]) : [];
  } catch {
    // A corrupt blob should not brick the app on the first tee.
    return [];
  }
}

export function saveCourses(courses: GeoCourse[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(courses));
  } catch (err) {
    console.error('Could not persist courses', err);
  }
}

export function upsertCourse(course: GeoCourse): GeoCourse[] {
  const stamped = { ...course, updatedAt: new Date().toISOString() };
  const all = loadCourses();
  const i = all.findIndex((c) => c.id === stamped.id);
  if (i >= 0) all[i] = stamped;
  else all.push(stamped);
  saveCourses(all);
  return all;
}

export function deleteCourse(id: string): GeoCourse[] {
  const all = loadCourses().filter((c) => c.id !== id);
  saveCourses(all);
  return all;
}

export function createCourse(name: string, holeCount: number): GeoCourse {
  return emptyCourse(name || 'Untitled course', holeCount);
}

/** Round-trippable export. KML export (spec 9) is not built yet. */
export function exportCourse(course: GeoCourse): string {
  return JSON.stringify(course, null, 2);
}

export function importCourse(json: string): GeoCourse {
  const parsed = JSON.parse(json) as GeoCourse;
  if (!parsed || !Array.isArray(parsed.holes)) {
    throw new Error('Not a course file: missing holes array');
  }
  return parsed;
}
