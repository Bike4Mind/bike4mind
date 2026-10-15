import type { ChatSpawnSuggestion } from '@shared/chat';

export type DraftField = 'title' | 'prompt' | 'branch';

export const DRAFT_FIELDS: readonly DraftField[] = ['title', 'prompt', 'branch'];

/**
 * The user's unsent edits to one suggestion card, and the server text each edit started from.
 *
 * `base` is what lets an assistant update and a user edit be told apart: a field is the user's
 * once it differs from its base, and it is in conflict once the server has moved off that base
 * too. A field the user has not touched simply follows the server.
 */
export interface SuggestionDraft {
  values: Partial<Record<DraftField, string>>;
  base: Partial<Record<DraftField, string>>;
}

export interface ResolvedDraft {
  values: Record<DraftField, string>;
  /** Fields the assistant changed while the user had unsent edits in them. */
  conflicts: DraftField[];
}

function serverValue(suggestion: ChatSpawnSuggestion, field: DraftField): string {
  return suggestion[field];
}

function isDirty(draft: SuggestionDraft | undefined, field: DraftField): boolean {
  const value = draft?.values[field];
  return value !== undefined && value !== draft?.base[field];
}

export function resolveDraft(suggestion: ChatSpawnSuggestion, draft: SuggestionDraft | undefined): ResolvedDraft {
  const values = {} as Record<DraftField, string>;
  const conflicts: DraftField[] = [];
  for (const field of DRAFT_FIELDS) {
    const server = serverValue(suggestion, field);
    if (!isDirty(draft, field)) {
      values[field] = server;
      continue;
    }
    values[field] = draft?.values[field] ?? server;
    if (server !== draft?.base[field] && server !== values[field]) conflicts.push(field);
  }
  return { values, conflicts };
}

export function editDraft(
  suggestion: ChatSpawnSuggestion,
  draft: SuggestionDraft | undefined,
  field: DraftField,
  value: string
): SuggestionDraft {
  // The base is pinned by the first keystroke; later ones must not move it, or an assistant
  // update arriving mid-edit would be silently adopted as the thing the user was editing.
  const base = isDirty(draft, field) ? draft?.base[field] : serverValue(suggestion, field);
  return {
    values: { ...draft?.values, [field]: value },
    base: { ...draft?.base, [field]: base },
  };
}

/** Take the assistant's version of a conflicting field and drop the user's edit to it. */
export function acceptAssistant(
  suggestion: ChatSpawnSuggestion,
  draft: SuggestionDraft | undefined,
  field: DraftField
): SuggestionDraft {
  const { [field]: _dropped, ...values } = draft?.values ?? {};
  return { values, base: { ...draft?.base, [field]: serverValue(suggestion, field) } };
}

/** Keep the user's edit, and stop asking about the assistant's version of it. */
export function keepMine(
  suggestion: ChatSpawnSuggestion,
  draft: SuggestionDraft | undefined,
  field: DraftField
): SuggestionDraft {
  return { values: { ...draft?.values }, base: { ...draft?.base, [field]: serverValue(suggestion, field) } };
}

/**
 * Drafts outlive the card that holds them, so switching conversations and back does not throw
 * away a half-edited prompt. Keyed by suggestion id; dropped once a suggestion stops pending.
 */
const drafts = new Map<string, SuggestionDraft>();

export function readDraft(id: string): SuggestionDraft | undefined {
  return drafts.get(id);
}

export function writeDraft(id: string, draft: SuggestionDraft | undefined): void {
  if (draft) drafts.set(id, draft);
  else drafts.delete(id);
}
