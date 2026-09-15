import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError } from '@bike4mind/common';

// The @datalake grammar parser is unit-tested in the slack package; here we mock it and exercise
// the handler's dispatch, listing and ingest-reply behavior in isolation.
const { parseDataLakeCommand } = vi.hoisted(() => ({ parseDataLakeCommand: vi.fn() }));
const { ingestSlackFilesIntoLake, ingestSlackLinkIntoLake, buildSlackAccessContext } = vi.hoisted(() => ({
  ingestSlackFilesIntoLake: vi.fn(),
  ingestSlackLinkIntoLake: vi.fn(),
  buildSlackAccessContext: vi.fn(),
}));
const { listDataLakes, grantedLakeReachFor } = vi.hoisted(() => ({
  listDataLakes: vi.fn(),
  grantedLakeReachFor: vi.fn(),
}));

vi.mock('@bike4mind/slack', async importOriginal => {
  // escapeSlackMrkdwn imported from the REAL module, not reimplemented: some tests assert on exact
  // reply text pinned to what it neutralizes (e.g. "<!channel>"), and a hand-copy would silently
  // stop matching if the real implementation ever gains a new escaped character.
  const actual = await importOriginal<typeof import('@bike4mind/slack')>();
  return { parseDataLakeCommand, escapeSlackMrkdwn: actual.escapeSlackMrkdwn };
});
vi.mock('@bike4mind/services', () => ({ dataLakeService: { listDataLakes, grantedLakeReachFor } }));
// Both ingest paths and the shared AccessContext builder are stubbed, so these tests exercise
// dispatch and reply composition only. Each path's own behavior has its own test file.
vi.mock('./dataLakeIngestAuthz', () => ({ buildSlackAccessContext }));
vi.mock('./dataLakeFileIngest', () => ({ ingestSlackFilesIntoLake }));
vi.mock('./dataLakeLinkIngest', () => ({ ingestSlackLinkIntoLake }));

import {
  handleDataLakeCommand,
  runDataLakeSlackCommand,
  formatIngestOutcome,
  formatBareDataLakeMentionHint,
  slugTier,
  type ListScope,
} from './handleDataLakeCommand';

const actor = { id: 'u1', isAdmin: false };
const dataLakeAccessGrants = { listByLake: vi.fn(), listActiveByLakes: vi.fn(), listByPrincipal: vi.fn() };
const ingestDeps = { dataLakes: {}, dataLakeAccessGrants } as never;

const baseParams = (overrides: Record<string, unknown> = {}) => ({
  command: '@datalake help',
  actor,
  files: [],
  channel: 'C1',
  messageTs: '1700000000.0001',
  deps: ingestDeps,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  buildSlackAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, userTags: [], entitlementKeys: [] });
  grantedLakeReachFor.mockResolvedValue({ grantedLakeIds: [], orgGrantedLakes: {} });
});

describe('handleDataLakeCommand', () => {
  it('returns help text for `help` without listing or ingesting', async () => {
    parseDataLakeCommand.mockReturnValue({ subcommand: 'help', rawArgs: '' });

    const reply = await handleDataLakeCommand(baseParams());

    expect(reply).toContain('Data Lake commands');
    expect(listDataLakes).not.toHaveBeenCalled();
    expect(ingestSlackFilesIntoLake).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized subcommand', async () => {
    parseDataLakeCommand.mockReturnValue({ subcommand: 'unknown', rawArgs: '' });
    const reply = await handleDataLakeCommand(baseParams());
    expect(reply).toMatch(/Unrecognized/);
  });

  describe('list', () => {
    beforeEach(() => parseDataLakeCommand.mockReturnValue({ subcommand: 'list', rawArgs: '' }));

    it('lists only the lakes the caller can WRITE to, not merely read', async () => {
      listDataLakes.mockResolvedValue([
        { slug: 'sales', name: 'Sales', canManage: true },
        { slug: 'public-readonly', name: 'Public', canManage: false },
      ]);

      const reply = await handleDataLakeCommand(baseParams());

      expect(reply).toContain('sales');
      // A readable-but-unwritable lake must not be advertised: every add to it would be refused.
      expect(reply).not.toContain('public-readonly');
    });

    it('caps a long list with a "+N more" tail instead of overrunning Slack', async () => {
      // A caller in a large org can have more manageable lakes than fit Slack's 40k-character
      // text limit; past it chat.postMessage errors and the orchestrator's catch turns the whole
      // reply into "something went wrong".
      listDataLakes.mockResolvedValue(
        Array.from({ length: 63 }, (_, i) => ({ slug: `lake-${i}`, name: `Lake ${i}`, canManage: true }))
      );

      const reply = await handleDataLakeCommand(baseParams());

      expect(reply).toContain('lake-0');
      expect(reply).toContain('lake-49');
      expect(reply).not.toContain('lake-50');
      expect(reply).toContain('and 13 more');
    });

    it('explains the empty case rather than printing an empty list', async () => {
      listDataLakes.mockResolvedValue([{ slug: 'x', name: 'X', canManage: false }]);

      const reply = await handleDataLakeCommand(baseParams());

      expect(reply).toMatch(/cannot add to any data lakes/i);
    });

    describe('scoping', () => {
      const adminCtx = { userId: 'u1', isAdmin: true, userTags: [], entitlementKeys: [], organizationIds: ['org-a'] };
      const printedSlugs = (reply: string) => Array.from(reply.matchAll(/^- `([^`]+)`/gm), m => m[1]);

      beforeEach(() => buildSlackAccessContext.mockResolvedValue(adminCtx));

      it('queries the row set with the platform-admin bypass suppressed', async () => {
        listDataLakes.mockResolvedValue([{ slug: 'mine', name: 'Mine', canManage: true }]);

        await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        // The disclosure in question is findAccessible's admin short-circuit returning every lake
        // on the platform. This surface must never take it: the reply is a channel message.
        expect(listDataLakes).toHaveBeenCalledWith(
          expect.objectContaining({ isAdmin: false, userId: 'u1' }),
          expect.anything()
        );
      });

      it('threads the grants repository, so a grant-held lake is reachable and labelled', async () => {
        listDataLakes.mockResolvedValue([{ slug: 'mine', name: 'Mine', canManage: true }]);

        await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        // Both of listDataLakes' grant reads degrade to empty when the repo is absent, so without it
        // a curator-granted or transferred lake neither enters the row set nor earns a manage label -
        // and `add`, which does resolve grants, accepts it. That disagreement is #2034.
        expect(listDataLakes).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ db: expect.objectContaining({ dataLakeAccessGrants }) })
        );
      });

      it('passes NO settings adapter, which would admit reader grants a write gate refuses', async () => {
        listDataLakes.mockResolvedValue([{ slug: 'mine', name: 'Mine', canManage: true }]);

        await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        // The settings repo is the read-grant cutover flag, which admits READER and org-principal
        // grants into the list. A reader cannot write, so passing it would advertise lakes `add`
        // then refuses - #2022 in a new place. Absent, resolveEnforceReadGrants returns false.
        const [, adapters] = listDataLakes.mock.calls[0] as [unknown, { db: Record<string, unknown> }];
        expect(adapters.db).not.toHaveProperty('settings');
      });

      it('resolves entitlement keys for an admin, since the row set is built from the non-admin arms', async () => {
        listDataLakes.mockResolvedValue([{ slug: 'mine', name: 'Mine', canManage: true }]);

        await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        // Without the keys, an entitlement-gated lake in the admin's own org fails findAccessible's
        // requirement constraint and drops off a list that `add` still accepts.
        expect(buildSlackAccessContext).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
          resolveEntitlementsForAdmin: true,
        });
      });

      it('omits a lake belonging to an organization the caller is not a member of', async () => {
        listDataLakes.mockResolvedValue([
          { slug: 'ours', name: 'Ours', canManage: true, organizationId: 'org-a' },
          { slug: 'theirs', name: 'Theirs', canManage: true, organizationId: 'org-b' },
        ]);

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        expect(reply).toContain('ours');
        // findBySlug is org-scoped, so this slug would refuse on `add` - and naming another org's
        // lake in a shared channel is the disclosure itself.
        expect(reply).not.toContain('theirs');
      });

      it('never offers a built-in registry lake, which is read-only even for an admin', async () => {
        // listDataLakes stamps every static-registry lake canManage:false because assertLakeWritable
        // refuses an admin too, so the admin manage label must not be restored over one.
        listDataLakes.mockResolvedValue([
          { id: 'opti-knowledge', slug: 'opti-knowledge', name: 'Optimization Knowledge Base', canManage: false },
        ]);

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        expect(reply).toMatch(/cannot add to any data lakes/i);
      });

      it('omits a cross-org PUBLIC lake, which findAccessible returns but findBySlug cannot resolve', async () => {
        listDataLakes.mockResolvedValue([
          { slug: 'open-lake', name: 'Open', canManage: true, organizationId: 'org-b', isPublic: true },
        ]);

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        expect(reply).toMatch(/cannot add to any data lakes/i);
      });

      it("keeps an org-less lake and one in the caller's own org", async () => {
        listDataLakes.mockResolvedValue([
          { slug: 'personal', name: 'Personal', canManage: true },
          { slug: 'ours', name: 'Ours', canManage: true, organizationId: 'org-a' },
        ]);

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        expect(printedSlugs(reply)).toEqual(['personal', 'ours']);
      });

      it('labels a scoped row manageable for an admin even when the suppressed context did not', async () => {
        // Suppressing isAdmin for the query also silences canManageLake's admin rung, so an org
        // lake the admin did not create comes back canManage:false. The label is restored; the row
        // set is not widened.
        listDataLakes.mockResolvedValue([{ slug: 'ours', name: 'Ours', canManage: false, organizationId: 'org-a' }]);

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        expect(reply).toContain('ours');
      });

      it('loses no row for an admin whose administeredOrgIds is empty', async () => {
        // Deliberate composition of two suppressions: the query runs with isAdmin false, and an
        // admin's administeredOrgIds is zeroed at the context builder, so canManageLake's platform,
        // org-admin and org-grant rungs ALL miss and every org row arrives canManage:false. Only
        // `isWritable` reading the unsuppressed ctx keeps the reply non-empty.
        buildSlackAccessContext.mockResolvedValue({ ...adminCtx, administeredOrgIds: [] });
        listDataLakes.mockResolvedValue([{ slug: 'ours', name: 'Ours', canManage: false, organizationId: 'org-a' }]);

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        expect(printedSlugs(reply)).toEqual(['ours']);
      });

      it('prints one row per slug, naming the lake `add` would resolve', async () => {
        listDataLakes.mockResolvedValue([
          { slug: 'notes', name: 'Org-less Notes', canManage: true },
          { slug: 'notes', name: 'Org Notes', canManage: true, organizationId: 'org-a' },
        ]);

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        expect(printedSlugs(reply)).toEqual(['notes']);
        // findBySlug prefers an own-org lake over the org-less fallback, so that is the lake the
        // printed slug actually targets.
        expect(reply).toContain('Org Notes');
        expect(reply).not.toContain('Org-less Notes');
      });

      it('drops a slug whose WINNING lake is unwritable, even when a lower-priority one is writable', async () => {
        // findBySlug takes the own-org lake by priority alone and never falls back when it turns
        // out to be unwritable, so `add` would refuse this slug outright. Printing the org-less
        // lake because it happens to be writable would name a lake the command never targets.
        listDataLakes.mockResolvedValue([
          { slug: 'notes', name: 'My Org-less Notes', canManage: true },
          { slug: 'notes', name: 'Read-only Org Notes', canManage: false, organizationId: 'org-a' },
        ]);

        buildSlackAccessContext.mockResolvedValue({ ...adminCtx, isAdmin: false });

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: false } }));

        expect(printedSlugs(reply)).not.toContain('notes');
        expect(reply).not.toContain('My Org-less Notes');
        expect(reply).toMatch(/cannot add to any data lakes/i);
      });

      it('never prints a slug `add` cannot resolve (listed implies addable)', async () => {
        const catalog = [
          { id: 'personal', slug: 'personal', name: 'Personal', canManage: true },
          { id: 'ours', slug: 'ours', name: 'Ours', canManage: true, organizationId: 'org-a' },
          { id: 'theirs', slug: 'theirs', name: 'Theirs', canManage: true, organizationId: 'org-b' },
          { id: 'open', slug: 'open-lake', name: 'Open', canManage: true, organizationId: 'org-b', isPublic: true },
          { id: 'notes-orgless', slug: 'notes', name: 'Org-less Notes', canManage: true },
          { id: 'notes-org', slug: 'notes', name: 'Org Notes', canManage: true, organizationId: 'org-a' },
          // Deliberately NOT uniformly writable: the winning lake for `shared` is unwritable, so
          // `add` refuses the slug and the guard must see the reply omit it rather than print the
          // writable org-less one. A catalog with canManage: true everywhere cannot catch that.
          { id: 'shared-orgless', slug: 'shared', name: 'Writable Org-less Shared', canManage: true },
          {
            id: 'shared-org',
            slug: 'shared',
            name: 'Read-only Org Shared',
            canManage: false,
            organizationId: 'org-a',
          },
          // A grant-held (tier 2) lake, present so this guard exercises all three tiers `slugTier`
          // ranks - not just own-org/org-less - and would catch a future tier this reply omits.
          { id: 'granted-lake', slug: 'granted-only', name: 'Granted Only', canManage: true, organizationId: 'org-z' },
        ];
        listDataLakes.mockResolvedValue(catalog);
        grantedLakeReachFor.mockResolvedValue({ grantedLakeIds: ['granted-lake'], orgGrantedLakes: {} });

        // Mirrors `add` by calling the SAME production ranking function `list` itself uses
        // (`slugTier`, exported from handleDataLakeCommand.ts) rather than a hand-rolled copy of
        // the arm order - a hand-rolled copy is exactly what let the grant tier go uncovered here
        // before #2425's review caught it.
        const resolveBySlug = (slug: string, scope: ListScope, grantedLakeIds: ReadonlySet<string>) => {
          let best: { lake: (typeof catalog)[number]; tier: 0 | 1 | 2 } | null = null;
          for (const lake of catalog) {
            if (lake.slug !== slug) continue;
            const tier = slugTier(lake, scope, grantedLakeIds);
            if (tier !== null && (!best || tier < best.tier)) best = { lake, tier };
          }
          return best?.lake ?? null;
        };

        // Both actors, because the write gate differs: an admin is granted outright on any
        // non-registry lake, so an admin-only run cannot see an unwritable winner at all.
        for (const isAdmin of [true, false]) {
          const scope = { ...adminCtx, isAdmin };
          buildSlackAccessContext.mockResolvedValue(scope);

          const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin } }));

          const slugs = printedSlugs(reply);
          expect(slugs.length, `no rows printed for isAdmin=${isAdmin}`).toBeGreaterThan(0);
          const grantedLakeIds = new Set(['granted-lake']);
          for (const slug of slugs) {
            const resolved = resolveBySlug(slug, scope, grantedLakeIds);
            expect(resolved, `add to \`${slug}\` would be refused`).not.toBeNull();
            expect(reply).toContain(resolved!.name);
            // `add` gates the lake findBySlug returned, with no retry against a same-slug sibling,
            // so a printed slug whose winner fails that gate is a promise the command breaks.
            // No registry lakes in this catalog, so the admin arm of isWritable is just isAdmin.
            expect(resolved!.canManage || isAdmin, `add to \`${slug}\` resolves a lake this caller cannot write`).toBe(
              true
            );
          }
        }
      });

      it('resolves a foreign-org grant-held lake by slug, mirroring findBySlug (#2425)', async () => {
        // A lake in an org the caller does not belong to still reaches `add` when the grants
        // fallback resolves it - `list` must agree, or it omits exactly the lake `add` accepts.
        listDataLakes.mockResolvedValue([
          { id: 'lake-1', slug: 'granted', name: 'Granted Lake', canManage: true, organizationId: 'org-b' },
        ]);
        grantedLakeReachFor.mockResolvedValue({ grantedLakeIds: ['lake-1'], orgGrantedLakes: {} });

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        expect(reply).toContain('granted');
        expect(reply).toContain('Granted Lake');
      });

      it('still omits a foreign-org lake with NO grant, even though listDataLakes returned it', async () => {
        listDataLakes.mockResolvedValue([
          { id: 'lake-1', slug: 'ungranted', name: 'Ungranted Lake', canManage: true, organizationId: 'org-b' },
        ]);
        grantedLakeReachFor.mockResolvedValue({ grantedLakeIds: [], orgGrantedLakes: {} });

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        expect(reply).toMatch(/cannot add to any data lakes/i);
      });

      it("prefers the caller's own-org lake over a same-slug foreign-org grant-held one", async () => {
        // findBySlug never reaches its grant-fallback arm when an own-org match exists for the
        // slug - the grant tier must lose the tie regardless of org-id string ordering.
        listDataLakes.mockResolvedValue([
          { id: 'lake-own', slug: 'notes', name: 'Own Org Notes', canManage: true, organizationId: 'org-a' },
          { id: 'lake-foreign', slug: 'notes', name: 'Foreign Grant Notes', canManage: true, organizationId: 'org-z' },
        ]);
        grantedLakeReachFor.mockResolvedValue({ grantedLakeIds: ['lake-foreign'], orgGrantedLakes: {} });

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        expect(reply).toContain('Own Org Notes');
        expect(reply).not.toContain('Foreign Grant Notes');
      });

      it('prefers a personal (org-less) lake over a same-slug foreign-org grant-held one', async () => {
        // The other new tie this change introduces: org-less (tier 1) still beats grant-held
        // (tier 2), so a caller's own personal lake wins the slug over a lake transferred to them
        // from a foreign org - decided by tier alone here, not by name/id ordering.
        listDataLakes.mockResolvedValue([
          { id: 'lake-personal', slug: 'notes', name: 'Personal Notes', canManage: true },
          { id: 'lake-foreign', slug: 'notes', name: 'Foreign Grant Notes', canManage: true, organizationId: 'org-z' },
        ]);
        grantedLakeReachFor.mockResolvedValue({ grantedLakeIds: ['lake-foreign'], orgGrantedLakes: {} });

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        expect(reply).toContain('Personal Notes');
        expect(reply).not.toContain('Foreign Grant Notes');
      });

      it('picks the lower lake id between two same-slug foreign-org grant-held lakes', async () => {
        // Mirrors DataLakeModel.findBySlugAmongIds' `.sort({_id: 1})`: two grant-held lakes across
        // two different non-member orgs sharing a slug must resolve to the same winner every time.
        listDataLakes.mockResolvedValue([
          { id: 'lake-b', slug: 'shared-grant', name: 'From Org B', canManage: true, organizationId: 'org-b' },
          { id: 'lake-a', slug: 'shared-grant', name: 'From Org A', canManage: true, organizationId: 'org-a-foreign' },
        ]);
        grantedLakeReachFor.mockResolvedValue({ grantedLakeIds: ['lake-b', 'lake-a'], orgGrantedLakes: {} });

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        expect(reply).toContain('From Org A');
        expect(reply).not.toContain('From Org B');
      });

      it('resolves two same-slug org-less lakes deterministically (null vs empty-string organizationId)', async () => {
        // #2425 review: null and '' are both stored as "org-less" but are distinct index keys, so
        // two org-less lakes CAN share a slug - unlike own-org/grant-held, this had no tie-break at
        // all before this fix. orgSortKey treats null/undefined (BSON Null) as sorting before any
        // string, mirroring DataLakeModel's own `.sort({organizationId:1})` on this arm.
        listDataLakes.mockResolvedValue([
          { id: 'lake-empty', slug: 'orgless-tie', name: 'Empty String Org', canManage: true, organizationId: '' },
          { id: 'lake-null', slug: 'orgless-tie', name: 'Null Org', canManage: true, organizationId: undefined },
        ]);

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        expect(reply).toContain('Null Org');
        expect(reply).not.toContain('Empty String Org');
      });

      it('slugTier ranks a foreign-org lake null (unaddressable) when no grant covers it', () => {
        // Direct unit coverage of the exported ranker itself, not just through the Slack reply -
        // the same function `list` and this guard both call, so nothing here can drift from it.
        const scope: ListScope = { isAdmin: false, organizationIds: ['org-a'] };
        const foreign = { id: 'x', slug: 'x', name: 'X', organizationId: 'org-z', canManage: true };

        expect(slugTier(foreign, scope, new Set())).toBeNull();
        expect(slugTier(foreign, scope, new Set(['x']))).toBe(2);
        expect(slugTier({ ...foreign, organizationId: 'org-a' }, scope, new Set())).toBe(0);
        expect(slugTier({ ...foreign, organizationId: undefined }, scope, new Set())).toBe(1);
      });
    });
  });

  describe('add', () => {
    it('requires an explicit target lake', async () => {
      parseDataLakeCommand.mockReturnValue({ subcommand: 'add', link: 'https://x', rawArgs: '' });

      const reply = await handleDataLakeCommand(baseParams());

      expect(reply).toMatch(/name a target lake/i);
      expect(ingestSlackFilesIntoLake).not.toHaveBeenCalled();
    });

    it('ingests a bare link through the LINK path, not the file path', async () => {
      parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', link: 'https://x', rawArgs: '' });
      ingestSlackLinkIntoLake.mockResolvedValue({
        ok: true,
        lakeName: 'Sales',
        fileName: 'An Article',
        sourceUrl: 'https://x',
      });

      const reply = await handleDataLakeCommand(baseParams({ files: [] }));

      expect(ingestSlackLinkIntoLake).toHaveBeenCalledWith(
        { actor, lakeSlug: 'sales', link: 'https://x', channel: 'C1', messageTs: '1700000000.0001' },
        ingestDeps
      );
      // No attachments, so the file path must not run at all.
      expect(ingestSlackFilesIntoLake).not.toHaveBeenCalled();
      expect(reply).toContain('Added 1 file to *Sales*: "An Article"');
    });

    it('reports a re-added link as skipped, matching the FILE path wording', async () => {
      // Acceptance criterion: re-adding the same URL answers "Already in <lake>, skipped", not a
      // second "Added 1 file" - the bug #2027 was filed for.
      parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', link: 'https://x', rawArgs: '' });
      ingestSlackLinkIntoLake.mockResolvedValue({
        ok: true,
        lakeName: 'Sales',
        fileName: 'An Article',
        sourceUrl: 'https://x',
        duplicate: true,
      });

      const reply = await handleDataLakeCommand(baseParams({ files: [] }));

      expect(reply).toContain('Already in *Sales*, skipped: "An Article"');
      expect(reply).not.toContain('Added 1 file');
    });

    it('surfaces a link refusal verbatim', async () => {
      parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', link: 'https://x', rawArgs: '' });
      ingestSlackLinkIntoLake.mockResolvedValue({
        ok: false,
        reason: 'link_fetch_failed',
        message: 'Could not fetch that link.',
      });

      const reply = await handleDataLakeCommand(baseParams({ files: [] }));

      expect(reply).toBe('Could not fetch that link.');
    });

    it('asks for a file or a link when the message carries neither', async () => {
      parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', rawArgs: '' });

      const reply = await handleDataLakeCommand(baseParams({ files: [] }));

      expect(reply).toMatch(/attach a file or include a link/i);
      expect(ingestSlackFilesIntoLake).not.toHaveBeenCalled();
      expect(ingestSlackLinkIntoLake).not.toHaveBeenCalled();
    });

    it('passes the actor, files and Slack origin through to the ingest', async () => {
      parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', rawArgs: '' });
      ingestSlackFilesIntoLake.mockResolvedValue({
        ok: true,
        lakeName: 'Sales',
        added: ['a.pdf'],
        duplicates: [],
        rejected: [],
      });
      const files = [{ id: 'F1', name: 'a.pdf' }];

      const reply = await handleDataLakeCommand(baseParams({ files }));

      expect(ingestSlackFilesIntoLake).toHaveBeenCalledWith(
        { actor, lakeSlug: 'sales', files, channel: 'C1', messageTs: '1700000000.0001' },
        ingestDeps
      );
      expect(reply).toContain('Sales');
    });

    it('surfaces an ingest refusal verbatim', async () => {
      parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'ghost', rawArgs: '' });
      ingestSlackFilesIntoLake.mockResolvedValue({
        ok: false,
        reason: 'not_authorized',
        message: 'You do not have permission to add files to `ghost`.',
      });

      const reply = await handleDataLakeCommand(baseParams({ files: [{ id: 'F1' }] }));

      expect(reply).toBe('You do not have permission to add files to `ghost`.');
    });

    it('ingests BOTH when a message carries a file and a link, reporting each', async () => {
      // M2 replied "Ignored the link" here because LINK ingest did not exist. Now both run, so the
      // reply must account for both - under-reporting would be the new version of that same lie.
      parseDataLakeCommand.mockReturnValue({
        subcommand: 'add',
        lakeSlug: 'sales',
        link: 'https://example.com/doc',
        rawArgs: '',
      });
      ingestSlackFilesIntoLake.mockResolvedValue({
        ok: true,
        lakeName: 'Sales',
        added: ['a.pdf'],
        duplicates: [],
        rejected: [],
      });
      ingestSlackLinkIntoLake.mockResolvedValue({
        ok: true,
        lakeName: 'Sales',
        fileName: 'A Doc',
        sourceUrl: 'https://example.com/doc',
      });

      const reply = await handleDataLakeCommand(baseParams({ files: [{ id: 'F1', name: 'a.pdf' }] }));

      expect(ingestSlackFilesIntoLake).toHaveBeenCalled();
      expect(ingestSlackLinkIntoLake).toHaveBeenCalled();
      expect(reply).toContain('"a.pdf"');
      expect(reply).toContain('"A Doc"');
      expect(reply).not.toMatch(/ignored the link/i);
    });

    it('still reports the file when the link half fails', async () => {
      // One half failing must not swallow the other, in either direction.
      parseDataLakeCommand.mockReturnValue({
        subcommand: 'add',
        lakeSlug: 'sales',
        link: 'https://example.com/doc',
        rawArgs: '',
      });
      ingestSlackFilesIntoLake.mockResolvedValue({
        ok: true,
        lakeName: 'Sales',
        added: ['a.pdf'],
        duplicates: [],
        rejected: [],
      });
      ingestSlackLinkIntoLake.mockResolvedValue({
        ok: false,
        reason: 'link_fetch_failed',
        message: 'Could not fetch that link.',
      });

      const reply = await handleDataLakeCommand(baseParams({ files: [{ id: 'F1', name: 'a.pdf' }] }));

      expect(reply).toContain('"a.pdf"');
      expect(reply).toContain('Could not fetch that link.');
    });

    it('does not print the SAME refusal twice on a mixed message', async () => {
      // Both halves authorize independently, so an unauthorized actor is refused by each. Two
      // identical sentences read as a stutter rather than as two half-outcomes.
      parseDataLakeCommand.mockReturnValue({
        subcommand: 'add',
        lakeSlug: 'sales',
        link: 'https://example.com/doc',
        rawArgs: '',
      });
      const refusal = 'You do not have permission to add to *Sales*. Ask a lake admin.';
      ingestSlackFilesIntoLake.mockResolvedValue({ ok: false, reason: 'not_authorized', message: refusal });
      ingestSlackLinkIntoLake.mockResolvedValue({ ok: false, reason: 'not_authorized', message: refusal });

      const reply = await handleDataLakeCommand(baseParams({ files: [{ id: 'F1', name: 'a.pdf' }] }));

      expect(reply).toBe(refusal);
      expect(reply.split(refusal).length - 1).toBe(1);
    });

    it('does NOT collapse two identical SUCCESS lines, only refusals', async () => {
      // A swallowed success would misreport what is actually in the lake, so de-duplication is scoped
      // to refusals. Contrived here, but the collision is possible when a file name coincides with the
      // link's page title in the same lake.
      parseDataLakeCommand.mockReturnValue({
        subcommand: 'add',
        lakeSlug: 'sales',
        link: 'https://example.com/doc',
        rawArgs: '',
      });
      ingestSlackFilesIntoLake.mockResolvedValue({
        ok: true,
        lakeName: 'Sales',
        added: ['same.pdf'],
        duplicates: [],
        rejected: [],
      });
      ingestSlackLinkIntoLake.mockResolvedValue({ ok: true, lakeName: 'Sales', fileName: 'same.pdf' });

      const reply = await handleDataLakeCommand(baseParams({ files: [{ id: 'F1', name: 'same.pdf' }] }));

      expect(reply.split('\n').length).toBe(2);
    });

    it('still reports two DIFFERENT outcomes separately', async () => {
      // The de-duplication must not collapse genuine half-outcomes, which always differ because each
      // names its own file or link.
      parseDataLakeCommand.mockReturnValue({
        subcommand: 'add',
        lakeSlug: 'sales',
        link: 'https://example.com/doc',
        rawArgs: '',
      });
      ingestSlackFilesIntoLake.mockResolvedValue({
        ok: false,
        reason: 'link_fetch_failed',
        message: 'First problem.',
      });
      ingestSlackLinkIntoLake.mockResolvedValue({
        ok: false,
        reason: 'link_fetch_failed',
        message: 'Second problem.',
      });

      const reply = await handleDataLakeCommand(baseParams({ files: [{ id: 'F1', name: 'a.pdf' }] }));

      expect(reply).toContain('First problem.');
      expect(reply).toContain('Second problem.');
    });
  });
});

describe('formatIngestOutcome', () => {
  it('confirms added files and stops (no post-vectorize promise of live-ness)', () => {
    const text = formatIngestOutcome({
      ok: true,
      lakeName: 'Sales',
      added: ['a.pdf', 'b.pdf'],
      duplicates: [],
      rejected: [],
    });

    expect(text).toContain('Added 2 files to *Sales*');
    expect(text).toMatch(/processing/i);
  });

  it('uses the singular for one file', () => {
    const text = formatIngestOutcome({ ok: true, lakeName: 'S', added: ['a.pdf'], duplicates: [], rejected: [] });
    expect(text).toContain('Added 1 file to');
  });

  it('reports duplicates as skipped rather than replaced', () => {
    const text = formatIngestOutcome({ ok: true, lakeName: 'S', added: [], duplicates: ['dupe.pdf'], rejected: [] });
    expect(text).toMatch(/already in \*S\*, skipped/i);
  });

  it('surfaces per-file rejections instead of dropping them silently', () => {
    const text = formatIngestOutcome({
      ok: true,
      lakeName: 'S',
      added: [],
      duplicates: [],
      rejected: ['File "x.exe" has unsupported type application/octet-stream.'],
    });

    expect(text).toContain('x.exe');
  });

  it('escapes a rejection reason embedding an attempted file name, so it cannot post as a broadcast', () => {
    // Rejection reasons embed the attempted file name (dataLakeFileIngest.ts), which any channel
    // member can set by naming an oversized or unsupported-type file "<!channel>" and attaching it.
    const text = formatIngestOutcome({
      ok: true,
      lakeName: 'S',
      added: [],
      duplicates: [],
      rejected: ['Could not add "<!channel>": some error.'],
    });

    expect(text).toContain('&lt;!channel&gt;');
    expect(text).not.toContain('<!channel>');
  });

  it('does not claim success when nothing happened at all', () => {
    const text = formatIngestOutcome({ ok: true, lakeName: 'S', added: [], duplicates: [], rejected: [] });
    expect(text).toMatch(/nothing to add/i);
  });

  it('does not promise searchability when auto-chunk is off', () => {
    // With enableAutoChunk off, objectCreated.ts never enqueues the chunk job, so the stored file
    // is never indexed - the default wording would be a promise the user cannot act on.
    const text = formatIngestOutcome(
      { ok: true, lakeName: 'S', added: ['a.pdf'], duplicates: [], rejected: [] },
      { autoChunkEnabled: false }
    );

    expect(text).toContain('Added 1 file to *S*');
    expect(text).toMatch(/automatic indexing is off/i);
    expect(text).not.toMatch(/searchable once indexing finishes/i);
  });

  it('treats an unset auto-chunk flag as on, matching the setting default', () => {
    const text = formatIngestOutcome(
      { ok: true, lakeName: 'S', added: ['a.pdf'], duplicates: [], rejected: [] },
      { autoChunkEnabled: undefined }
    );

    expect(text).toMatch(/searchable once indexing finishes/i);
  });
});

describe('formatBareDataLakeMentionHint (#2027)', () => {
  it('points at @datalake and the help subcommand, distinct from the unrecognized-subcommand reply', () => {
    const text = formatBareDataLakeMentionHint();

    expect(text).toContain('@datalake');
    expect(text).toContain('@datalake help');
    expect(text).not.toMatch(/unrecognized/i);
  });
});

describe('runDataLakeSlackCommand (gate + dispatch)', () => {
  const getSettingsValue = vi.fn();
  const adminSettings = { getSettingsValue };
  const sendMessage = vi.fn().mockResolvedValue('1700000000.0001');
  const logger = { info: vi.fn(), error: vi.fn() };

  const baseDeps = () => ({
    command: '@datalake help',
    actor,
    files: [],
    channel: 'C1',
    messageTs: '1700000000.0001',
    threadTs: 'T1',
    adminSettings,
    ingest: ingestDeps,
    sendMessage,
    logger,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a silent no-op when the flag is off (dormant): no reply, no ingest', async () => {
    // Parent on, child off - isolates the EnableDataLakeSlackAdd gate.
    getSettingsValue.mockImplementation(async (key: string) => key === 'EnableDataLakes');

    await runDataLakeSlackCommand(baseDeps());

    expect(getSettingsValue).toHaveBeenCalledWith('EnableDataLakeSlackAdd');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ingestSlackFilesIntoLake).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('is also a no-op when the PARENT EnableDataLakes flag is off', async () => {
    // The child declares dependsOn: 'EnableDataLakes', so the admin UI hides it while the parent
    // is off - but that is a UI affordance, not enforcement. A direct settings-store write could
    // leave the child on under a disabled parent; this check is what actually holds.
    getSettingsValue.mockImplementation(async (key: string) => key !== 'EnableDataLakes');

    await runDataLakeSlackCommand(baseDeps());

    expect(getSettingsValue).toHaveBeenCalledWith('EnableDataLakes');
    // Short-circuits before the child flag is even read.
    expect(getSettingsValue).not.toHaveBeenCalledWith('EnableDataLakeSlackAdd');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ingestSlackFilesIntoLake).not.toHaveBeenCalled();
  });

  it('treats an unset flag (undefined) as off', async () => {
    getSettingsValue.mockResolvedValue(undefined);
    await runDataLakeSlackCommand(baseDeps());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('dispatches and replies in-thread when the flag is on', async () => {
    getSettingsValue.mockResolvedValue(true);
    parseDataLakeCommand.mockReturnValue({ subcommand: 'help', rawArgs: '' });

    await runDataLakeSlackCommand(baseDeps());

    expect(sendMessage).toHaveBeenCalledWith({
      channel: 'C1',
      text: expect.stringContaining('Data Lake commands'),
      threadTs: 'T1',
    });
  });

  it('reads enableAutoChunk and reflects it in the reply wording', async () => {
    // Both gates on, auto-chunk off - so the confirmation must not promise searchability.
    getSettingsValue.mockImplementation(async (key: string) => key !== 'enableAutoChunk');
    parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', rawArgs: '' });
    ingestSlackFilesIntoLake.mockResolvedValue({
      ok: true,
      lakeName: 'Sales',
      added: ['a.pdf'],
      duplicates: [],
      rejected: [],
    });

    await runDataLakeSlackCommand({ ...baseDeps(), files: [{ id: 'F1' }] as never });

    expect(getSettingsValue).toHaveBeenCalledWith('enableAutoChunk');
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/automatic indexing is off/i) })
    );
  });

  it('swallows errors so the caller still acks 200 (logs + best-effort error reply)', async () => {
    getSettingsValue.mockResolvedValue(true);
    parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', rawArgs: '' });
    ingestSlackFilesIntoLake.mockRejectedValue(new Error('db down'));

    await expect(runDataLakeSlackCommand({ ...baseDeps(), files: [{ id: 'F1' }] as never })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('went wrong') }));
  });

  it('surfaces an HTTPError message rethrown by the write gate (#2639)', async () => {
    // dataLakeIngestAuthz.ts rethrows anything that is not a refusal (NotFoundError/BadRequestError),
    // so an HTTPError subclass reaching here already carries a message written to be shown to the
    // caller, unlike the generic "db down" case above.
    getSettingsValue.mockResolvedValue(true);
    parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', rawArgs: '' });
    ingestSlackFilesIntoLake.mockRejectedValue(new ForbiddenError('This lake is locked pending a compliance review'));

    await runDataLakeSlackCommand({ ...baseDeps(), files: [{ id: 'F1' }] as never });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'This lake is locked pending a compliance review' })
    );
  });

  it('surfaces the message from an HTTPError-shaped error that fails instanceof (cross-realm)', async () => {
    // Simulates @bike4mind/common resolving as two module realms across the
    // @bike4mind/services -> this file boundary: a class with the exact shape a real
    // ForbiddenError constructor produces (statusCode, a name ending in "Error", and an
    // additionalInfo key) but NOT an instance of the imported HTTPError class.
    class OtherRealmForbiddenError extends Error {
      statusCode = 403;
      additionalInfo?: Record<string, unknown>;
      constructor(message: string) {
        super(message);
        this.name = 'ForbiddenError';
      }
    }
    getSettingsValue.mockResolvedValue(true);
    parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', rawArgs: '' });
    ingestSlackFilesIntoLake.mockRejectedValue(new OtherRealmForbiddenError('Cross-realm refusal message'));

    await runDataLakeSlackCommand({ ...baseDeps(), files: [{ id: 'F1' }] as never });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'Cross-realm refusal message' }));
  });

  it('falls back to the generic reply for an HTTPError with an empty message', async () => {
    getSettingsValue.mockResolvedValue(true);
    parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', rawArgs: '' });
    ingestSlackFilesIntoLake.mockRejectedValue(new ForbiddenError(''));

    await runDataLakeSlackCommand({ ...baseDeps(), files: [{ id: 'F1' }] as never });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('went wrong') }));
  });

  it('caps an oversized HTTPError message instead of relaying it verbatim', async () => {
    getSettingsValue.mockResolvedValue(true);
    parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', rawArgs: '' });
    ingestSlackFilesIntoLake.mockRejectedValue(new ForbiddenError('x'.repeat(400)));

    await runDataLakeSlackCommand({ ...baseDeps(), files: [{ id: 'F1' }] as never });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: `${'x'.repeat(300)}...` }));
  });
});
