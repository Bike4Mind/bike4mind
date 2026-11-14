import { useEffect } from 'react';
import type { z } from 'zod';
import { create } from 'zustand';
import type { GeneratedAssetLineageRole } from '@bike4mind/common';
import type { ReferenceFile } from '@client/app/components/Studio/capabilityFields';
import type { StudioMedium } from '@client/app/components/Studio/studioModality';

/**
 * A take's stored generation request (`sourceMetadata.generation.request`), on its way from the trail's Restore
 * into the Create form of its medium.
 */
export type StudioRestoreRequest = {
  medium: StudioMedium;
  request: Record<string, unknown>;
  /**
   * The names of the files the trail walked, by id: a string for one the user can read, null for one it redacted.
   * Requests store input files by id only, and the forms show each input by name.
   */
  fileNames: Readonly<Record<string, string | null>>;
};

export type StudioRestore = StudioRestoreRequest & { id: number };

/** A form's state rebuilt from a stored request, and why each stored value that did not come back was left out. */
export type Restored<T> = { value: T; notices: string[] };

type StudioRestoreState = {
  pending: StudioRestore | null;
  requestRestore: (restore: StudioRestoreRequest) => void;
  /** Takes the pending restore if it is still `id`; true only for the first caller, so one restore applies once. */
  consume: (id: number) => boolean;
};

let nextRestoreId = 1;

/**
 * The hand-off between the trail and the Create form. A store, not a prop, because Restore can switch medium: the
 * form that takes the request mounts after the navigation, once its models have loaded.
 */
export const useStudioRestore = create<StudioRestoreState>()((set, get) => ({
  pending: null,
  requestRestore: restore => set({ pending: { ...restore, id: nextRestoreId++ } }),
  consume: id => {
    if (get().pending?.id !== id) return false;
    set({ pending: null });
    return true;
  },
}));

/** Runs `apply` once for each restore aimed at `medium`, as soon as the calling form is mounted. */
export function useConsumeStudioRestore(medium: StudioMedium, apply: (restore: StudioRestore) => void) {
  const pending = useStudioRestore(state => state.pending);
  useEffect(() => {
    // consume() guards the re-runs a changed `apply` or a strict-mode double effect would cause.
    if (pending?.medium === medium && useStudioRestore.getState().consume(pending.id)) apply(pending);
  }, [pending, medium, apply]);
}

/**
 * Reads one stored field. Absent gives the fallback quietly; present but no longer valid gives the fallback and a
 * notice, so a value the catalog has since dropped never vanishes without a word.
 */
export function readStoredField<T>(
  schema: z.ZodType<T>,
  value: unknown,
  fallback: T,
  label: string,
  notices: string[]
): T {
  if (value === undefined || value === null) return fallback;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  notices.push(`The take's ${label} (${String(value)}) is no longer valid, so the default is used.`);
  return fallback;
}

const ROLE_NOUNS: Record<GeneratedAssetLineageRole, string> = {
  first_frame: 'first frame',
  last_frame: 'last frame',
  reference: 'reference image',
  style: 'style image',
  extend_of: 'source clip',
  variation_of: 'source image',
  edit_source: 'edit source',
  mask: 'mask',
};

export const roleNoun = (role: GeneratedAssetLineageRole): string => ROLE_NOUNS[role];

/**
 * An input file of the take as a form holds it, or null (with a notice) for one the user can no longer read. A file
 * outside the walk (an input of a child step) keeps its role as its name; the server checks access on submit.
 */
export function restoreInputFile(
  fileId: string,
  role: GeneratedAssetLineageRole,
  fileNames: StudioRestoreRequest['fileNames'],
  notices: string[]
): ReferenceFile | null {
  const name = fileNames[fileId];
  if (name === null) {
    notices.push(`The take's ${roleNoun(role)} is no longer available to you, so it was left out.`);
    return null;
  }
  const fallbackName = roleNoun(role);
  return { fileId, fileName: name ?? fallbackName.charAt(0).toUpperCase() + fallbackName.slice(1) };
}
