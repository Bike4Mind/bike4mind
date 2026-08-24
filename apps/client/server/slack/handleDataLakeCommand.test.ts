import { describe, it, expect, vi, beforeEach } from 'vitest';

// The @datalake grammar parser is unit-tested in the slack package; here we mock it and exercise
// the handler's dispatch, listing and ingest-reply behavior in isolation.
const { parseDataLakeCommand } = vi.hoisted(() => ({ parseDataLakeCommand: vi.fn() }));
const { ingestSlackFilesIntoLake, ingestSlackLinkIntoLake, buildSlackAccessContext } = vi.hoisted(() => ({
  ingestSlackFilesIntoLake: vi.fn(),
  ingestSlackLinkIntoLake: vi.fn(),
  buildSlackAccessContext: vi.fn(),
}));
const { listDataLakes } = vi.hoisted(() => ({ listDataLakes: vi.fn() }));

vi.mock('@bike4mind/slack', () => ({ parseDataLakeCommand }));
vi.mock('@bike4mind/services', () => ({ dataLakeService: { listDataLakes } }));
// Both ingest paths and the shared AccessContext builder are stubbed, so these tests exercise
// dispatch and reply composition only. Each path's own behavior has its own test file.
vi.mock('./dataLakeIngestAuthz', () => ({ buildSlackAccessContext }));
vi.mock('./dataLakeFileIngest', () => ({ ingestSlackFilesIntoLake }));
vi.mock('./dataLakeLinkIngest', () => ({ ingestSlackLinkIntoLake }));

import { handleDataLakeCommand, runDataLakeSlackCommand, formatIngestOutcome } from './handleDataLakeCommand';

const actor = { id: 'u1', isAdmin: false };
const ingestDeps = { dataLakes: {} } as never;

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

      it('never prints a slug `add` cannot resolve (listed implies addable)', async () => {
        const catalog = [
          { slug: 'personal', name: 'Personal', canManage: true },
          { slug: 'ours', name: 'Ours', canManage: true, organizationId: 'org-a' },
          { slug: 'theirs', name: 'Theirs', canManage: true, organizationId: 'org-b' },
          { slug: 'open-lake', name: 'Open', canManage: true, organizationId: 'org-b', isPublic: true },
          { slug: 'notes', name: 'Org-less Notes', canManage: true },
          { slug: 'notes', name: 'Org Notes', canManage: true, organizationId: 'org-a' },
        ];
        listDataLakes.mockResolvedValue(catalog);

        const reply = await handleDataLakeCommand(baseParams({ actor: { id: 'u1', isAdmin: true } }));

        // Mirrors DataLakeModel.findBySlug: an own-org match first (lowest org id), then the
        // org-less fallback. If that rule changes, this guard is what catches the divergence.
        const findBySlug = (slug: string) => {
          const own = catalog
            .filter(l => l.slug === slug && l.organizationId && adminCtx.organizationIds.includes(l.organizationId))
            .sort((a, b) => String(a.organizationId).localeCompare(String(b.organizationId)));
          return own[0] ?? catalog.find(l => l.slug === slug && !l.organizationId) ?? null;
        };

        const slugs = printedSlugs(reply);
        expect(slugs.length).toBeGreaterThan(0);
        for (const slug of slugs) {
          const resolved = findBySlug(slug);
          expect(resolved, `add to \`${slug}\` would be refused`).not.toBeNull();
          expect(reply).toContain(resolved!.name);
        }
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
        message: 'You can only add files to a data lake you created.',
      });

      const reply = await handleDataLakeCommand(baseParams({ files: [{ id: 'F1' }] }));

      expect(reply).toBe('You can only add files to a data lake you created.');
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
});
