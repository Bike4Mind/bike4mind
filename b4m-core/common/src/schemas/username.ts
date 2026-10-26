import { z } from 'zod';

export const USERNAME_MAX_LENGTH = 64;

export const USERNAME_RULES_MESSAGE = `Usernames can contain letters, numbers, spaces and . _ - ' (up to ${USERNAME_MAX_LENGTH} characters).`;

const USERNAME_PATTERN = /^[\p{L}\p{M}\p{N} ._'-]+$/u;
const DISALLOWED_USERNAME_CHARS = /[^\p{L}\p{M}\p{N} ._'-]/gu;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Canonical form of a username: NFC, every Unicode whitespace character (NBSP included) as a plain
 * space, runs collapsed, ends trimmed. Shared by the schema and the uniqueness lookup so composed
 * and decomposed spellings of one name are the same name.
 */
export function normalizeUsername(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Rules for a username a person picks or an admin sets. Existing stored usernames predate these
 * rules, so callers validate only a new or changed value, never one read back from the database.
 */
export const usernameSchema = z
  .string()
  .transform(normalizeUsername)
  .pipe(
    z
      .string()
      .min(1, USERNAME_RULES_MESSAGE)
      .max(USERNAME_MAX_LENGTH, USERNAME_RULES_MESSAGE)
      .regex(USERNAME_PATTERN, USERNAME_RULES_MESSAGE)
      .regex(HAS_LETTER_OR_DIGIT, USERNAME_RULES_MESSAGE)
  );

/**
 * Usernames starting with this mark test-persona accounts, which analytics sets aside as synthetic
 * (isSyntheticIdentity in ../utils/syntheticIdentity). Reserved: only an admin, a test-only route, or
 * an account whose proven email already makes it synthetic may hold one. usernameSchema does not
 * enforce this because admins use it too; user-facing paths check isReservedUsername separately.
 */
export const RESERVED_USERNAME_PREFIX = 'persona-';

export const RESERVED_USERNAME_MESSAGE = `Usernames starting with "${RESERVED_USERNAME_PREFIX}" are reserved. Please choose another username.`;

// Lookalikes of the prefix's characters that NFKD does not fold, after lower-casing: other scripts'
// letters, Latin small capitals, and dashes. Fullwidth, mathematical and other compatibility forms
// fold under NFKD. Cherokee and Greek capitals are listed by their lower-case forms, and Lisu, which
// has no case, spells the whole prefix. Taken from the Unicode confusables table (UTS #39).
const RESERVED_PREFIX_CONFUSABLES: Readonly<Record<string, string>> = {
  '\u0440': 'p', // Cyrillic er
  '\u03c1': 'p', // Greek rho
  '\u1d18': 'p', // small capital p
  '\u2ca3': 'p', // Coptic ro
  '\uabb2': 'p', // Cherokee tlv (capital looks like P)
  '\ua4d1': 'p', // Lisu pa
  '\u146d': 'p', // Canadian syllabics ki
  '\u0435': 'e', // Cyrillic ie
  '\u04bd': 'e', // Cyrillic abkhasian che
  '\u1d07': 'e', // small capital e
  '\u03b5': 'e', // Greek epsilon (capital looks like E)
  '\uab32': 'e', // blackletter e
  '\uab7c': 'e', // Cherokee gv (capital looks like E)
  '\ua4f0': 'e', // Lisu e
  '\u0433': 'r', // Cyrillic ghe
  '\u0280': 'r', // small capital r
  '\u1d26': 'r', // Greek small capital gamma
  '\u2c85': 'r', // Coptic gamma
  '\uab47': 'r', // r without handle
  '\uab71': 'r', // Cherokee e (capital looks like R)
  '\uab81': 'r', // Cherokee hu
  '\uaba2': 'r', // Cherokee sv (capital looks like R)
  '\ua4e3': 'r', // Lisu zha
  '\u1587': 'r', // Canadian syllabics tlhi
  '\u0455': 's', // Cyrillic dze
  '\ua731': 's', // small capital s
  '\u01bd': 's', // tone five
  '\uabaa': 's', // Cherokee du (capital looks like S)
  '\ua4e2': 's', // Lisu sa
  '\u043e': 'o', // Cyrillic o
  '\u03bf': 'o', // Greek omicron
  '\u03c3': 'o', // Greek sigma
  '\u0585': 'o', // Armenian oh
  '\u1d0f': 'o', // small capital o
  '\u1d11': 'o', // sideways o
  '\u2c9f': 'o', // Coptic o
  '\uab3d': 'o', // blackletter o
  '\ua4f3': 'o', // Lisu o
  '\u0578': 'n', // Armenian vo
  '\u057c': 'n', // Armenian ra
  '\u03b7': 'n', // Greek eta
  '\u03bd': 'n', // Greek nu (capital looks like N)
  '\u0274': 'n', // small capital n
  '\u2c9b': 'n', // Coptic ni
  '\ua4e0': 'n', // Lisu na
  '\u0430': 'a', // Cyrillic a
  '\u03b1': 'a', // Greek alpha
  '\u0251': 'a', // Latin alpha
  '\u1d00': 'a', // small capital a
  '\uab64': 'a', // inverted alpha
  '\uab7a': 'a', // Cherokee go (capital looks like A)
  '\ua4ee': 'a', // Lisu a
  '\u15c5': 'a', // Canadian syllabics carrier gho
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2212': '-',
  '\u02d7': '-',
  '\u2043': '-',
};

// Combining marks and default-ignorable code points: zero-width characters, variation selectors,
// and the Hangul fillers, which are letters the username pattern admits but which render as nothing.
const INVISIBLE_OR_MARK = /[\p{M}\p{Default_Ignorable_Code_Point}]/gu;

function foldForReservedCheck(raw: string): string {
  const stripped = raw.normalize('NFKD').toLowerCase().normalize('NFKD').replace(INVISIBLE_OR_MARK, '');
  return Array.from(stripped, char => RESERVED_PREFIX_CONFUSABLES[char] ?? char)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether `raw` starts with {@link RESERVED_USERNAME_PREFIX} in any case, after trimming, compatibility
 * normalization (NFKD), dropping accents and invisible characters, and folding lookalike letters
 * and dashes. Deliberately broader than the analytics classifier: it also refuses names that only
 * look like a test persona's.
 */
export function isReservedUsername(raw: string): boolean {
  return foldForReservedCheck(raw).startsWith(RESERVED_USERNAME_PREFIX);
}

/**
 * Remove the reserved prefix, and any separators or invisible characters after it, from the front
 * of `raw` until what is left is not reserved, so a generated username never claims it. May return ''.
 */
export function stripReservedUsernamePrefix(raw: string): string {
  let rest = raw;
  while (isReservedUsername(rest)) {
    const chars = Array.from(rest);
    let cut = 1;
    while (cut < chars.length && !isReservedUsername(chars.slice(0, cut).join(''))) cut++;
    rest = chars
      .slice(cut)
      .join('')
      .replace(/^[\s._'\-\p{M}\p{Default_Ignorable_Code_Point}]+/u, '');
  }
  return rest;
}

/**
 * Coerce a machine-derived value (provider display name, email local part) into a username that
 * satisfies {@link usernameSchema}: drops disallowed characters, collapses whitespace, applies NFC and cuts to
 * `maxLength` UTF-16 units without splitting a surrogate pair. Never returns a reserved username
 * ({@link isReservedUsername}); the prefix is stripped. Returns '' when no letter or digit remains - the caller owns
 * the fallback.
 */
export function sanitizeUsername(raw: string, maxLength: number = USERNAME_MAX_LENGTH): string {
  const collapsed = normalizeUsername(normalizeUsername(raw).replace(DISALLOWED_USERNAME_CHARS, ''));
  let truncated = '';
  for (const char of collapsed) {
    if (truncated.length + char.length > maxLength) break;
    truncated += char;
  }
  const result = stripReservedUsernamePrefix(truncated.trim()).trim();
  return HAS_LETTER_OR_DIGIT.test(result) ? result : '';
}
