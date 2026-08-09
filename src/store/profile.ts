import { DEFAULT_QUESTIONNAIRE, deriveBag, type Questionnaire } from '../model/questionnaire';
import type { Shot } from '../model/shots';
import type { ClubParams } from '../model/types';

/**
 * The player: their questionnaire answers, the bag derived from them, and
 * every shot they have logged. Local-first like courses (spec 2).
 */

const KEY = 'gco.profile.v1';

export interface Profile {
  /** Null until onboarding is completed -- the app should say so rather than pretend. */
  questionnaire: Questionnaire | null;
  bag: ClubParams[];
  shots: Shot[];
}

function fallback(): Profile {
  return { questionnaire: null, bag: deriveBag(DEFAULT_QUESTIONNAIRE).clubs, shots: [] };
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback();
    const parsed = JSON.parse(raw) as Partial<Profile>;
    return {
      questionnaire: parsed.questionnaire ?? null,
      bag: parsed.bag?.length ? parsed.bag : fallback().bag,
      shots: parsed.shots ?? [],
    };
  } catch {
    return fallback();
  }
}

export function saveProfile(p: Profile): Profile {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch (err) {
    console.error('Could not persist profile', err);
  }
  return p;
}

export function applyQuestionnaire(p: Profile, q: Questionnaire): Profile {
  // Answers replace the derived parameters, but never the logged shots --
  // observations always outrank inference.
  return saveProfile({ ...p, questionnaire: q, bag: deriveBag(q).clubs });
}

export function addShot(p: Profile, shot: Shot): Profile {
  return saveProfile({ ...p, shots: [...p.shots, shot] });
}

export function removeShot(p: Profile, id: string): Profile {
  return saveProfile({ ...p, shots: p.shots.filter((s) => s.id !== id) });
}

export function exportProfile(p: Profile): string {
  return JSON.stringify(p, null, 2);
}
