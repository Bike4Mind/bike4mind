import type { PublishVisibility } from '@bike4mind/common';

/**
 * Publish - the search/filter/sort half of the list endpoint's query. Pure, so the
 * behaviour that decides what an owner sees is testable without a database.
 *
 * Kept separate from buildListVisibilityFilter, which answers a different question:
 * that one is the AUTHORIZATION clause (what may this caller see at all) and is
 * $and-merged by the route. This one is the caller's own narrowing of that set, and
 * must never be able to widen it - it only ever adds constraints.
 */

export interface ListQueryParams {
  /** Substring match over title + description. */
  q?: string;
  /** source.kind: bundle | reply | fabfile. */
  kind?: string;
  visibility?: string;
  /** accessGate.kind, plus the synthetic 'none' for an ungated artifact. */
  gate?: string;
  /** 'on' | 'off' - whether annotations are enabled. */
  comments?: string;
  sort?: string;
}

export type SortKey = 'newest' | 'oldest' | 'views' | 'versions' | 'updated' | 'title';

/**
 * Two of these reference fields the ROUTE derives in $addFields rather than stored ones -
 * `versionsCount` ($size of versions[]) and `titleSort` ($toLower of title) - and both must
 * exist before $sort runs. This map and the route's $addFields stage MUST STAY IN SYNC:
 * naming a field here that the route does not add sorts by nothing, silently.
 */
const SORTS: Record<SortKey, Record<string, 1 | -1>> = {
  // publicId breaks ties on every sort so paging is stable: two artifacts published in the
  // same second would otherwise be free to swap places between pages and one could be
  // skipped while another appeared twice.
  newest: { publishedAt: -1, publicId: 1 },
  oldest: { publishedAt: 1, publicId: 1 },
  views: { viewCount: -1, publishedAt: -1, publicId: 1 },
  versions: { versionsCount: -1, publishedAt: -1, publicId: 1 },
  updated: { updatedAt: -1, publicId: 1 },
  title: { titleSort: 1, publicId: 1 },
};

const KINDS = new Set(['bundle', 'reply', 'fabfile']);
const VISIBILITIES = new Set<PublishVisibility>(['private', 'project', 'organization', 'public']);
const GATES = new Set(['none', 'passphrase', 'domain']);

/** Escape a user string for literal use inside a RegExp. Without this a `q` of `.*` would
 *  match everything and `(` would throw at query time. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildListQuery(params: ListQueryParams): {
  match: Record<string, unknown>;
  sort: Record<string, 1 | -1>;
} {
  const match: Record<string, unknown> = {};

  const q = params.q?.trim();
  if (q) {
    // Case-insensitive substring over the two fields an owner would search by. `description`
    // is on every artifact and the management tab never displays it, so including it here
    // makes an existing field useful rather than requiring a new one.
    const rx = new RegExp(escapeRegex(q), 'i');
    match.$or = [{ title: rx }, { description: rx }];
  }

  // Unknown values are IGNORED rather than passed through: a filter Mongo cannot satisfy
  // would silently return nothing, which reads as "you have no artifacts" instead of "that
  // is not a real filter". Ignoring keeps a stale bookmark showing results.
  if (params.kind && KINDS.has(params.kind)) match['source.kind'] = params.kind;
  if (params.visibility && VISIBILITIES.has(params.visibility as PublishVisibility)) {
    match.visibility = params.visibility;
  }
  if (params.gate && GATES.has(params.gate)) {
    match['accessGate.kind'] = params.gate === 'none' ? { $exists: false } : params.gate;
  }
  if (params.comments === 'on') match.commentPolicy = { $in: ['open', 'restricted'] };
  if (params.comments === 'off') match.commentPolicy = { $nin: ['open', 'restricted'] };

  const sort = SORTS[(params.sort as SortKey) ?? 'newest'] ?? SORTS.newest;

  return { match, sort };
}
