import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** One admin's pins and visit scores, keyed by tab slug (slugs are stable; the AdminTab enum is not). */
export type AdminPageUsage = {
  pins: string[];
  visits: Record<string, { score: number; at: number }>;
};

export const MAX_PINNED_PAGES = 8;
/** A visit's weight halves every two weeks, so "most visited" follows what an admin does now. */
const VISIT_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
/** Visit history is capped so the persisted blob stays small however many tabs an admin opens. */
const MAX_TRACKED_PAGES = 40;

export const EMPTY_PAGE_USAGE: AdminPageUsage = { pins: [], visits: {} };

const decayed = (visit: { score: number; at: number }, now: number) =>
  visit.score * 0.5 ** ((now - visit.at) / VISIT_HALF_LIFE_MS);

export function withVisit(usage: AdminPageUsage, slug: string, now: number): AdminPageUsage {
  const previous = usage.visits[slug];
  const visits = { ...usage.visits, [slug]: { score: (previous ? decayed(previous, now) : 0) + 1, at: now } };
  const kept = Object.entries(visits)
    .sort(([, a], [, b]) => decayed(b, now) - decayed(a, now))
    .slice(0, MAX_TRACKED_PAGES);
  return { ...usage, visits: Object.fromEntries(kept) };
}

export function withPinToggled(usage: AdminPageUsage, slug: string): AdminPageUsage {
  if (usage.pins.includes(slug)) return { ...usage, pins: usage.pins.filter(pin => pin !== slug) };
  if (usage.pins.length >= MAX_PINNED_PAGES) return usage;
  return { ...usage, pins: [...usage.pins, slug] };
}

/** Most visited first, excluding pinned pages (they are listed separately). */
export function mostVisitedSlugs(usage: AdminPageUsage, now: number, limit: number): string[] {
  return Object.entries(usage.visits)
    .filter(([slug]) => !usage.pins.includes(slug))
    .sort(([, a], [, b]) => decayed(b, now) - decayed(a, now))
    .slice(0, limit)
    .map(([slug]) => slug);
}

type AdminPageVisitsState = {
  byUser: Record<string, AdminPageUsage>;
  recordVisit: (userId: string, slug: string) => void;
  togglePin: (userId: string, slug: string) => void;
};

/** Per-browser, per-admin page usage behind the dashboard's "Jump back in" row and the sidebar's Pinned group. */
export const useAdminPageVisits = create<AdminPageVisitsState>()(
  persist(
    set => ({
      byUser: {},
      recordVisit: (userId, slug) =>
        set(state => ({
          byUser: { ...state.byUser, [userId]: withVisit(state.byUser[userId] ?? EMPTY_PAGE_USAGE, slug, Date.now()) },
        })),
      togglePin: (userId, slug) =>
        set(state => ({
          byUser: { ...state.byUser, [userId]: withPinToggled(state.byUser[userId] ?? EMPTY_PAGE_USAGE, slug) },
        })),
    }),
    { name: 'admin-page-visits', version: 1, partialize: state => ({ byUser: state.byUser }) }
  )
);

/** The viewer's usage; a stable empty object when there is none, so selectors do not re-render in a loop. */
export const useAdminPageUsage = (userId: string | undefined): AdminPageUsage =>
  useAdminPageVisits(state => (userId ? state.byUser[userId] : undefined) ?? EMPTY_PAGE_USAGE);
