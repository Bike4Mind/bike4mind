/**
 * Readable passphrase generator for published-artifact access gates.
 *
 * Shaped for a passphrase that gets read aloud, pasted into a chat, or typed off a screen:
 * short common words joined by hyphens with one two-digit group, e.g. `ravine-cobalt-79-mist`.
 *
 * Entropy: 4 words from a 128-word list (4 x 7 bits) plus a two-digit number (~6.6 bits) is
 * roughly 34 bits. That is deliberately tuned to an ONLINE attack, which is the only one
 * available: the passphrase is stored as a bcrypt hash that is never returned by any route, and
 * the gate endpoint is bounded by a per-IP rate limit plus a per-artifact lockout. At ten
 * attempts per five minutes, 34 bits is on the order of a hundred thousand years. It is NOT
 * sized for an offline attack, and should not be reused as a general-purpose secret generator.
 *
 * Words are chosen to survive being spoken and retyped: no pairs that sound alike, nothing
 * that collides in handwriting, and no word whose plural or spelling is ambiguous.
 */

const WORDS = [
  'amber',
  'anchor',
  'apple',
  'arbor',
  'arrow',
  'aspen',
  'atlas',
  'autumn',
  'basin',
  'beacon',
  'birch',
  'bishop',
  'bison',
  'blossom',
  'bramble',
  'bronze',
  'cabin',
  'canyon',
  'cedar',
  'cinder',
  'citrus',
  'clover',
  'cobalt',
  'comet',
  'copper',
  'coral',
  'cotton',
  'crater',
  'crimson',
  'crystal',
  'cypress',
  'dahlia',
  'delta',
  'denim',
  'domino',
  'drifter',
  'dusk',
  'ember',
  'emerald',
  'falcon',
  'fathom',
  'fennel',
  'fjord',
  'flint',
  'forest',
  'fossil',
  'garnet',
  'geyser',
  'ginger',
  'glacier',
  'granite',
  'harbor',
  'harvest',
  'hazel',
  'heron',
  'hollow',
  'indigo',
  'ivory',
  'jasper',
  'jungle',
  'juniper',
  'kettle',
  'lantern',
  'lagoon',
  'lattice',
  'lichen',
  'lilac',
  'linen',
  'lumber',
  'magnet',
  'maple',
  'marble',
  'meadow',
  'mercury',
  'meteor',
  'mineral',
  'mint',
  'mist',
  'monsoon',
  'mosaic',
  'nectar',
  'nimbus',
  'nutmeg',
  'oasis',
  'obsidian',
  'onyx',
  'opal',
  'orbit',
  'orchard',
  'otter',
  'oxide',
  'paprika',
  'pebble',
  'pepper',
  'pewter',
  'pigment',
  'pilot',
  'pine',
  'plateau',
  'pollen',
  'prairie',
  'prism',
  'pumice',
  'quarry',
  'quartz',
  'quill',
  'ravine',
  'reef',
  'ripple',
  'river',
  'saffron',
  'sage',
  'sandbar',
  'sapphire',
  'shadow',
  'signal',
  'silver',
  'solstice',
  'sorrel',
  'spruce',
  'summit',
  'sunset',
  'thicket',
  'thistle',
  'timber',
  'topaz',
  'tundra',
  'velvet',
];

/**
 * Reject-sample a uniform integer in [0, max) from the CSPRNG.
 * A bare `% max` would bias toward low values, which for a 128-word list over a 256-value byte
 * happens to be exact - but the number group is not, and a silently-biased generator is not
 * worth the saved lines.
 */
function randomBelow(max: number): number {
  const limit = Math.floor(256 / max) * max;
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

/**
 * A fresh readable passphrase, e.g. `ravine-cobalt-79-mist`.
 * Always well above the 8-character minimum the gate enforces.
 */
export function generatePassphrase(): string {
  const pick = () => WORDS[randomBelow(WORDS.length)];
  const number = String(10 + randomBelow(90)); // two digits, never leading-zero
  return [pick(), pick(), number, pick(), pick()].join('-');
}

/** Exposed so the tests can assert the list's size and uniqueness directly, both of which the
 *  entropy claim above depends on. Not meaningful to callers. */
export const PASSPHRASE_WORDS: readonly string[] = WORDS;
