/**
 * Naming helpers shared by every surface that reports presence into the Hearth.
 *
 * The Claude Code hook (packages/cli/bin/hearth-hook.mjs) ships as a
 * dependency-free script run under bare `node`, so it carries its own copy of
 * the slug algorithm and the word lists below rather than importing them.
 * identity.test.ts pins the two copies to each other: change one and the test
 * fails until you change the other.
 */

/**
 * Channel every presence reporter lands in when nothing else is configured.
 *
 * A shared default is the point: the cc-bridge and the Claude Code hook are two
 * different ways into the same log, and a roster is only a roster if it shows
 * every live session together. Defaulting them to separate channels would split
 * one roster into two half-rosters, which is worse than having none.
 */
export const DEFAULT_HEARTH_CHANNEL_NAME = 'agents';

// 32x32 = 1024 pairs, so a human can tell two live sessions apart at a glance
// where a uuid prefix cannot.
//
// A collision is NOT purely cosmetic, despite what this comment used to claim.
// The slug reaches actor.displayName, ensureActor upserts on
// (userId, kind, displayName), and a roster row is keyed (channelId, actorId) -
// so two colliding sessions collapse onto ONE actor, one row, and one shared
// cursor, which is the exact defect per-session identity was introduced to fix.
// By the birthday bound that is even odds at about 38 concurrent sessions. The
// exact session id still travels in the payload, so nothing is lost, but the
// roster under-reports. Widening the lists (or seeding the slug with more of the
// id) is the fix if that becomes real; recorded here so the next reader does not
// re-derive it from the word "cosmetic".
const ADJECTIVES = [
  'amber',
  'brisk',
  'calm',
  'clever',
  'copper',
  'crimson',
  'dapper',
  'eager',
  'fluent',
  'gentle',
  'golden',
  'hardy',
  'humble',
  'ivory',
  'jolly',
  'keen',
  'lucid',
  'merry',
  'nimble',
  'noble',
  'olive',
  'patient',
  'quiet',
  'rapid',
  'rustic',
  'silver',
  'solemn',
  'sunny',
  'teal',
  'tidy',
  'vivid',
  'wry',
];
const ANIMALS = [
  'otter',
  'heron',
  'lynx',
  'marten',
  'badger',
  'falcon',
  'ibex',
  'jackal',
  'kestrel',
  'lemur',
  'magpie',
  'newt',
  'osprey',
  'puffin',
  'quail',
  'raven',
  'shrike',
  'tapir',
  'urchin',
  'viper',
  'walrus',
  'yak',
  'zebra',
  'bison',
  'crane',
  'dingo',
  'egret',
  'ferret',
  'gecko',
  'hare',
  'impala',
  'jay',
];

/** djb2. Deterministic across processes and restarts, which is the whole point. */
function hashOf(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * A readable, stable name for a session, derived purely from an id the caller
 * already holds - so it costs no additional disclosure.
 */
export function sessionSlug(sessionId: string | null | undefined): string {
  if (!sessionId) return 'unknown-session';
  const hash = hashOf(sessionId);
  const animalIndex = Math.floor(hash / ADJECTIVES.length) % ANIMALS.length;
  return `${ADJECTIVES[hash % ADJECTIVES.length]}-${ANIMALS[animalIndex]}`;
}

/**
 * Actor displayName for a session-scoped presence reporter. THE convention, not
 * one surface's preference: ensureActor upserts on (userId, kind, displayName),
 * so two reporters covering the same session must compose the identical string
 * or that session gets two actors, two roster rows and two cursors. That is
 * exactly what happened while the hook named itself `Claude Code (slug)` and the
 * bridge named the same session `${workspace} (slug)` - and since the bridge is
 * itself hooks-driven, running both is the expected configuration, not an edge
 * case.
 *
 * Derived from the session id ALONE, which is what makes agreement possible:
 * - The workspace cannot appear here. The hook withholds it below disclosure
 *   tier 1, so including it would make an actor's IDENTITY depend on a privacy
 *   setting - one session would split into two actors when the tier changed.
 *   The workspace already travels as projected roster detail, where surfaces
 *   render it next to the name.
 * - No client name either ("Claude Code"): presence has to stay
 *   surface-agnostic, so a human at a plain terminal and an agent on a map read
 *   as one recognizable actor rather than one client's shape emulated by the
 *   rest.
 */
export function sessionActorName(sessionId: string | null | undefined): string {
  return sessionSlug(sessionId);
}

/**
 * Number of per-actor color slots every surface must expose.
 *
 * Actor color is identity, so the SLOT has to be chosen identically everywhere
 * or the same session reads as a different actor in the SPA than in the CLI.
 * The mapping lives here (next to the slug, for the same reason) while each
 * surface supplies its own palette for that count: the SPA needs light/dark hex
 * pairs, a terminal needs ANSI codes, and neither can express the other's.
 *
 * Small and fixed rather than an unbounded hue ramp. Collisions are expected
 * and harmless because color is never the only signal - the actor name is
 * always rendered - which also keeps color from being forgeable identity.
 */
export const ACTOR_COLOR_SLOT_COUNT = 6;

/**
 * Stable palette slot for an actor. Hash-derived, never array index or arrival
 * order: those repaint every actor whenever the tail changes or a reload
 * reorders the buffer, and a shifting color is worse than no color for telling
 * two agents apart.
 */
export function actorColorIndex(actorId: string): number {
  if (!actorId) return 0;
  return hashOf(actorId) % ACTOR_COLOR_SLOT_COUNT;
}

/** Longest session label that reaches an actor name; the rest is dropped. */
export const MAX_SESSION_LABEL_LENGTH = 60;

/**
 * Reduce a caller-supplied session label to something safe to render inside an
 * actor name.
 *
 * Parentheses are stripped because the label is interpolated INTO a
 * parenthetical (see humanSessionActorName): a label containing `)` could
 * otherwise close the real one and append text that reads as a separate,
 * unqualified name. Control characters go for the same reason a terminal
 * surface should never echo them. Returns undefined when nothing usable
 * survives, so the caller falls back to the slug rather than rendering `()`.
 */
export function sanitizeSessionLabel(label: string | null | undefined): string | undefined {
  if (!label) return undefined;
  const cleaned = label
    .replace(/[()]/g, '')
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    // Collapse the gaps the two replacements above leave behind, so a stripped
    // character never shows up as ragged whitespace in a rendered name.
    .replace(/\s+/g, ' ')
    .trim();
  // Trim again after slicing: the cap can land mid-word and leave a trailing space.
  const capped = cleaned.slice(0, MAX_SESSION_LABEL_LENGTH).trim();
  return capped || undefined;
}

/**
 * Display name for a per-session HUMAN actor.
 *
 * `base` is always derived server-side from the authenticated account and is
 * always the prefix; only the parenthetical varies per session. That ordering
 * is the security property, not a formatting choice: it preserves what
 * reserving `kind: 'human'` bought (a caller cannot produce an actor name that
 * reads as a different person) now that human actors are per-session instead
 * of one-per-account.
 *
 * Pass `label` for a human-recognizable session name (a notebook name) and it
 * is used in place of the slug for DISPLAY only. It must never reach the actor
 * identity key: names like a notebook's are renamed and auto-titled, and since
 * actor identity is `(userId, kind, displayName)`, letting a mutable string in
 * would mint a new actor - and therefore a new cursor - mid-session. Callers
 * key identity on `humanSessionActorName(base, sessionId)` with no label.
 */
export function humanSessionActorName(
  base: string,
  sessionId: string | null | undefined,
  label?: string | null
): string {
  if (!sessionId) return base;
  const safe = sanitizeSessionLabel(label);
  return `${base} (${safe ?? sessionSlug(sessionId)})`;
}
