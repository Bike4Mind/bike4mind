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
