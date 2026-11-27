import { describe, expect, it } from 'vitest';
import {
  analyzeHandlerCoverage,
  AuditReachability,
  auditCoverageFailures,
  type CoverageRoute,
  type HandlerCoverage,
} from './adminAuditCoverage';
import { ADMIN_AUDIT_COVERAGE_EXEMPTIONS } from './adminAuditCoverageExemptions';
import { routeFromFile } from './apiRouteInventory';
import { ROOT, sourceFiles } from './apiRouteSources';

const ADMIN_API_DIR = 'apps/client/pages/api/admin';

const ROUTE = 'apps/client/pages/api/admin/thing.ts';

/** Coverage of `ROUTE` given in-memory sources; any file not listed does not exist. */
function coverageOf(sources: Record<string, string>): HandlerCoverage {
  return analyzeHandlerCoverage(new AuditReachability('/repo', file => sources[file] ?? null), ROUTE);
}

const audited = (coverage: HandlerCoverage) =>
  coverage.kind === 'analyzed'
    ? Object.fromEntries(coverage.verbs.map(({ method, witness }) => [method, witness !== null]))
    : coverage.kind;

describe('analyzeHandlerCoverage', () => {
  it('reads each verb on its own', () => {
    const route = `
      import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
      const handler = adminApi({})
        .get(async (req, res) => res.json([]))
        .put(async (req, res) => { await save(); await recordAdminActionFromRequest(req, { action: 'x' }); })
        .delete(async (req, res) => { await remove(); });
      export default handler;`;
    expect(audited(coverageOf({ [ROUTE]: route }))).toEqual({ PUT: true, DELETE: false });
  });

  it('follows a local function, a const router and an asyncHandler wrapper', () => {
    const route = `
      const api = baseApi({});
      async function persist(req) { await recordAdminAction({ action: 'x' }); }
      const handler = api.use(csrf()).post(asyncHandler(async (req, res) => persist(req)));
      export default handler;`;
    expect(audited(coverageOf({ [ROUTE]: route }))).toEqual({ POST: true });
  });

  it('follows an aliased import into a helper module and its re-exports', () => {
    const route = `
      import { applyBulk } from '@server/admin/bulk';
      export default adminApi({}).patch(async (req, res) => applyBulk(req));`;
    const barrel = `export { applyBulk } from './bulk/apply';`;
    const helper = `
      const audit = (req) => adminAuditService.recordAdminAction({ action: 'x' });
      export const applyBulk = async (req) => { await write(); await audit(req); };`;
    expect(
      audited(
        coverageOf({
          [ROUTE]: route,
          'apps/client/server/admin/bulk.ts': barrel,
          'apps/client/server/admin/bulk/apply.ts': helper,
        })
      )
    ).toEqual({ PATCH: true });
  });

  it('does not credit a helper that is imported but never referenced by the verb', () => {
    const route = `
      import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
      export default adminApi({}).post(async (req, res) => { await save(); });`;
    expect(audited(coverageOf({ [ROUTE]: route }))).toEqual({ POST: false });
  });

  it('does not credit an audit that only records the denial', () => {
    const route = `
      import { denySelfAdminAction } from '@bike4mind/server-utils/utils/adminAudit';
      export default adminApi({}).post(async (req, res) => { await denySelfAdminAction(req, 'x'); await save(); });`;
    const adminAudit = `export const denySelfAdminAction = async (req) => recordAdminActionFromRequest(req, {});`;
    expect(
      audited(coverageOf({ [ROUTE]: route, 'packages/server-utils/src/utils/adminAudit.ts': adminAudit }))
    ).toEqual({
      POST: false,
    });
  });

  it('parses .ts sources as TypeScript, not TSX, so a generic arrow does not hide what follows', () => {
    const route = `
      const run = <T>(fn: () => Promise<T>) => fn();
      export default adminApi({}).post(async (req, res) => run(() => recordAdminAction({})));`;
    expect(audited(coverageOf({ [ROUTE]: route }))).toEqual({ POST: true });
  });

  it('reports a file with no router chain as unreadable', () => {
    expect(coverageOf({ [ROUTE]: 'export default function handler(req, res) {}' })).toEqual({ kind: 'unreadable' });
  });
});

describe('auditCoverageFailures', () => {
  const route = (method: 'POST' | 'DELETE', witness: string | null): CoverageRoute => ({
    route: '/api/admin/thing',
    file: ROUTE,
    coverage: { kind: 'analyzed', verbs: [{ method, witness }] },
  });

  it('names the verb and tells the author how to fix it', () => {
    const [failure] = auditCoverageFailures([route('DELETE', null)], {});
    expect(failure).toContain('DELETE /api/admin/thing');
    expect(failure).toContain('recordAdminActionFromRequest');
    expect(failure).toContain('ADMIN_AUDIT_CATALOGUE');
    expect(failure).toContain('adminAuditCoverageExemptions.ts');
  });

  it('accepts an exempt verb and flags exemptions that are stale or unexplained', () => {
    expect(auditCoverageFailures([route('POST', null)], { 'POST /api/admin/thing': 'preview' })).toEqual([]);
    expect(auditCoverageFailures([route('POST', 'x.ts:1')], { 'POST /api/admin/thing': 'preview' })).toEqual([
      expect.stringContaining('now reaches an audit writer'),
    ]);
    expect(auditCoverageFailures([], { 'POST /api/admin/gone': 'preview' })).toEqual([
      expect.stringContaining('no such handler verb exists'),
    ]);
    expect(auditCoverageFailures([route('POST', null)], { 'POST /api/admin/thing': ' ' })).toEqual([
      expect.stringContaining('needs a reason'),
    ]);
  });
});

describe('admin write audit coverage', () => {
  it('every mutating verb under pages/api/admin writes an audit row or is exempt with a reason', () => {
    const reachability = new AuditReachability(ROOT);
    const routes = sourceFiles(ADMIN_API_DIR).flatMap((file): CoverageRoute[] => {
      const route = routeFromFile(file);
      return route ? [{ route, file, coverage: analyzeHandlerCoverage(reachability, file) }] : [];
    });
    expect(routes.length).toBeGreaterThan(100);
    expect(auditCoverageFailures(routes, ADMIN_AUDIT_COVERAGE_EXEMPTIONS)).toEqual([]);
  });
});
