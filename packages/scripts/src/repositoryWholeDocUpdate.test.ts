import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Source scan guarding against whole-document repository writes.
 *
 * `BaseRepository.update(data)` (b4m-core/db-core/src/models/BaseModel.ts) `$set`s every key on
 * `data`. Handing it a hydrated doc writes the whole read-time snapshot back: it reverts concurrent
 * atomic writes (`$inc` credits, `$push` shares) and re-writes `deletedAt: null`, resurrecting a doc
 * soft-deleted in the meantime. Call sites must pass only the fields they changed
 * (`{ id: doc.id, status }`) or use an atomic repo method. Nothing else fails when someone writes
 * `db.quests.update(quest)`, so this scan is the only guard.
 *
 * Flags a repository-shaped receiver (`db.<coll>`, `...Repository`) whose `.update(` first argument
 * is a bare identifier / member expression, or an object literal that opens with a spread of one
 * (`{ ...doc, x }`) or spreads the doc it takes its id from (`{ id: doc.id, ...doc }`), the same
 * hazard. Object literals naming their fields (`{ id, status }`, `{ id, ...changes }`) pass.
 *
 * Not covered: dynamic receivers (`db[name].update(x)`), non-repository receivers (`this.repo`,
 * `deps.users`), and a doc spread under a bare id (`{ id, ...doc }`), which is indistinguishable
 * from the sanctioned `{ id, ...changes }` without type information.
 *
 * ALLOWED is keyed by `relpath::argText` (not line number, so edits do not churn it). Each entry
 * must match exactly its expected number of sites (1 unless SITE_COUNT says otherwise), so a stale
 * entry fails and so does a NEW same-shaped write in an allow-listed file. ALLOWED_ENTRIES pins the
 * list's size, so adding an entry means raising it in the same diff, where review sees it; lower it
 * whenever an entry is converted.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCAN_ROOTS = ['apps', 'b4m-core', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.sst', 'build', '__tests__', '__test__', 'coverage']);

const PARTIAL = 'already a built partial of the changed fields';
const PASSTHROUGH = 'adapter passthrough; the service builds a targeted partial';
const ALLOWED = new Map<string, string>([
  [
    'packages/scripts/migrate/migrations/20250321142457_add-user-details-to-org.ts::organization',
    'historical migration, never re-run',
  ],
  [
    'b4m-core/services/src/llm/ChatCompletionProcess.ts::quest',
    'saveQuest: deliberate whole-doc write by the streaming owner (see comment there)',
  ],
  ['b4m-core/services/src/userApiKeyService/updateEmbedKey.ts::patch', PARTIAL],
  ['apps/client/pages/api/email/change.ts::user', PASSTHROUGH],
  ['apps/client/pages/api/email/verify-change.ts::user', PASSTHROUGH],
  ['apps/client/pages/api/research/agents/[id]/tasks/[taskId]/data/[dataId].tsx::fabFile', PASSTHROUGH],
  ['apps/client/pages/api/research/agents/[id]/tasks/[taskId]/data/[dataId].tsx::user', PASSTHROUGH],
  ['apps/client/pages/api/research/agents/[id]/tasks/[taskId]/data/[dataId].tsx::session', PASSTHROUGH],
  ['apps/client/pages/api/admin/team-members.ts::payload', 'parsed request body'],
  ['apps/client/pages/api/agents/[id]/index.ts::agentData', 'validated request body plus id'],
  ['apps/client/pages/api/quest-plans/[id]/index.ts::changes', PARTIAL],
  ['apps/client/pages/api/sessions/[id]/agents/[agentId]/config.ts::patch', 'leaf paths of the validated body'],
  ['apps/client/pages/api/secret-rotations/[id]/index.ts::params', 'parsed request body'],
  ['apps/client/pages/api/skills/[id]/index.ts::patch', PARTIAL],
  ['apps/client/pages/api/sre/patterns/[id].ts::updates', PARTIAL],
  ['b4m-core/auth/src/mfaService/verify.ts::updateData', PARTIAL],
  ['b4m-core/services/src/artifactService/delete.ts::updateData', PARTIAL],
  ['b4m-core/services/src/artifactService/update.ts::updateData', PARTIAL],
  ['b4m-core/services/src/fabFileService/edit.ts::updatedFile', PARTIAL],
  ['b4m-core/services/src/latticeService/latticeModelService.ts::updateData', PARTIAL],
  ['b4m-core/services/src/latticeService/latticeModelService.ts::updatedModel', PARTIAL],
  ['b4m-core/services/src/organizationService/update.ts::update', PARTIAL],
  ['b4m-core/services/src/promptService/update.ts::params', 'validated partial params'],
  ['b4m-core/services/src/researchTaskService/update.ts::changes', PARTIAL],
  ['b4m-core/services/src/tagService/update.ts::buildData', 'id plus validated params'],
  ['b4m-core/services/src/userService/adminUpdate.ts::writeData', 'built by toUserUpdatePartial'],
  ['packages/scripts/generateAgentSystemPrompts.ts::updateData', PARTIAL],
]);
const ALLOWED_ENTRIES = 27;
const SITE_COUNT = new Map<string, number>([
  ['b4m-core/services/src/latticeService/latticeModelService.ts::updatedModel', 3],
]);

const RECEIVER = /(?:^|[^\w$.])((?:[\w$]+[?!]?\.)*[\w$]+)[?!]?\s*\.update(?:<(?:[^<>()]|<[^<>()]*>)*>)?\(/g;
const isRepositoryReceiver = (r: string) => /Repository$/.test(r) || /(?:^|\.)db\.[\w$]+$/.test(r);

/** Returns the first-argument text of the call whose `(` is at `open`, or null when unbalanced. */
function firstArg(src: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i).trim();
    } else if (ch === ',' && depth === 1) return src.slice(open + 1, i).trim();
  }
  return null;
}

/** Blanks out comments (keeping newlines, so line numbers hold) so prose quoting a call is not a hit. */
function stripComments(src: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === '\\') out += src[++i] ?? '';
      else if (ch === quote) quote = null;
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      out += ch;
    }
  }
  return out;
}

/** Expressions spread at the top level of an object-literal argument (`{ a, ...x, b: { ...y } }` -> ['x']). */
function topLevelSpreads(arg: string): string[] {
  const spreads: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (depth === 1 && arg.startsWith('...', i)) {
      const m = /^\.\.\.\(?([\w$]+(?:[?!]?\.[\w$]+)*)/.exec(arg.slice(i));
      if (m) spreads.push(m[1]);
    }
  }
  return spreads;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MEMBER = String.raw`[\w$]+(?:[?!]?\.[\w$]+)*`;

const isWholeDoc = (arg: string) =>
  // `doc`, `req.user`, `doc!`, `doc as IDoc`, `doc.toObject()`, `Object.assign(doc, ...)`
  new RegExp(String.raw`^${MEMBER}!?(?:\s+as\s+[\w$.<>\[\], ]+)?$`).test(arg) ||
  new RegExp(String.raw`^${MEMBER}\.to(?:Object|JSON)\(\)$`).test(arg) ||
  /^Object\.assign\(\s*[\w$]/.test(arg) ||
  // `{ ...doc, x }`, `{ ...doc.toObject(), x }`, `{ ...(doc as IDoc) }`
  /^\{\s*\.\.\.\(?[\w$.]+/.test(arg) ||
  // `{ id: doc.id, ...doc }`: spreads the doc it takes its id from
  (arg.startsWith('{') &&
    topLevelSpreads(arg).some(e => new RegExp(String.raw`(?:^|[^\w$.])${escapeRegExp(e)}\??\.`).test(arg)));

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      yield path.join(dir, entry.name);
    }
  }
}

function scan() {
  const hits: { key: string; line: number }[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.join(REPO_ROOT, root))) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      const rel = path.relative(REPO_ROOT, file);
      for (const m of src.matchAll(RECEIVER)) {
        if (!isRepositoryReceiver(m[1])) continue;
        const open = m.index! + m[0].length - 1;
        const arg = firstArg(src, open);
        if (arg === null || !isWholeDoc(arg)) continue;
        hits.push({ key: `${rel}::${arg}`, line: src.slice(0, open).split('\n').length });
      }
    }
  }
  return hits;
}

describe('repository whole-document update guard', () => {
  const hits = scan();

  it('finds no whole-document repository .update() outside ALLOWED', () => {
    const offenders = hits.filter(h => !ALLOWED.has(h.key)).map(h => `${h.key.replace('::', `:${h.line} `)}`);
    expect(offenders, 'pass only the changed fields ({ id: doc.id, ...changed }) or use an atomic repo method').toEqual(
      []
    );
  });

  it('keeps ALLOWED at its pinned size', () => {
    expect(ALLOWED.size, 'convert the new site instead, or raise ALLOWED_ENTRIES deliberately').toBe(ALLOWED_ENTRIES);
  });

  it('matches each ALLOWED entry to exactly its expected number of sites', () => {
    const counts = new Map<string, number>();
    for (const h of hits) counts.set(h.key, (counts.get(h.key) ?? 0) + 1);
    const mismatched = [...ALLOWED.keys()]
      .map(k => ({ key: k, expected: SITE_COUNT.get(k) ?? 1, actual: counts.get(k) ?? 0 }))
      .filter(e => e.actual !== e.expected);
    expect(mismatched, 'drop a stale entry, or convert the new site instead of raising SITE_COUNT').toEqual([]);
  });

  it('classifies argument shapes', () => {
    expect(isWholeDoc('quest')).toBe(true);
    expect(isWholeDoc('req.user')).toBe(true);
    expect(isWholeDoc('{ ...project, name }')).toBe(true);
    expect(isWholeDoc('{ id: quest.id, status }')).toBe(false);
    expect(isWholeDoc('{ id, ...changes }')).toBe(false);
    expect(isWholeDoc('{ id: doc.id, ...doc }')).toBe(true);
    expect(isWholeDoc('{ id: doc.id, status, ...doc }')).toBe(true);
    expect(isWholeDoc('{ id: quest.id, ...changes }')).toBe(false);
    expect(isWholeDoc('{ id: agent.id, visual: { ...agent.visual, portraitUrl } }')).toBe(false);
    expect(isWholeDoc("{ note: '{', ...user, id: user.id }")).toBe(true);
    expect(isWholeDoc("{ note: '}', x: { ...changes }, id: changes.id }")).toBe(false);
    expect(isWholeDoc('{ id: exchanges.id, ...changes }')).toBe(false);
    expect(isWholeDoc('user as IUser')).toBe(true);
    expect(isWholeDoc('user.toJSON()')).toBe(true);
    expect(isWholeDoc('Object.assign(user, { name })')).toBe(true);
    expect(isWholeDoc('{ ...user.toObject(), name }')).toBe(true);
    expect(isWholeDoc('{ ...(user as IUser) }')).toBe(true);
    expect(isWholeDoc('{ id, ...changes } as Partial<IUser>')).toBe(false);
  });

  it('matches generic receivers, one level of nesting deep', () => {
    const receivers = (src: string) => [...src.matchAll(RECEIVER)].map(m => m[1]);
    expect(receivers('userRepository.update<IUser>(user)')).toEqual(['userRepository']);
    expect(receivers('userRepository.update<Partial<IUser>>(user)')).toEqual(['userRepository']);
  });
});
