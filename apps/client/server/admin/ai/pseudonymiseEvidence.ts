import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { Config } from '@bike4mind/server-utils/utils/config';

/**
 * Replaces personal identifiers in evidence before it is sent to a model. With a salt each identifier
 * becomes a stable `p_<hmac>` token, so one entity still correlates within a payload and the input hash
 * stays the same across instances. Without a usable salt it fails closed to fixed redaction markers:
 * an empty-salt HMAC of an email is reversible by dictionary.
 *
 * Plain objects and arrays are walked; functions, undefined, symbols and class instances are dropped.
 * Evidence links a consumer needs are kept server-side, never passed through here.
 */

type IdentifierKind = 'email' | 'ip' | 'id' | 'name' | 'phone';

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
// Bounds the regex scans below and the payload size; evidence is a summary, not a document.
const MAX_STRING_LENGTH = 4000;
const PLACEHOLDER_SALT = 'not-configured';

const REDACTED: Record<IdentifierKind, string> = {
  email: '[redacted-email]',
  ip: '[redacted-ip]',
  id: '[redacted-id]',
  name: '[redacted-name]',
  phone: '[redacted-phone]',
};

// Domain-separates the token key from the analytics pseudonym, which HMACs the same ids with the raw salt.
const EVIDENCE_KEY_LABEL = 'b4m-admin-ai-evidence-token-v1';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const OBJECT_ID_RE = /\b[0-9a-fA-F]{24}\b/g;
// Candidates only; net.isIP decides, so clock times like 07:17:31 are left alone.
const IPV6_CANDIDATE_RE = /[0-9A-Fa-f]*(?::[0-9A-Fa-f.]*){2,}/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

const SENSITIVE_KEY_SUFFIXES: ReadonlyArray<[string, IdentifierKind]> = [
  ['email', 'email'],
  ['ipaddress', 'ip'],
  ['fingerprint', 'id'],
  ['deviceid', 'id'],
  ['userid', 'id'],
  ['accountid', 'id'],
  ['organizationid', 'id'],
  ['stripecustomerid', 'id'],
  ['apikeyid', 'id'],
  ['username', 'name'],
  ['displayname', 'name'],
  ['fullname', 'name'],
  ['firstname', 'name'],
  ['lastname', 'name'],
  ['phone', 'phone'],
  ['phonenumber', 'phone'],
];

/** The kind a key's value is treated as, or null when the key is not identifying. */
function sensitiveKeyKind(key: string): IdentifierKind | null {
  // `ip` alone, or as a camelCase/snake suffix (`signupIp`, `last_ip`); a bare lowercase suffix
  // would also match words like `ownership`.
  if (/^ip$/i.test(key) || /(?:[a-z0-9]Ip|IP|[_-]ip)$/.test(key)) return 'ip';
  const normalized = key.replace(/[_-]/g, '').toLowerCase();
  // A bare `name` on user-shaped evidence is the person's display name.
  if (normalized === 'name') return 'name';
  for (const [suffix, kind] of SENSITIVE_KEY_SUFFIXES) {
    if (normalized.endsWith(suffix)) return kind;
  }
  return null;
}

/** OVERWATCH_PSEUDONYM_SALT, or undefined when unset or still the deploy placeholder. */
export function adminAiEvidenceSalt(): string | undefined {
  const salt = Config.OVERWATCH_PSEUDONYM_SALT;
  return salt && salt !== PLACEHOLDER_SALT ? salt : undefined;
}

let cachedKey: { salt: string; key: Buffer } | undefined;

function evidenceKey(salt: string): Buffer {
  if (cachedKey?.salt !== salt) {
    cachedKey = { salt, key: Buffer.from(crypto.hkdfSync('sha256', salt, '', EVIDENCE_KEY_LABEL, 32)) };
  }
  return cachedKey.key;
}

function tokenFor(value: string, kind: IdentifierKind, salt: string | undefined): string {
  if (!salt) return REDACTED[kind];
  const canonical = kind === 'email' ? value.toLowerCase() : value;
  return `p_${crypto.createHmac('sha256', evidenceKey(salt)).update(canonical).digest('hex').slice(0, 12)}`;
}

/**
 * The candidate regex can take a neighbouring `:`/`.` or a leading `word:` into the match, which makes
 * isIP reject a real address. Retry with the leading segment and/or a trailing `:`/`.` run trimmed.
 */
function scrubIpv6Candidate(m: string, salt: string | undefined): string {
  let trailEnd = m.length;
  while (trailEnd > 0 && (m[trailEnd - 1] === ':' || m[trailEnd - 1] === '.')) trailEnd--;
  const firstColon = m.indexOf(':');
  const starts = firstColon > 0 || (firstColon === 0 && !m.startsWith('::')) ? [0, firstColon + 1] : [0];
  const ends = [m.length, ...[trailEnd, trailEnd + 1, trailEnd + 2].filter(e => e < m.length)];
  for (const start of starts) {
    for (const end of ends) {
      const core = m.slice(start, end);
      if (isIP(core) === 6) return m.slice(0, start) + tokenFor(core.toLowerCase(), 'ip', salt) + m.slice(end);
    }
  }
  return m;
}

function scrubString(raw: string, salt: string | undefined): string {
  const text = raw.length > MAX_STRING_LENGTH ? raw.slice(0, MAX_STRING_LENGTH) : raw;
  return text
    .replace(EMAIL_RE, m => tokenFor(m, 'email', salt))
    .replace(UUID_RE, m => tokenFor(m.toLowerCase(), 'id', salt))
    .replace(OBJECT_ID_RE, m => tokenFor(m.toLowerCase(), 'id', salt))
    .replace(IPV6_CANDIDATE_RE, m => scrubIpv6Candidate(m, salt))
    .replace(IPV4_RE, m => (isIP(m) === 4 ? tokenFor(m, 'ip', salt) : m));
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isObjectIdLike(value: object): value is { toHexString(): string } {
  return typeof (value as { toHexString?: unknown }).toHexString === 'function';
}

const DROP = Symbol('drop');

function walk(value: unknown, salt: string | undefined, depth: number, keyKind: IdentifierKind | null): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return keyKind ? tokenFor(value, keyKind, salt) : scrubString(value, salt);
    case 'number':
      return keyKind ? tokenFor(String(value), keyKind, salt) : value;
    case 'boolean':
      return value;
    case 'object':
      break;
    default:
      return DROP;
  }

  if (isObjectIdLike(value)) return tokenFor(value.toHexString().toLowerCase(), keyKind ?? 'id', salt);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? DROP : value.toISOString();
  if (depth >= MAX_DEPTH) return '[truncated]';

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(item => walk(item, salt, depth + 1, keyKind))
      .filter(item => item !== DROP);
  }
  if (!isPlainObject(value)) return DROP;

  const out: Record<string, unknown> = {};
  // Next free `#n` per scrubbed key: without a salt every email key collapses to one placeholder, so
  // probing from #2 each time would be quadratic in the key count.
  const nextSuffix = new Map<string, number>();
  for (const [key, child] of Object.entries(value)) {
    const walked = walk(child, salt, depth + 1, keyKind ?? sensitiveKeyKind(key));
    if (walked === DROP) continue;
    // Evidence keyed by identifier (per-IP or per-email counts) carries the identifier in the key.
    const base = scrubString(key, salt);
    let outKey = base;
    if (Object.hasOwn(out, base)) {
      let n = nextSuffix.get(base) ?? 2;
      while (Object.hasOwn(out, `${base}#${n}`)) n++;
      outKey = `${base}#${n}`;
      nextSuffix.set(base, n + 1);
    }
    out[outKey] = walked;
  }
  return out;
}

/** `salt` defaults to adminAiEvidenceSalt(); pass it explicitly in tests. */
export function pseudonymiseEvidence(evidence: unknown, salt: string | undefined = adminAiEvidenceSalt()): unknown {
  const usableSalt = salt && salt !== PLACEHOLDER_SALT ? salt : undefined;
  const walked = walk(evidence, usableSalt, 0, null);
  return walked === DROP ? null : walked;
}
