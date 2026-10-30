import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@bike4mind/services/llm';
const { getFiles, signedUrl, confirm } = vi.hoisted(() => ({
  getFiles: vi.fn(),
  signedUrl: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('./listCuratedFiles', () => ({ getCuratedFiles: getFiles, listCuratedFiles: vi.fn() }));
vi.mock('./slackbotHelp', () => ({ generateHelpMessage: vi.fn() }));
vi.mock('./notebookNew', () => ({ notebookNew: vi.fn() }));
vi.mock('./notebookStatus', () => ({ notebookStatus: vi.fn() }));
vi.mock('../di/registry', () => ({ getSlackDeps: () => ({ storage: { filesStorage: { getSignedUrl: signedUrl } } }) }));
vi.mock('@bike4mind/common', () => ({ isImageServeable: (file: { blocked?: boolean }) => !file.blocked }));
import { shareCuratedFileToolDef } from './toolDefinitions';

const destination = { workspaceId: 'T123', channelId: 'C123', threadTs: '123.456' };
const file = { id: '123456789012345678901234', fileName: 'report.pdf', filePath: 'private/report.pdf' };
const context = () =>
  ({ userId: 'owner', requestConfirmation: confirm, slackDestination: destination }) as unknown as ToolContext;

describe('curated file disclosure confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFiles.mockResolvedValue([file]);
    confirm.mockResolvedValue(undefined);
  });

  it('creates a pending action bound to one file, owner and server-derived destination without minting a URL', async () => {
    const tool = shareCuratedFileToolDef.implementation(context());
    await tool.toolFn({ fileName: 'report', channelId: 'CATTACKER' });
    expect(getFiles).toHaveBeenCalledWith('owner', { limit: 5, fileName: 'report' }, undefined);
    expect(confirm).toHaveBeenCalledWith({
      tool: 'share_curated_file',
      ts: expect.any(Number),
      params: { fileId: file.id, fileName: file.fileName, userId: 'owner', ...destination },
    });
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it('refuses ambiguous names without creating a confirmation', async () => {
    getFiles.mockResolvedValue([file, { ...file, id: 'another-file' }]);
    await shareCuratedFileToolDef.implementation(context()).toolFn({ fileName: 'report' });
    expect(confirm).not.toHaveBeenCalled();
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it('refuses blocked files', async () => {
    getFiles.mockResolvedValue([{ ...file, blocked: true }]);
    await shareCuratedFileToolDef.implementation(context()).toolFn({});
    expect(confirm).not.toHaveBeenCalled();
  });

  it('fails closed in a context that cannot show a Slack confirmation', async () => {
    const noSlack = { ...context(), slackDestination: undefined };
    await shareCuratedFileToolDef.implementation(noSlack).toolFn({});
    expect(confirm).not.toHaveBeenCalled();
    expect(getFiles).not.toHaveBeenCalled();
  });
});
