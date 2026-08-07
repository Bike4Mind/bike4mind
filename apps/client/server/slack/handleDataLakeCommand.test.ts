import { describe, it, expect, vi, beforeEach } from 'vitest';

// The @datalake grammar parser is unit-tested in the slack package; here we mock it
// and exercise the handler's dispatch + lake-resolution behavior in isolation.
const { parseDataLakeCommand } = vi.hoisted(() => ({ parseDataLakeCommand: vi.fn() }));
vi.mock('@bike4mind/slack', () => ({ parseDataLakeCommand }));

import { handleDataLakeCommand, runDataLakeSlackCommand } from './handleDataLakeCommand';

describe('handleDataLakeCommand', () => {
  const findBySlug = vi.fn();
  const dataLakes = { findBySlug };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns help text for `help` without touching the DB', async () => {
    parseDataLakeCommand.mockReturnValue({ subcommand: 'help', rawArgs: '' });
    const reply = await handleDataLakeCommand({ command: '@datalake help', dataLakes });
    expect(reply).toContain('Data Lake commands');
    expect(findBySlug).not.toHaveBeenCalled();
  });

  it('returns a placeholder for `list` (full listing lands with AccessContext in M2)', async () => {
    parseDataLakeCommand.mockReturnValue({ subcommand: 'list', rawArgs: '' });
    const reply = await handleDataLakeCommand({ command: '@datalake list', dataLakes });
    expect(reply).toMatch(/coming soon/i);
  });

  it('resolves an existing lake by slug (org-scoped) for `add`', async () => {
    parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', link: 'https://x', rawArgs: '' });
    findBySlug.mockResolvedValue({ name: 'Sales Intelligence', slug: 'sales' });

    const reply = await handleDataLakeCommand({ command: 'x', organizationId: 'org1', dataLakes });

    expect(findBySlug).toHaveBeenCalledWith('sales', 'org1');
    expect(reply).toContain('Sales Intelligence');
  });

  it('reports an unknown lake for `add`', async () => {
    parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'ghost', rawArgs: '' });
    findBySlug.mockResolvedValue(null);

    const reply = await handleDataLakeCommand({ command: 'x', dataLakes });

    expect(reply).toMatch(/No Data Lake `ghost`/);
  });

  it('requires an explicit target lake for `add`', async () => {
    parseDataLakeCommand.mockReturnValue({ subcommand: 'add', link: 'https://x', rawArgs: '' });

    const reply = await handleDataLakeCommand({ command: 'x', dataLakes });

    expect(reply).toMatch(/name a target lake/i);
    expect(findBySlug).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized subcommand', async () => {
    parseDataLakeCommand.mockReturnValue({ subcommand: 'unknown', rawArgs: '' });
    const reply = await handleDataLakeCommand({ command: 'x', dataLakes });
    expect(reply).toMatch(/Unrecognized/);
  });
});

describe('runDataLakeSlackCommand (gate + dispatch)', () => {
  const findBySlug = vi.fn();
  const dataLakes = { findBySlug };
  const getSettingsValue = vi.fn();
  const adminSettings = { getSettingsValue };
  const sendMessage = vi.fn().mockResolvedValue('1700000000.0001');
  const logger = { info: vi.fn(), error: vi.fn() };

  const baseDeps = () => ({
    command: '@datalake help',
    channel: 'C1',
    threadTs: 'T1',
    adminSettings,
    dataLakes,
    sendMessage,
    logger,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a silent no-op when the flag is off (dormant): no reply, no lake lookup', async () => {
    getSettingsValue.mockResolvedValue(false);
    await runDataLakeSlackCommand(baseDeps());
    expect(getSettingsValue).toHaveBeenCalledWith('EnableDataLakeSlackAdd');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(findBySlug).not.toHaveBeenCalled();
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

  it('resolves the lake (org-scoped) for `add` when enabled', async () => {
    getSettingsValue.mockResolvedValue(true);
    parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', rawArgs: '' });
    findBySlug.mockResolvedValue({ name: 'Sales Intelligence', slug: 'sales' });

    await runDataLakeSlackCommand({ ...baseDeps(), command: 'x', organizationId: 'org1' });

    expect(findBySlug).toHaveBeenCalledWith('sales', 'org1');
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Sales Intelligence') })
    );
  });

  it('swallows errors so the caller still acks 200 (logs + best-effort error reply)', async () => {
    getSettingsValue.mockResolvedValue(true);
    parseDataLakeCommand.mockReturnValue({ subcommand: 'add', lakeSlug: 'sales', rawArgs: '' });
    findBySlug.mockRejectedValue(new Error('db down'));

    await expect(
      runDataLakeSlackCommand({ ...baseDeps(), command: 'x', organizationId: 'org1' })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('went wrong') }));
  });
});
