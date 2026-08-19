import type { PublishSourceKind, PublishVisibility } from '@bike4mind/common';

/**
 * Publish - the search/filter/sort half of the list endpoint's query. Pure, so the
 * behaviour that decides what an owner sees is testable without a database.
 *
 * Kept separate from buildListVisibilityFilter, which answers a different question: that one is
 * the AUTHORIZATION clause (what may this caller see at all) and runs as the pipeline's FIRST
 * $match stage. This one is the caller's own narrowing, and runs as a separate, later $match
 * inside each $facet branch - the two are never combined into a single object. Sequential $match
 * stages can only narrow further, so the effect is the same as an $and, but a reader looking for
 * a merge point will not find one.
 *
 * Either way this must never be able to WIDEN the authorized set: it only ever adds constraints.
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

/**
 * Allow-lists, keyed by the shared union TYPES rather than copied as bare string literals.
 *
 * `Record<Union, true>` requires every member, so ADDING a source kind or a visibility rung makes
 * this a compile error rather than a silent gap - which is the failure that matters here: an
 * unrecognised filter value is dropped, so a list that fell behind its enum would render a chip
 * that fills in on click and then quietly does nothing server-side, with no error anywhere.
 *
 * Types, not runtime values: several suites mock `@bike4mind/common` with a `vi.mock` factory, and
 * importing a schema object here to read `.options` off would break every one of them the moment
 * this module is in their import graph. A type-level check costs them nothing and catches more.
 */
const KIND_ALLOWED: Record<PublishSourceKind, true> = { bundle: true, reply: true, fabfile: true };
const VISIBILITY_ALLOWED: Record<PublishVisibility, true> = {
  private: true,
  project: true,
  organization: true,
  public: true,
};
/** 'none' is synthetic - the ABSENCE of a gate - so it has no schema member of its own. The other
 *  two MUST STAY IN SYNC with AccessGateSubSchema's `kind` enum in PublishedArtifactModel, which
 *  is declared host-side and exports no union to key off yet. */
type GateFilter = 'none' | 'passphrase' | 'domain';
const GATE_ALLOWED: Record<GateFilter, true> = { none: true, passphrase: true, domain: true };

const KINDS: ReadonlySet<string> = new Set(Object.keys(KIND_ALLOWED));
const VISIBILITIES: ReadonlySet<string> = new Set(Object.keys(VISIBILITY_ALLOWED));
const GATES: ReadonlySet<string> = new Set(Object.keys(GATE_ALLOWED));

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
  if (params.visibility && VISIBILITIES.has(params.visibility)) {
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
