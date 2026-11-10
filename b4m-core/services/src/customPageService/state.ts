import { applyJsonMergePatch, PAGE_STATE_MAX_BYTES } from '@bike4mind/common';
import { pageError, type CustomPageResult, type CustomPageServiceAdapters } from './ports';

const MAX_STATE_DEPTH = 16;

/**
 * Why a patch cannot be stored, or null. Bounds the depth before the recursive merge runs, and rejects
 * keys Mongo would read as operators or paths.
 */
export function findInvalidStatePatch(value: unknown, depth = 0): string | null {
  if (typeof value !== 'object' || value === null) return null;
  if (depth >= MAX_STATE_DEPTH) return `State is nested deeper than ${MAX_STATE_DEPTH} levels`;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const problem = findInvalidStatePatch(entry, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || key.startsWith('$') || key.includes('.')) {
      return `Invalid state key "${key}": keys must be non-empty and cannot start with "$" or contain "."`;
    }
    const problem = findInvalidStatePatch(entry, depth + 1);
    if (problem) return problem;
  }
  return null;
}

export function stateByteLength(state: unknown): number {
  return new TextEncoder().encode(JSON.stringify(state)).length;
}

/** Applies an RFC 7386 merge patch to the page's state; retries once if a concurrent write wins. */
export async function patchState(
  params: { pageId: string; userId: string; patch: Record<string, unknown> },
  adapters: CustomPageServiceAdapters
): Promise<CustomPageResult> {
  const { pageId, userId, patch } = params;
  const problem = findInvalidStatePatch(patch);
  if (problem) return pageError('invalid', problem);

  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await adapters.db.customPages.findOwned(pageId, userId);
    if (!page) return pageError('not_found', 'Page not found');

    const next = applyJsonMergePatch(page.state ?? {}, patch) as Record<string, unknown>;
    const size = stateByteLength(next);
    if (size > PAGE_STATE_MAX_BYTES) {
      return pageError(
        'state_too_large',
        `Page state would be ${size} bytes; the limit is ${PAGE_STATE_MAX_BYTES}. Remove keys you no longer need.`
      );
    }

    const updated = await adapters.db.customPages.replaceStateOwned(pageId, userId, next, page.version ?? 0);
    if (updated) return { ok: true, page: updated };
  }
  return pageError('conflict', 'The page state changed while it was being updated. Try again.');
}
