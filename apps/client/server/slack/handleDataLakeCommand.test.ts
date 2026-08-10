import { describe, it, expect, vi, beforeEach } from 'vitest';

// The @datalake grammar parser is unit-tested in the slack package; here we mock it and exercise
// the handler's dispatch, listing and ingest-reply behavior in isolation.
const { parseDataLakeCommand } = vi.hoisted(() => ({ parseDataLakeCommand: vi.fn() }));
const { ingestSlackFilesIntoLake, buildSlackAccessContext } = vi.hoisted(() => ({
  ingestSlackFilesIntoLake: vi.fn(),
  buildSlackAccessContext: vi.fn(),
}));
const { listDataLakes } = vi.hoisted(() => ({ listDataLakes: vi.fn() }));

vi.mock('@bike4mind/slack', () => ({ parseDataLakeCommand }));
vi.mock('@bike4mind/services', () => ({ dataLakeService: { listDataLakes } }));
vi.mock('./dataLakeFileIngest', () => ({ ingestSlackFilesIntoLake, buildSlackAccessContext }));

import { handleDataLakeCommand, runDataLakeSlackCommand, formatIngestOutcome } from './handleDataLakeCommand';

const actor = { id: 'u1', isAdmin: false, organizationId: 'org1' };
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

    it('explains the empty case rather than printing an empty list', async () => {
      listDataLakes.mockResolvedValue([{ slug: 'x', name: 'X', canManage: false }]);

      const reply = await handleDataLakeCommand(baseParams());

      expect(reply).toMatch(/cannot add to any data lakes/i);
    });
  });

  describe('add', () => {
    it('requires an explicit target lake', async () => {
      parseDataLakeCommand.mockReturnValue({ subcommand: 'add', link: 'https://x', rawArgs: '' });

      const reply = await handleDataLakeCommand(baseParams());

      expect(reply).toMatch(/name a target lake/i);
      expect(ingestSlackFilesIntoLake).not.toHaveBeenCalled();
    });

    it('refuses a bare link (LINK ingest is M3) instead of silently ingesting nothing', async () => {
      parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', link: 'https://x', rawArgs: '' });

      const reply = await handleDataLakeCommand(baseParams({ files: [] }));

      expect(reply).toMatch(/link is not supported yet/i);
      expect(ingestSlackFilesIntoLake).not.toHaveBeenCalled();
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

    it('says the link was ignored when a message carries BOTH a file and a link', async () => {
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

      const reply = await handleDataLakeCommand(baseParams({ files: [{ id: 'F1', name: 'a.pdf' }] }));

      // The files-present case falls past the bare-link refusal, so silence about the URL would
      // read as if the link had been taken too.
      expect(reply).toContain('Added 1 file to *Sales*');
      expect(reply).toMatch(/ignored the link/i);
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
    getSettingsValue.mockResolvedValue(false);

    await runDataLakeSlackCommand(baseDeps());

    expect(getSettingsValue).toHaveBeenCalledWith('EnableDataLakeSlackAdd');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ingestSlackFilesIntoLake).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
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
    // Gate on, auto-chunk off - so the confirmation must not promise the file becomes searchable.
    getSettingsValue.mockImplementation(async (key: string) => key === 'EnableDataLakeSlackAdd');
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
