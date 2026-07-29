/**
 * Naming helpers shared by every surface that reports presence into the Hearth.
 *
 * The Claude Code hook (packages/cli/bin/hearth-hook.mjs) ships as a
 * dependency-free script run under bare `node`, so it carries its own copy of
 * the slug algorithm and the word lists below rather than importing them.
 * identity.parity.test.ts pins the two copies to each other: change one and
 * the test fails until you change the other.
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

// 32x32 = 1024 pairs. Collisions are cosmetic (the exact session id still
// travels in the event payload); the point is that a human can tell two live
// sessions apart at a glance, which a uuid prefix does not achieve.
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
