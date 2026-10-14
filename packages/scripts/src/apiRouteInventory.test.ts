import { describe, expect, it } from 'vitest';
import {
  analyzeRouteSource,
  buildScopeTable,
  contractIndexFromOpenApi,
  extractApiPaths,
  formatCallerPath,
  matchCallerPath,
  reexportedDefault,
  renderInventoryMarkdown,
  routeFromFile,
  routeMatchers,
  type ContractIndex,
  type RouteRecord,
} from './apiRouteInventory';

const scopeTable = buildScopeTable({
  'UserApiKeyTypes.ts': `export enum ApiKeyScope { READ_PROJECTS = 'projects:read', WRITE_PROJECTS = 'projects:write', ADMIN = 'admin:*' }`,
  'projectScopes.ts': `
    export const PROJECTS_READ_SCOPES: ApiKeyScope[] = [ApiKeyScope.READ_PROJECTS];
    export const PROJECTS_READ_OR_WRITE_SCOPES = [...PROJECTS_READ_SCOPES, ApiKeyScope.WRITE_PROJECTS] as const;
  `,
});
const noContracts: ContractIndex = new Map();

const analyze = (text: string, route = '/api/thing', contracts = noContracts, exportName?: string) =>
  analyzeRouteSource('route.ts', text, route, scopeTable, contracts, exportName);

describe('routeFromFile', () => {
  it('maps a pages/api file to its URL path', () => {
    expect(routeFromFile('apps/client/pages/api/sessions/[id]/index.ts')).toBe('/api/sessions/[id]');
    expect(routeFromFile('apps/client/pages/api/chat.ts')).toBe('/api/chat');
    expect(routeFromFile('apps/client/pages/api/x/[id]/data/[dataId].tsx')).toBe('/api/x/[id]/data/[dataId]');
  });

  it('skips tests, which Next would otherwise serve as routes', () => {
    expect(routeFromFile('apps/client/pages/api/__tests__/chat.test.ts')).toBeNull();
    expect(routeFromFile('apps/client/pages/api/chat.test.ts')).toBeNull();
  });
});

describe('analyzeRouteSource', () => {
  it('reads baseApi defaults as JWT-or-API-key with the registered verbs', () => {
    const result = analyze(`const handler = baseApi().get<Req<X>>(a).post(b); export default handler;`);
    expect(result).toEqual({
      methods: ['GET', 'POST'],
      acceptsAnyMethod: false,
      auth: ['jwt+key'],
      scopes: [],
      contracted: false,
    });
  });

  it('reads the auth option', () => {
    expect(analyze(`baseApi({ auth: 'jwtOnly' }).get(a)`).auth).toEqual(['jwt']);
    expect(analyze(`baseApi({ auth: false }).get(a)`).auth).toEqual(['none']);
    expect(analyze(`import { optionalAuth } from 'x'; baseApi({ auth: false }).use(optionalAuth).get(a)`).auth).toEqual(
      ['optional']
    );
    expect(analyze(`baseApi({ auth: !isDev }).get(a)`).auth).toEqual(['unknown']);
  });

  it('resolves inline, imported and spread scope arrays to scope strings', () => {
    expect(analyze(`baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(a)`).scopes).toEqual(['admin:*']);
    expect(analyze(`baseApi({ requiredScopes: PROJECTS_READ_OR_WRITE_SCOPES }).get(a)`).scopes).toEqual([
      'projects:read',
      'projects:write',
    ]);
  });

  it('keeps an unresolvable scope visible instead of dropping it', () => {
    expect(analyze(`baseApi({ requiredScopes: SOMEWHERE_ELSE }).get(a)`).scopes).toEqual(['?SOMEWHERE_ELSE']);
  });

  it('reads options passed as a same-file constant', () => {
    const result = analyze(`const OPTIONS = { requiredScopes: [ApiKeyScope.ADMIN] }; baseApi(OPTIONS).get(a);`);
    expect(result.auth).toEqual(['jwt+key']);
    expect(result.scopes).toEqual(['admin:*']);
  });

  it('follows verbs registered on a bound router name, but not on unrelated objects', () => {
    const result = analyze(`
      const router = baseApi();
      const cache = new Map();
      router.put(async () => { cache.get('k'); cache.delete('k'); });
      export default router;
    `);
    expect(result.methods).toEqual(['PUT']);
  });

  it('flags a use()-only router as accepting any method', () => {
    expect(analyze(`export default baseApi().use(asyncHandler(a));`)).toMatchObject({
      methods: [],
      acceptsAnyMethod: true,
    });
  });

  it('marks a file without baseApi as custom auth with its method literals', () => {
    const result = analyze(
      `export default function handler(req, res) { if (req.method !== 'POST') return res.status(405).end(); }`
    );
    expect(result).toMatchObject({ methods: ['POST'], auth: ['custom'] });
  });

  it('takes a contracted route its auth and scopes from the OpenAPI operations it serves', () => {
    const contracts = contractIndexFromOpenApi({
      paths: {
        '/api/v1/things/{id}': {
          get: { security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], 'x-required-scopes': ['things:read'] },
          delete: { security: [{ jwtAuth: [] }] },
          put: { security: [] },
        },
      },
    });
    const result = analyze(
      `
      const getHandler = nextRouteForContract(getThingContract).get(a);
      const deleteHandler = nextRouteForContract(deleteThingContract).delete(b);
      export default dispatchByMethod({ GET: getHandler, DELETE: deleteHandler });
    `,
      '/api/v1/things/[thing_id]',
      contracts
    );
    expect(result).toEqual({
      methods: ['GET', 'DELETE'],
      acceptsAnyMethod: false,
      auth: ['jwt', 'jwt+key'],
      scopes: ['things:read'],
      contracted: true,
    });
  });

  it('narrows to one named router when an alias re-exports it', () => {
    const text = `
      const listRoute = nextRouteForContract(listContract).get(a);
      export const createRoute = baseApi({ auth: 'jwtOnly' }).post(b);
      export default dispatchByMethod({ GET: listRoute, POST: createRoute });
    `;
    expect(analyze(text, '/api/v1/things', noContracts, 'createRoute')).toMatchObject({
      methods: ['POST'],
      auth: ['jwt'],
      contracted: false,
    });
  });
});

describe('reexportedDefault', () => {
  it('finds a default or renamed default re-export from a relative module', () => {
    expect(reexportedDefault('a.ts', `export { default } from '../../v1/quests/[id]';`)).toEqual({
      specifier: '../../v1/quests/[id]',
      exportName: 'default',
    });
    expect(reexportedDefault('a.ts', `export { createSessionRouter as default } from '../v1/sessions';`)).toEqual({
      specifier: '../v1/sessions',
      exportName: 'createSessionRouter',
    });
  });

  it('ignores files that define their own handler or re-export from a package', () => {
    expect(reexportedDefault('a.ts', `export default baseApi().get(a);`)).toBeNull();
    expect(reexportedDefault('a.ts', `export { default } from '@bike4mind/premium-x/api';`)).toBeNull();
  });
});

describe('extractApiPaths', () => {
  const paths = (text: string) => extractApiPaths('caller.ts', text).map(formatCallerPath);

  it('reads string and template literals, with interpolations as parameters', () => {
    expect(paths(`api.get('/api/sessions'); api.post(\`/api/sessions/\${id}/clone\`);`)).toEqual([
      '/api/sessions',
      '/api/sessions/:param/clone',
    ]);
  });

  it('strips query strings, including one appended as a value', () => {
    expect(paths(`api.get(\`/api/files?page=\${page}\`); api.get(\`/api/files\${query}\`);`)).toEqual([
      '/api/files',
      '/api/files',
    ]);
  });

  it('resolves a same-file base constant and string concatenation', () => {
    expect(
      paths(`const BASE = '/api/admin/rules'; api.put(\`\${BASE}/\${id}\`); api.get('/api/users/' + id);`)
    ).toEqual(['/api/admin/rules', '/api/admin/rules/:param', '/api/users/:param']);
  });

  it('ignores prefix checks and non-API strings', () => {
    expect(paths(`if (url.startsWith('/api/')) {} const x = '/apidocs'; const y = \`\${host}/api/x\`;`)).toEqual([]);
  });
});

describe('matchCallerPath', () => {
  const matchers = routeMatchers([
    '/api/sessions',
    '/api/sessions/[id]',
    '/api/sessions/create',
    '/api/[type]/[id]',
    '/api/[...unmatched]',
  ]);
  const match = (text: string) => matchCallerPath(extractApiPaths('c.ts', text)[0], matchers);

  it('prefers static over dynamic over catch-all segments, as Next does', () => {
    expect(match(`'/api/sessions/create'`)).toEqual(['/api/sessions/create']);
    expect(match(`\`/api/sessions/\${id}\``)).toEqual(['/api/sessions/[id]']);
    expect(match(`'/api/invites/abc'`)).toEqual(['/api/[type]/[id]']);
    expect(match(`'/api/no/such/route'`)).toEqual(['/api/[...unmatched]']);
  });

  it('does not let a parameter stand in for a static segment', () => {
    expect(match(`\`/api/\${kind}\``)).toEqual(['/api/[...unmatched]']);
  });
});

describe('renderInventoryMarkdown', () => {
  const record = (overrides: Partial<RouteRecord>): RouteRecord => ({
    route: '/api/x',
    file: 'x.ts',
    methods: ['GET'],
    acceptsAnyMethod: false,
    auth: ['jwt+key'],
    scopes: [],
    contracted: false,
    callers: [],
    ...overrides,
  });

  it('groups by area, sorts rows, and is free of timestamps so it diffs cleanly', () => {
    const records = [
      record({ route: '/api/sessions/[id]', callers: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }),
      record({ route: '/api/quests/[id]', aliasOf: '/api/v1/quests/[id]', contracted: true }),
      record({ route: '/api/sessions', methods: [], acceptsAnyMethod: true }),
    ];
    const markdown = renderInventoryMarkdown(records);
    expect(markdown).toBe(renderInventoryMarkdown([...records].reverse()));
    expect(markdown).toContain('3 routes: 0 contracted, 1 aliases of another route, 2 with no static caller');
    expect(markdown.indexOf('### quests')).toBeLessThan(markdown.indexOf('### sessions'));
    expect(markdown).toContain('| `/api/quests/[id]` | GET | jwt+key | - | yes | `/api/v1/quests/[id]` | 0 |');
    expect(markdown).toContain('| `/api/sessions` | any |');
    expect(markdown).toContain('4: `a.ts`, `b.ts`, `c.ts` +1 more');
  });

  it('lists client paths with no route once each', () => {
    const markdown = renderInventoryMarkdown(
      [record({})],
      [
        { path: '/api/gone', caller: 'hooks/gone.ts' },
        { path: '/api/gone', caller: 'hooks/gone.ts' },
      ]
    );
    expect(markdown.match(/\| `\/api\/gone` \| `hooks\/gone.ts` \|/g)).toHaveLength(1);
  });
});
