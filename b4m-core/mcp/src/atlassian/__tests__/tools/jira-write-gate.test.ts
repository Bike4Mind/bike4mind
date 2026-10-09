import { describe, it, expect, vi, beforeEach } from 'vitest';

const jiraApi = vi.hoisted(() => ({
  addComment: vi.fn(),
  bulkTransitionIssues: vi.fn(),
  bulkUpdateIssues: vi.fn(),
  bulkCreateIssues: vi.fn(),
  addWatcher: vi.fn(),
  removeWatcher: vi.fn(),
  searchUsers: vi.fn(),
  agile: {
    createSprint: vi.fn(),
    updateSprint: vi.fn(),
    moveIssuesToSprint: vi.fn(),
  },
}));

vi.mock('../../client.js', () => ({
  getJiraApi: () => jiraApi,
}));

import { registerJiraWorkflowTools } from '../../tools/jira-workflows.js';
import { registerJiraIssueTools } from '../../tools/jira-issues.js';
import { registerJiraUserTools } from '../../tools/jira-users.js';
import { registerJiraAgileTools } from '../../tools/jira-agile.js';
import {
  JIRA_ADD_COMMENT,
  JIRA_BULK_TRANSITION_ISSUES,
  JIRA_BULK_UPDATE_ISSUES,
  JIRA_BULK_CREATE_ISSUES,
  JIRA_ADD_WATCHER,
  JIRA_REMOVE_WATCHER,
  JIRA_CREATE_SPRINT,
  JIRA_UPDATE_SPRINT,
  JIRA_MOVE_ISSUES_TO_SPRINT,
} from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

type ConfirmToken = { tool: string; params: Record<string, unknown>; ts: number };

const decodeToken = (token: unknown): ConfirmToken =>
  JSON.parse(Buffer.from(String(token), 'base64').toString('utf8')) as ConfirmToken;

type GatedCase = {
  tool: string;
  args: Record<string, unknown>;
  write: () => ReturnType<typeof vi.fn>;
  expectedWriteArgs: unknown;
  /** What the confirm token replays, when it differs from the model's args. */
  expectedTokenParams?: Record<string, unknown>;
};

// Long enough, and without '@' or a space, to be sent verbatim as an account ID.
const ACCOUNT_ID = '5b10ac8d82e05b22cc7d4ef5';

const issuesToCreate = [
  { projectKey: 'PROJ', summary: 'One', issueTypeName: 'Task' },
  { projectKey: 'PROJ', summary: 'Two', issueTypeName: 'Task', labels: ['a'] },
];

const cases: GatedCase[] = [
  {
    tool: JIRA_ADD_COMMENT,
    args: { issueKey: 'PROJ-1', body: 'hello' },
    write: () => jiraApi.addComment,
    expectedWriteArgs: { issueKey: 'PROJ-1', body: 'hello' },
  },
  {
    tool: JIRA_BULK_TRANSITION_ISSUES,
    args: {
      issues: [
        { issueIdOrKey: 'PROJ-1', transitionId: '31' },
        { issueIdOrKey: 'PROJ-2', transitionId: '41' },
      ],
    },
    write: () => jiraApi.bulkTransitionIssues,
    expectedWriteArgs: {
      issues: [
        { issueIdOrKey: 'PROJ-1', transitionId: '31' },
        { issueIdOrKey: 'PROJ-2', transitionId: '41' },
      ],
    },
  },
  {
    tool: JIRA_BULK_UPDATE_ISSUES,
    args: { issueIdsOrKeys: ['PROJ-1', 'PROJ-2'], labels: { values: ['x'], action: 'ADD' } },
    write: () => jiraApi.bulkUpdateIssues,
    expectedWriteArgs: { issueIdsOrKeys: ['PROJ-1', 'PROJ-2'], labels: { values: ['x'], action: 'ADD' } },
  },
  {
    tool: JIRA_BULK_CREATE_ISSUES,
    args: { issues: issuesToCreate },
    write: () => jiraApi.bulkCreateIssues,
    expectedWriteArgs: { issues: issuesToCreate },
  },
  {
    tool: JIRA_ADD_WATCHER,
    args: { issueKey: 'PROJ-1', userIdentifier: 'a@example.com' },
    write: () => jiraApi.addWatcher,
    expectedWriteArgs: { issueKey: 'PROJ-1', accountId: ACCOUNT_ID },
    expectedTokenParams: { issueKey: 'PROJ-1', userIdentifier: ACCOUNT_ID, displayName: 'Ada' },
  },
  {
    tool: JIRA_REMOVE_WATCHER,
    args: { issueKey: 'PROJ-1', userIdentifier: 'a@example.com' },
    write: () => jiraApi.removeWatcher,
    expectedWriteArgs: { issueKey: 'PROJ-1', accountId: ACCOUNT_ID },
    expectedTokenParams: { issueKey: 'PROJ-1', userIdentifier: ACCOUNT_ID, displayName: 'Ada' },
  },
  {
    tool: JIRA_CREATE_SPRINT,
    args: { name: 'Sprint 5', boardId: 7, goal: 'ship', startDate: '2024-01-15T09:00:00.000Z' },
    write: () => jiraApi.agile.createSprint,
    expectedWriteArgs: {
      name: 'Sprint 5',
      originBoardId: 7,
      goal: 'ship',
      startDate: '2024-01-15T09:00:00.000Z',
      endDate: undefined,
    },
  },
  {
    tool: JIRA_UPDATE_SPRINT,
    args: { sprintId: 9, name: 'Renamed', state: 'active' },
    write: () => jiraApi.agile.updateSprint,
    expectedWriteArgs: {
      sprintId: 9,
      name: 'Renamed',
      goal: undefined,
      startDate: undefined,
      endDate: undefined,
      state: 'active',
    },
  },
  {
    tool: JIRA_MOVE_ISSUES_TO_SPRINT,
    args: { sprintId: 9, issues: ['PROJ-1', 'PROJ-2'] },
    write: () => jiraApi.agile.moveIssuesToSprint,
    expectedWriteArgs: { sprintId: 9, issues: ['PROJ-1', 'PROJ-2'] },
  },
];

describe('Jira write tools are gated behind preview/confirm', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    jiraApi.searchUsers.mockResolvedValue([{ accountId: ACCOUNT_ID, displayName: 'Ada' }]);
    jiraApi.bulkTransitionIssues.mockResolvedValue({ taskId: 't', issueCount: 2, message: 'ok' });
    jiraApi.bulkUpdateIssues.mockResolvedValue({ taskId: 't', issueCount: 2, message: 'ok' });
    jiraApi.bulkCreateIssues.mockResolvedValue({ issues: [{ key: 'PROJ-9' }], errors: [] });
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerJiraWorkflowTools(mock.server);
    registerJiraIssueTools(mock.server);
    registerJiraUserTools(mock.server);
    registerJiraAgileTools(mock.server);
  });

  describe.each(cases)('$tool', ({ tool, args, write, expectedWriteArgs, expectedTokenParams }) => {
    it('returns a preview without writing when called by the model', async () => {
      const result = await registeredTools.get(tool)!.handler({ ...args });

      expect(write()).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      const token = decodeToken(parsed._confirmToken);
      expect(token.tool).toBe(tool);
      expect(token.params).toEqual(expectedTokenParams ?? JSON.parse(JSON.stringify(args)));
    });

    it('still previews when the model passes confirmed or a false execute flag', async () => {
      const result = await registeredTools.get(tool)!.handler({ ...args, confirmed: true, _executeFromButton: false });

      expect(write()).not.toHaveBeenCalled();
      expect(parseResponse(result).action).toBe('preview');
    });

    it('writes when executed from the confirm button', async () => {
      write().mockResolvedValue({});
      await registeredTools.get(tool)!.handler({ ...args, _executeFromButton: true });

      expect(write()).toHaveBeenCalledTimes(1);
      expect(write()).toHaveBeenCalledWith(expectedWriteArgs);
    });
  });

  describe.each([JIRA_ADD_WATCHER, JIRA_REMOVE_WATCHER])('%s preview user lookup', tool => {
    const args = { issueKey: 'PROJ-1', userIdentifier: 'a@example.com' };

    it('shows the resolved user when the lookup succeeds', async () => {
      const parsed = parseResponse<{ watcher: Record<string, unknown> }>(
        await registeredTools.get(tool)!.handler({ ...args })
      );

      expect(parsed.watcher).toMatchObject({
        issueKey: 'PROJ-1',
        userIdentifier: 'a@example.com',
        accountId: ACCOUNT_ID,
        displayName: 'Ada',
      });
    });

    it('replays the account the preview showed, without searching again', async () => {
      const preview = parseResponse(await registeredTools.get(tool)!.handler({ ...args }));
      const { params } = decodeToken(preview._confirmToken);
      jiraApi.searchUsers.mockClear();

      await registeredTools.get(tool)!.handler({ ...params, _executeFromButton: true });

      expect(jiraApi.searchUsers).not.toHaveBeenCalled();
      const write = tool === JIRA_ADD_WATCHER ? jiraApi.addWatcher : jiraApi.removeWatcher;
      expect(write).toHaveBeenCalledWith({ issueKey: 'PROJ-1', accountId: ACCOUNT_ID });
    });

    it('shows an account-ID-like identifier as the account it will act on, without searching', async () => {
      const parsed = parseResponse<{ watcher: Record<string, unknown> }>(
        await registeredTools.get(tool)!.handler({ issueKey: 'PROJ-1', userIdentifier: ACCOUNT_ID })
      );

      expect(jiraApi.searchUsers).not.toHaveBeenCalled();
      expect(parsed.watcher).toEqual({ issueKey: 'PROJ-1', userIdentifier: ACCOUNT_ID, accountId: ACCOUNT_ID });
    });

    it('falls back to a bare preview when the lookup throws', async () => {
      jiraApi.searchUsers.mockRejectedValue(new Error('boom'));

      const parsed = parseResponse<{ watcher: Record<string, unknown> }>(
        await registeredTools.get(tool)!.handler({ ...args })
      );

      expect(parsed.watcher).toEqual(args);
      expect(jiraApi.addWatcher).not.toHaveBeenCalled();
      expect(jiraApi.removeWatcher).not.toHaveBeenCalled();
    });
  });
});
