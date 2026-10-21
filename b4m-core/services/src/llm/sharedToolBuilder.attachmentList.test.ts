/**
 * Only the Atlassian list tools may mint the attachment list the delete buttons act on. Any other
 * tool's result is untrusted output and must not become `quest.attachmentList`, and the source is
 * taken from which tool ran rather than from the payload.
 */
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { IUserDocument } from '@bike4mind/common';
import { buildSharedTools, type ToolBuilderDeps, type ToolBuilderCallbacks } from './sharedToolBuilder';

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getLlmByModel: vi.fn(() => ({ complete: vi.fn(), currentModel: '' })),
}));

const rejectIfExecuted = (surface: string) => () => {
  throw new Error(`${surface} was called - no tool in this suite should reach it.`);
};

const fakeStorage = {
  upload: rejectIfExecuted('storage.upload'),
  getSignedUrl: rejectIfExecuted('storage.getSignedUrl'),
  getPublicUrl: rejectIfExecuted('storage.getPublicUrl'),
} as unknown as ToolBuilderDeps['storage'];

const deps: ToolBuilderDeps = {
  userId: 'test-user',
  user: { _id: 'test-user', id: 'test-user' } as unknown as IUserDocument,
  logger: new Logger(),
  db: {} as unknown as ToolBuilderDeps['db'],
  storage: fakeStorage,
  imageGenerateStorage: fakeStorage,
  llm: { complete: rejectIfExecuted('llm.complete') } as unknown as ICompletionBackend,
};

const listPayload = (source: string) =>
  JSON.stringify({
    _attachmentList: true,
    source,
    issueKey: 'PROJ-1',
    pageId: '123',
    attachments: [{ id: 'att-1', filename: 'a.png' }],
  });

const mcpTool = (serverName: string, toolName: string, result: string): { name: string } & ICompletionOptionTools => ({
  name: `${serverName}__${toolName}`,
  toolFn: async () => result,
  toolSchema: {
    name: `${serverName}__${toolName}`,
    description: 'stub',
    parameters: { type: 'object', properties: {} },
  },
  _isMcpTool: true,
});

type AttachmentList = Parameters<NonNullable<ToolBuilderCallbacks['onAttachmentList']>>[0];

async function runTool(serverName: string, toolName: string, result: string) {
  const received: AttachmentList[] = [];
  const callbacks: ToolBuilderCallbacks = {
    onStatusUpdate: async () => {},
    onToolStart: async () => {},
    onToolFinish: async () => {},
    onAttachmentList: async list => {
      received.push(list);
    },
  };
  const tools = buildSharedTools(deps, callbacks, {
    enabledTools: [],
    mcpToolsByServer: { [serverName]: [mcpTool(serverName, toolName, result)] },
  });
  const tool = tools?.find(candidate => candidate.toolSchema.name === `${serverName}__${toolName}`);
  if (!tool) throw new Error('tool was not built');
  await tool.toolFn({});
  return received;
}

describe('buildSharedTools: _attachmentList producer gate', () => {
  it('ignores _attachmentList from a tool that is not an Atlassian list tool', async () => {
    expect(await runTool('github', 'get_issue', listPayload('jira'))).toEqual([]);
    expect(await runTool('atlassian', 'jira_get_issue', listPayload('jira'))).toEqual([]);
    expect(await runTool('other', 'jira_list_attachments', listPayload('jira'))).toEqual([]);
  });

  it('accepts the Jira list tool and derives source from the tool, not the payload', async () => {
    const received = await runTool('atlassian', 'jira_list_attachments', listPayload('confluence'));
    expect(received).toHaveLength(1);
    expect(received[0].source).toBe('jira');
  });

  it('accepts the Confluence list tool and derives source from the tool', async () => {
    const received = await runTool('atlassian', 'confluence_list_attachments', listPayload('jira'));
    expect(received).toHaveLength(1);
    expect(received[0].source).toBe('confluence');
  });
});
