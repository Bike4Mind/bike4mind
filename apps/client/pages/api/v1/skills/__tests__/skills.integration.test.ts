// @vitest-environment node
/**
 * The /api/v1/skills routes through the REAL baseApi chain (apiKeyAuth and the scope gate included),
 * the SKILL.md parser and the shared validators, with only the skill repository and the organization
 * check mocked. Proves scopes reach the gate, JWT still works, SKILL.md errors are actionable 400s,
 * and every body renders as the contract's snake_case schema.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  validate: vi.fn(),
  findUser: vi.fn(),
  keyRateLimit: vi.fn(),
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  search: vi.fn(),
  verifyOrg: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => h.keyRateLimit(...a),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => h.validate(...a),
    },
  };
});
vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), {
      findById: (...a: unknown[]) => h.findUser(...a),
      updateMany: vi.fn().mockResolvedValue(undefined),
    }),
    userRepository: { findById: (...a: unknown[]) => h.findUser(...a) },
    skillRepository: {
      findById: (...a: unknown[]) => h.findById(...a),
      create: (...a: unknown[]) => h.create(...a),
      updateIfNonGlobal: (...a: unknown[]) => h.update(...a),
      searchAccessible: (...a: unknown[]) => h.search(...a),
    },
  };
});
// A JWT caller is the one with `Authorization: Bearer jwt`; anyone else without a key is a 401.
vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth: (req: any, res: any, next: any) => {
    if (req.user) return next();
    if (req.headers.authorization !== 'Bearer jwt') return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: 'user-1', _id: 'user-1', groups: [], isBanned: false, disputePending: false };
    next();
  },
}));
vi.mock('@bike4mind/server-utils/utils/orgAccess', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  verifyOrgAccess: (...a: unknown[]) => h.verifyOrg(...a),
}));

import {
  ApiKeyScope,
  MySkillsResponseSchema,
  PublicSkillSchema,
  SaveSkillResponseSchema,
  type ISkill,
} from '@bike4mind/common';
import { encodeCursor } from '@server/utils/cursorPagination';
import createHandler from '../index';
import mineHandler from '../mine';
import byIdHandler from '../[id]';

const SKILL_ID = '65a000000000000000000001';
const ORG_ID = '65a0000000000000000000aa';
const CREATED = new Date('2026-01-01T00:00:00.000Z');

const SKILL: ISkill = {
  id: SKILL_ID,
  name: 'review-pr',
  description: 'Review a pull request.',
  body: 'Read the diff.',
  userId: 'user-1',
  claudeCodeAllowedTools: ['Read'],
  files: [{ path: 'scripts/lint.sh', content: 'echo hi\n' }],
  createdAt: CREATED,
  updatedAt: CREATED,
};

const SKILL_MD = '---\nname: review-pr\ndescription: Review a pull request.\n---\n\nRead the diff.\n';

function withScopes(scopes: ApiKeyScope[]) {
  h.validate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

type Caller = 'key' | 'jwt' | 'none';
type FireInit = { method: 'GET' | 'POST' | 'PUT'; url: string; query?: object; body?: object };

// any: the handlers' Express-typed params vs node-mocks-http mocks.
/* eslint-disable @typescript-eslint/no-explicit-any */
async function fire(handler: any, init: FireInit, caller: Caller = 'key') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (caller === 'key') headers['x-api-key'] = 'sk-test-valid-key';
  if (caller === 'jwt') headers.authorization = 'Bearer jwt';
  const { req, res } = createMocks({ ...init, headers } as never, { eventEmitter: EventEmitter });
  await handler(req, res);
  return res;
}

const create = (body: object = { skill_md: SKILL_MD }, caller?: Caller) =>
  fire(createHandler, { method: 'POST', url: '/api/v1/skills', body }, caller);
const update = (body: object = { skill_md: SKILL_MD }, caller?: Caller, id = SKILL_ID) =>
  fire(byIdHandler, { method: 'PUT', url: `/api/v1/skills/${id}`, query: { id }, body }, caller);
const get = (caller?: Caller, id = SKILL_ID) =>
  fire(byIdHandler, { method: 'GET', url: `/api/v1/skills/${id}`, query: { id } }, caller);
const mine = (query: object = {}, caller?: Caller) =>
  fire(mineHandler, { method: 'GET', url: '/api/v1/skills/mine', query }, caller);

beforeEach(() => {
  vi.clearAllMocks();
  h.findUser.mockResolvedValue({
    id: 'user-1',
    _id: 'user-1',
    groups: [],
    level: 'PaidUser',
    isBanned: false,
    disputePending: false,
  });
  h.keyRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  h.findById.mockResolvedValue(SKILL);
  h.create.mockImplementation(async (data: object) => ({ ...SKILL, ...data }));
  h.update.mockImplementation(async (patch: object) => ({ ...SKILL, ...patch }));
  h.search.mockResolvedValue({ data: [SKILL], hasMore: false, total: 1 });
  h.verifyOrg.mockResolvedValue({ id: ORG_ID });
});

const ROUTES = {
  create: (c?: Caller) => create(undefined, c),
  update: (c?: Caller) => update(undefined, c),
  get: (c?: Caller) => get(c),
  mine: (c?: Caller) => mine({}, c),
};
type RouteName = keyof typeof ROUTES;

const DOMAIN_CALL: Record<RouteName, ReturnType<typeof vi.fn>> = {
  create: h.create,
  update: h.update,
  get: h.findById,
  mine: h.search,
};

// [route, success status, a scope that must be refused, the contract's accepted scopes]
const MATRIX: [RouteName, number, ApiKeyScope, ApiKeyScope[]][] = [
  ['create', 201, ApiKeyScope.SKILLS_READ, [ApiKeyScope.SKILLS_WRITE]],
  ['update', 200, ApiKeyScope.SKILLS_READ, [ApiKeyScope.SKILLS_WRITE]],
  ['get', 200, ApiKeyScope.SKILLS_READ, [ApiKeyScope.SKILLS_WRITE]],
  ['mine', 200, ApiKeyScope.SKILLS_READ, [ApiKeyScope.SKILLS_WRITE]],
];

describe('/api/v1/skills scope enforcement (real middleware chain)', () => {
  it.each(MATRIX)('%s: a skills:write key succeeds (%i)', async (route, status) => {
    withScopes([ApiKeyScope.SKILLS_WRITE]);
    expect((await ROUTES[route]())._getStatusCode()).toBe(status);
  });

  it.each(MATRIX)(
    '%s: a key without an accepted scope is a 403 before the domain call',
    async (route, _s, wrong, accepted) => {
      withScopes([wrong]);
      const res = await ROUTES[route]();
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual(accepted);
      expect(DOMAIN_CALL[route]).not.toHaveBeenCalled();
    }
  );

  it.each(MATRIX)('%s: an invalid key is a 401', async route => {
    h.validate.mockResolvedValue({ isValid: false });
    expect((await ROUTES[route]())._getStatusCode()).toBe(401);
    expect(DOMAIN_CALL[route]).not.toHaveBeenCalled();
  });

  it.each(MATRIX)('%s: a JWT caller still succeeds (%i)', async (route, status) => {
    expect((await ROUTES[route]('jwt'))._getStatusCode()).toBe(status);
  });

  it('a confined skills:read key is refused on every route', async () => {
    withScopes([ApiKeyScope.SKILLS_READ]);
    for (const route of Object.keys(ROUTES) as RouteName[]) {
      expect((await ROUTES[route]())._getStatusCode()).toBe(403);
    }
  });
});

describe('POST /api/v1/skills', () => {
  beforeEach(() => withScopes([ApiKeyScope.SKILLS_WRITE]));

  it('creates a user-scoped skill from a SKILL.md and renders the snake_case schema', async () => {
    const res = await create({ skill_md: SKILL_MD, files: { 'scripts/lint.sh': 'echo hi\n' } });
    expect(res._getStatusCode()).toBe(201);
    const body = SaveSkillResponseSchema.strict().parse(res._getJSONData());
    expect(body).toMatchObject({
      id: SKILL_ID,
      name: 'review-pr',
      scope: 'user',
      organization_id: null,
      dropped_fields: [],
    });
    expect(body.url.endsWith(`/skills/${SKILL_ID}`)).toBe(true);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'review-pr',
        description: 'Review a pull request.',
        body: 'Read the diff.',
        userId: 'user-1',
        files: [{ path: 'scripts/lint.sh', content: 'echo hi\n' }],
        isGlobalRead: false,
        isGlobalWrite: false,
      })
    );
  });

  it('keeps the Claude Code tools and model, and reports no dropped keys', async () => {
    const md = '---\nname: a-skill\ndescription: d\nallowed-tools: Read, Bash(git add:*)\nmodel: opus\n---\n\nBody\n';
    const res = await create({ skill_md: md });
    expect(res._getStatusCode()).toBe(201);
    const body = SaveSkillResponseSchema.strict().parse(res._getJSONData());
    expect(body.dropped_fields).toEqual([]);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ claudeCodeAllowedTools: ['Read', 'Bash(git add:*)'], claudeCodeModel: 'opus' })
    );
  });

  it.each([
    ['no frontmatter', 'Just a body', /No frontmatter found/],
    ['malformed YAML', '---\nname: "oops\ndescription: d\n---\nBody', /quote that is never closed/],
    ['no name', '---\ndescription: d\n---\nBody', /needs a `name`/],
    ['no description', '---\nname: a-skill\n---\nBody', /needs a `description`/],
    ['a bad name', '---\nname: Bad Name\ndescription: d\n---\nBody', /kebab-case/],
    ['a long description', `---\nname: a-skill\ndescription: ${'x'.repeat(501)}\n---\nBody`, /500 characters or fewer/],
    ['an empty body', '---\nname: a-skill\ndescription: d\n---\n', /body is required/],
    ['a NUL byte', '---\nname: a-skill\ndescription: d\n---\nBo\u0000dy', /not a text file/],
  ])('rejects %s with a 400 that says what to fix', async (_label, skill_md, message) => {
    const res = await create({ skill_md });
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(message);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('rejects a file outside scripts/ and references/ with a 400', async () => {
    const res = await create({ skill_md: SKILL_MD, files: { 'notes.md': 'x' } });
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/scripts\/ or references\//);
  });

  it('rejects an unknown body field with a 422, including system scope', async () => {
    expect((await create({ skill_md: SKILL_MD, skillMd: 'x' }))._getStatusCode()).toBe(422);
    expect((await create({ skill_md: SKILL_MD, scope: { is_system: true } }))._getStatusCode()).toBe(422);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('creates an organization skill only after the organization check passes', async () => {
    const res = await create({ skill_md: SKILL_MD, scope: { organization_id: ORG_ID } });
    expect(res._getStatusCode()).toBe(201);
    expect(h.verifyOrg).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1' }), ORG_ID);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_ID }));
    expect(h.create.mock.calls[0][0]).not.toHaveProperty('userId');
  });

  it("answers 404 when the organization is not the caller's or its id is malformed", async () => {
    const { NotFoundError } = await import('@bike4mind/common');
    h.verifyOrg.mockRejectedValue(new NotFoundError('Organization not found'));
    expect((await create({ skill_md: SKILL_MD, scope: { organization_id: ORG_ID } }))._getStatusCode()).toBe(404);
    expect((await create({ skill_md: SKILL_MD, scope: { organization_id: 'nope' } }))._getStatusCode()).toBe(404);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('answers 409 for a duplicate name', async () => {
    h.create.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    const res = await create();
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData().error).toBe('A skill named "review-pr" already exists');
  });
});

describe('PUT /api/v1/skills/{id}', () => {
  beforeEach(() => withScopes([ApiKeyScope.SKILLS_WRITE]));

  it('replaces the content, clears what the SKILL.md omits and keeps files unless sent', async () => {
    const res = await update({ skill_md: '---\nname: review-pr\ndescription: New.\n---\n\nNew body\n' });
    expect(res._getStatusCode()).toBe(200);
    SaveSkillResponseSchema.strict().parse(res._getJSONData());
    const [patch, options] = h.update.mock.calls[0];
    expect(patch).toEqual({
      id: SKILL_ID,
      name: 'review-pr',
      description: 'New.',
      body: 'New body',
      claudeCodeAllowedTools: [],
      claudeCodeModel: '',
      disableModelInvocation: false,
    });
    expect(options).toMatchObject({ unset: ['argumentHint'] });
  });

  it('writes the SKILL.md model and returns it as claude_code_model', async () => {
    h.update.mockImplementationOnce(async (patch: Partial<ISkill>) => ({ ...SKILL, ...patch }));
    const res = await update({ skill_md: '---\nname: review-pr\ndescription: New.\nmodel: haiku\n---\n\nNew body\n' });
    expect(res._getStatusCode()).toBe(200);
    expect(h.update.mock.calls[0][0]).toMatchObject({ claudeCodeModel: 'haiku' });
    expect(SaveSkillResponseSchema.strict().parse(res._getJSONData()).claude_code_model).toBe('haiku');
  });

  it('replaces the files when sent, and clears them with an empty map', async () => {
    await update({ skill_md: SKILL_MD, files: { 'references/a.md': 'a' } });
    expect(h.update.mock.calls[0][0].files).toEqual([{ path: 'references/a.md', content: 'a' }]);
    await update({ skill_md: SKILL_MD, files: {} });
    expect(h.update.mock.calls[1][0].files).toEqual([]);
  });

  it('keeps the current name when the SKILL.md has none', async () => {
    const res = await update({ skill_md: '---\ndescription: New.\n---\n\nNew body\n' });
    expect(res._getStatusCode()).toBe(200);
    expect(h.update.mock.calls[0][0]).not.toHaveProperty('name');
  });

  it('refuses a rename with a 409 that names the flag, and applies it with allow_rename', async () => {
    const renamed = '---\nname: new-name\ndescription: d\n---\n\nBody\n';
    const refused = await update({ skill_md: renamed });
    expect(refused._getStatusCode()).toBe(409);
    expect(refused._getJSONData().error).toMatch(/"review-pr" to "new-name".*allow_rename/);
    expect(h.update).not.toHaveBeenCalled();

    const applied = await update({ skill_md: renamed, allow_rename: true });
    expect(applied._getStatusCode()).toBe(200);
    expect(applied._getJSONData().name).toBe('new-name');
  });

  it('answers 400 for an invalid name before the rename check', async () => {
    const res = await update({ skill_md: '---\nname: Review-PR\ndescription: d\n---\n\nBody\n' });
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/kebab-case/);
  });

  it('answers 409 when the new name is taken', async () => {
    h.update.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    const res = await update({ skill_md: '---\nname: taken\ndescription: d\n---\n\nBody\n', allow_rename: true });
    expect(res._getStatusCode()).toBe(409);
  });

  it('answers 400 for an invalid SKILL.md without writing', async () => {
    const res = await update({ skill_md: 'no frontmatter' });
    expect(res._getStatusCode()).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing skill, a malformed id and a skill the caller cannot see', async () => {
    h.findById.mockResolvedValueOnce(null);
    expect((await update())._getStatusCode()).toBe(404);
    expect((await update(undefined, undefined, 'nope'))._getStatusCode()).toBe(404);
    h.findById.mockResolvedValueOnce({ ...SKILL, userId: 'someone-else' });
    expect((await update())._getStatusCode()).toBe(404);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('answers 403 for a skill the caller can read but not edit', async () => {
    h.findById.mockResolvedValue({ ...SKILL, userId: 'someone-else', isGlobalRead: true });
    const res = await update();
    expect(res._getStatusCode()).toBe(403);
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/skills/{id} and /mine', () => {
  beforeEach(() => withScopes([ApiKeyScope.SKILLS_WRITE]));

  it('returns the skill with its body and files', async () => {
    const body = PublicSkillSchema.strict().parse((await get())._getJSONData());
    expect(body).toMatchObject({
      id: SKILL_ID,
      body: 'Read the diff.',
      claude_code_allowed_tools: ['Read'],
      files: [{ path: 'scripts/lint.sh', content: 'echo hi\n' }],
      file_count: 1,
    });
  });

  it('returns claude_code_model only when the skill has one', async () => {
    expect(PublicSkillSchema.strict().parse((await get())._getJSONData())).not.toHaveProperty('claude_code_model');
    h.findById.mockResolvedValue({ ...SKILL, claudeCodeModel: 'opus' });
    expect(PublicSkillSchema.strict().parse((await get())._getJSONData()).claude_code_model).toBe('opus');
  });

  it('answers 404 for a skill the caller cannot see', async () => {
    h.findById.mockResolvedValue({ ...SKILL, userId: 'someone-else' });
    expect((await get())._getStatusCode()).toBe(404);
  });

  it('lists claude_code_model on mine only for skills that have one', async () => {
    h.search.mockResolvedValue({ data: [{ ...SKILL, claudeCodeModel: 'opus' }, SKILL], hasMore: false, total: 2 });
    const body = MySkillsResponseSchema.strict().parse((await mine())._getJSONData());
    expect(body.data[0].claude_code_model).toBe('opus');
    expect(body.data[1]).not.toHaveProperty('claude_code_model');
  });

  it('lists your own skills without bodies, filtered to the caller', async () => {
    const res = await mine({ q: 'review' });
    const body = MySkillsResponseSchema.strict().parse(res._getJSONData());
    expect(body.next_cursor).toBeNull();
    expect(body.data[0]).not.toHaveProperty('body');
    expect(h.search).toHaveBeenCalledWith(
      'user-1',
      'review',
      { query: { userId: 'user-1' } },
      { page: 1, limit: 25 },
      { by: 'updatedAt', direction: 'desc' },
      undefined
    );
  });

  it('pages with an opaque cursor that is bound to the limit', async () => {
    h.search.mockResolvedValue({ data: [SKILL], hasMore: true, total: 3 });
    const first = (await mine({ limit: '1' }))._getJSONData();
    expect(first.next_cursor).toEqual(expect.any(String));
    await mine({ limit: '1', cursor: first.next_cursor });
    expect(h.search.mock.calls[1][3]).toEqual({ page: 2, limit: 1 });
    expect((await mine({ limit: '2', cursor: first.next_cursor }))._getStatusCode()).toBe(422);
    expect((await mine({ cursor: encodeCursor('other.scope', '2:25') }))._getStatusCode()).toBe(422);
  });

  it("lists an organization's skills only after the organization check passes", async () => {
    await mine({ organization_id: ORG_ID });
    expect(h.verifyOrg).toHaveBeenCalled();
    expect(h.search.mock.calls[0][2]).toEqual({ query: { organizationId: ORG_ID } });
    expect((await mine({ organization_id: 'nope' }))._getStatusCode()).toBe(404);
  });
});
