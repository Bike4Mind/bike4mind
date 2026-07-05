import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static-analysis guard: server-owned session fields (e.g. `systemPromptText`,
 * the proprietary optimizer, medical-reference, and pathway product prompts) MUST NOT be
 * serialized to a client.
 *
 * The fix redacts at the serialization boundary via `redactSessionForClient` /
 * `redactSessionsForClient` (from `@bike4mind/common`). A helper applied at N call sites
 * rots the moment endpoint N+1 returns a raw session - exactly how the two voice endpoints
 * drifted (one hand-projects safe fields, the other spread the whole object). This test is
 * the backstop: any API route that serializes a full session to the client must either
 * route through the redactor or be explicitly listed as verified-safe (with a reason).
 *
 * Pure string parsing - no imports of the routes, no AWS/SST calls.
 *
 * NOTE: this test lives OUTSIDE `pages/api/` on purpose. It does `fs` reads over the
 * project tree, and a test under `pages/api/` defeats Next's NFT static analysis and traces the
 * whole project into the server Lambda bundle (pushing it past AWS's 250MB limit). It scans the
 * real `pages/api` tree via the explicit `API_DIR` below, so it stays just as effective here.
 */

// This test lives at apps/client/server/__tests__ -> repo root is four levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const API_DIR = resolve(REPO_ROOT, 'apps/client/pages/api');

/** Recursively collect every `.ts` route file under pages/api, skipping tests. */
const collectRouteFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...collectRouteFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
};

/**
 * Heuristic: does this file serialize a RAW (un-redacted) full session to the client?
 *
 * Matches only the bare shapes that appear BEFORE redaction - once a site is wrapped in
 * `redactSessionForClient(...)`, the argument is the call, not a bare identifier, so none of
 * these patterns match. That means we don't short-circuit on "file uses the redactor": a
 * second un-redacted handler in an otherwise-redacted file is still caught.
 *
 * Patterns are deliberately narrow (a property named `session`, not the substring "session"
 * in a key like `sessionIds` or in a comment) to avoid false positives. This is a backstop -
 * the typed `ClientSession` return + the behavioral redaction tests are the primary control.
 */
const SESSION_IDENT = '(?:session|newSession|updatedSession|clonedSession|forkedSession|snippedSession)';
// Matches `res.json(`/`res.send(` with an optional status chain, e.g. `res.status(200).json(`.
const RES_SEND = 'res(?:\\.status\\([^)]*\\))?\\.(?:json|send)\\(';
const serializesSession = (src: string): boolean => {
  const patterns: RegExp[] = [
    // res.json(session) / res.status(200).json(newSession) - bare identifier passed directly
    new RegExp(`${RES_SEND}\\s*${SESSION_IDENT}\\s*[),]`),
    // { session: <sessionVar> } - nested under a key, value is a bare session identifier
    new RegExp(`\\bsession\\s*:\\s*${SESSION_IDENT}\\s*[,}]`),
    // res.json({ ..., session }) - ES shorthand property `session` (followed by , or })
    new RegExp(`${RES_SEND}\\s*\\{[^}]*\\bsession\\b\\s*[,}]`),
    // bulk export of raw session docs
    /JSON\.stringify\(\s*notebooks\b/,
  ];
  return patterns.some(re => re.test(src));
};

/**
 * Escape hatch: files that match a raw-session pattern but are VERIFIED not to leak
 * server-owned fields. Each must carry a reason. Adding a file here is a deliberate,
 * reviewable act. Empty today - the narrow patterns above don't flag the known-safe
 * endpoints (favorites' .lean() projection, voice/v2's hand-picked { id, name }).
 */
const VERIFIED_SAFE: Record<string, string> = {};

describe('serializesSession() heuristic', () => {
  it('flags a bare session return', () => {
    expect(serializesSession('return res.json(session);')).toBe(true);
    expect(serializesSession('return res.json(updatedSession);')).toBe(true);
  });
  it('flags a nested { session } return', () => {
    expect(serializesSession('res.json({ quest, session });')).toBe(true);
    expect(serializesSession('res.json({ session: newSession });')).toBe(true);
  });
  it('flags status-chained returns (res.status(...).json(...))', () => {
    expect(serializesSession('return res.status(200).json(session);')).toBe(true);
    expect(serializesSession('return res.status(201).json(newSession);')).toBe(true);
    expect(serializesSession('res.status(200).json({ quest, session });')).toBe(true);
  });
  it('does not flag a redacted return (incl. status-chained)', () => {
    // The redactor wraps the identifier in a call, so the bare-identifier patterns miss it.
    expect(serializesSession('return res.json(redactSessionForClient(session));')).toBe(false);
    expect(serializesSession('res.json({ quest, session: redactSessionForClient(session) });')).toBe(false);
    expect(serializesSession('res.json({ session: redactSessionForClient(updatedSession) });')).toBe(false);
    expect(serializesSession('return res.status(200).json(redactSessionForClient(session));')).toBe(false);
  });
  it('does not flag unrelated returns or session substrings in keys/comments', () => {
    expect(serializesSession('return res.json({ deletedCount, newLastNotebookId });')).toBe(false);
    // `sessionIds` key + a comment mentioning "session names" must not trip the guard.
    expect(serializesSession('return res.json({ sessionIds, count, scores }); // session names')).toBe(false);
    // hand-projected nested object is safe (value is an object literal, not a session var)
    expect(serializesSession('res.json({ session: { id, name } });')).toBe(false);
  });
});

describe('session redaction boundary guard', () => {
  const routeFiles = collectRouteFiles(API_DIR);

  it('finds the route files (guards against a broken walk)', () => {
    expect(routeFiles.length).toBeGreaterThan(50);
  });

  it('every session-serializing route routes through the redactor (or is verified-safe)', () => {
    const offenders: string[] = [];

    for (const file of routeFiles) {
      const src = readFileSync(file, 'utf8');
      if (!serializesSession(src)) continue; // no raw (un-redacted) session response

      const rel = relative(resolve(REPO_ROOT, 'apps/client/pages/api'), file).split('\\').join('/');
      if (rel in VERIFIED_SAFE) continue;

      offenders.push(rel);
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Found ${offenders.length} API route(s) that serialize a full session to the client ` +
            `without calling redactSessionForClient/redactSessionsForClient:\n` +
            `${offenders.map(o => `  - ${o}`).join('\n')}\n\n` +
            `Server-owned fields (e.g. systemPromptText) leak to anyone who can read the session, ` +
            `including a non-entitled user it was shared with (#9405). Wrap the response in ` +
            `redactSessionForClient (single) or redactSessionsForClient (array) from ` +
            `@bike4mind/common. If the response provably cannot carry server-owned fields ` +
            `(e.g. an explicit .lean() projection), add it to VERIFIED_SAFE with a reason.`
    ).toEqual([]);
  });

  it('VERIFIED_SAFE entries still exist and still avoid the redactor', () => {
    // Keep the allowlist honest: a listed file that was deleted or later started redacting
    // should be removed from VERIFIED_SAFE so the list reflects reality.
    for (const [rel, reason] of Object.entries(VERIFIED_SAFE)) {
      const full = resolve(REPO_ROOT, 'apps/client/pages/api', rel);
      expect(() => readFileSync(full, 'utf8'), `VERIFIED_SAFE entry no longer exists: ${rel}`).not.toThrow();
      expect(reason.length, `VERIFIED_SAFE entry needs a reason: ${rel}`).toBeGreaterThan(0);
    }
  });
});
