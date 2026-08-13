/**
 * PR report generator - the identity map.
 *
 * ONE keyspace, not two: keys are either GitHub logins (lowercased) or synthetic
 * role keys (`qa_*`, `devops_*`, `reviewer_*`), both resolving to Slack member
 * ids. That is what lets the same map drive per-user and per-pool mentions without
 * a second config to join at lookup time.
 *
 * lumina5 stores the map as a free-form admin-editable blob, so it needs the
 * blueprint's optional tolerant parser. The line-numbered errors below are the
 * mitigation for a typo'd key - which otherwise produces NO mention rather than an
 * error, the quiet failure mode.
 */

import type { IdentityLookup, ParsedIdentityMapResult, ParsedIdentityMapEntry } from './types';

/**
 * Slack member ids: users are `U…`/`W…`, user groups are `S…`. Only real ids are
 * accepted - a display name like `@wes` renders as literal text and produces no
 * notification, which is exactly the silent failure an admin would not notice.
 */
const MEMBER_ID_PATTERN = /^[UWS][A-Z0-9]{6,}$/;

/** `key value`, `key=value`, `key: value` - with any surrounding whitespace. */
const LINE_PATTERN = /^([^\s:=]+)\s*[:=]?\s+(.+)$|^([^\s:=]+)\s*[:=]\s*(.+)$/;

/**
 * Parse the free-form identity-map setting.
 *
 * Blank lines and `#` comments are ignored. Malformed and duplicate lines are
 * reported with their line numbers rather than silently dropped.
 */
export function parseIdentityMap(input: string | null | undefined): ParsedIdentityMapResult {
  const result: ParsedIdentityMapResult = { entries: [], errors: [] };
  if (!input) return result;

  const seen = new Map<string, number>();

  input.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();

    // A leading '#' is a hard-reserved comment prefix: the whole line is dropped, so a
    // key that literally begins with '#' cannot be expressed. Acceptable - no GitHub
    // login, synthetic role key (qa_/devops_/reviewer_) or Slack member id starts with
    // one, and LINE_PATTERN's key class would otherwise happily match it.
    if (!trimmed || trimmed.startsWith('#')) return;

    const match = LINE_PATTERN.exec(trimmed);
    if (!match) {
      result.errors.push({
        line,
        raw,
        reason: 'expected "key value", "key=value" or "key: value"',
      });
      return;
    }

    const key = (match[1] ?? match[3] ?? '').toLowerCase();
    const memberId = (match[2] ?? match[4] ?? '').trim();

    if (!key || !memberId) {
      result.errors.push({ line, raw, reason: 'missing key or member id' });
      return;
    }

    if (!MEMBER_ID_PATTERN.test(memberId.toUpperCase())) {
      result.errors.push({
        line,
        raw,
        reason: `"${memberId}" is not a Slack member id (expected U…, W… or S…) - display names do not produce mentions`,
      });
      return;
    }

    const firstSeenAt = seen.get(key);
    if (firstSeenAt !== undefined) {
      result.errors.push({
        line,
        raw,
        reason: `duplicate key "${key}" - already mapped on line ${firstSeenAt}`,
      });
      return;
    }

    seen.set(key, line);
    result.entries.push({ key, memberId: memberId.toUpperCase() });
  });

  return result;
}

/**
 * Flatten a parsed free-text identity map into the lookup the renderer uses.
 *
 * Malformed lines are skipped: a report generated from a partly-broken map still
 * mentions everyone who parsed, and the errors surface at settings-save where they
 * can be fixed. Callers that need to block on them read `parseIdentityMap` instead.
 */
export function buildIdentityLookup(input: string | null | undefined): IdentityLookup {
  return parseIdentityMap(input).entries.reduce<IdentityLookup>((lookup, entry: ParsedIdentityMapEntry) => {
    lookup[entry.key] = entry.memberId;
    return lookup;
  }, {});
}
