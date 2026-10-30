import React from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { TRUNCATED_FINISH_REASON } from '@bike4mind/common';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getThemeConfig } from '../../utils/themes';
import { parseArtifactsWithFallback, type ParsedArtifact } from '../../utils/artifactParser';
import { useStreamingArtifactPersistence } from '../../hooks/useStreamingArtifactPersistence';
import {
  classifyGeneratedFiles,
  createCodeComponent,
  PendingActionButtons,
  ReplyCompleteContext,
} from './PromptReplies';
import PromptReplies from './PromptReplies';
import type { ReactArtifactGroupRole } from '../../utils/reactArtifactGroup';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, api: { post: postMock } };
});

// ReplyContainer is the only consumer of these, reached from the default export below; the
// banner's wiring can only be exercised by rendering the whole reply, which needs them stubbed.
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: 'session-1', currentSession: null, setCurrentSession: vi.fn() }),
  useWorkBenchFiles: () => [],
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: {} }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('@client/app/hooks/useMessageEditMode', () => {
  const state = { editingMessageId: undefined, editTarget: undefined, clearEdit: vi.fn() };
  return { useMessageEditMode: (selector: (s: typeof state) => unknown) => selector(state) };
});

// Stands in for the id resolver's no-row-yet path: the card shows the id it would mint from the
// index it was handed, which is what has to match the row persistence writes.
vi.mock('./artifacts/ArtifactRenderer', async () => {
  const { generateCompleteArtifactId, getArtifactTimestamp } =
    await vi.importActual<typeof import('../../utils/artifactParser')>('../../utils/artifactParser');
  return {
    default: ({
      artifact,
      index,
      messageId,
      reactGroup,
    }: {
      artifact: ParsedArtifact;
      index: number;
      messageId: string;
      reactGroup?: ReactArtifactGroupRole;
    }) => (
      <div
        data-testid={`artifact-card-${artifact.identifier}`}
        data-sibling-files={reactGroup?.role === 'entry' ? Object.keys(reactGroup.files).join(',') : ''}
      >
        {generateCompleteArtifactId(artifact.type, artifact.identifier ?? '', getArtifactTimestamp(messageId), index)}
      </div>
    ),
  };
});

const { persistArtifactsMock } = vi.hoisted(() => ({ persistArtifactsMock: vi.fn(() => Promise.resolve()) }));
vi.mock('@client/app/utils/artifactPersistence', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  persistArtifacts: persistArtifactsMock,
}));

describe('retrieval-floor banner wiring in a rendered reply', () => {
  const appTheme = extendTheme({ ...getThemeConfig() });
  const rejection = { floorPct: 75, measuredPct: 58, embeddingModel: 'text-embedding-3-small' };

  const renderReply = (promptMeta: Record<string, unknown>) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CssVarsProvider theme={appTheme}>
          <PromptReplies
            messageData={
              { id: 'quest-1', questMasterReply: 'answer with no citations', status: 'streaming', promptMeta } as never
            }
            onSendMessage={async () => {}}
          />
        </CssVarsProvider>
      </QueryClientProvider>
    );

  it('shows the banner when the floor emptied the turn and nothing was cited', () => {
    renderReply({ retrievalFloorRejection: rejection });
    expect(screen.getByTestId('retrieval-floor-warning')).toBeInTheDocument();
  });

  it('hides the banner once the turn cited a source', () => {
    renderReply({
      retrievalFloorRejection: rejection,
      // A knowledge tool can ground the turn after forced retrieval came back empty, so a cited
      // reply is not one the reader should be told used no library.
      citables: [{ id: 'https://example.com/doc', type: 'web_url', title: 'Doc' }],
    });
    expect(screen.queryByTestId('retrieval-floor-warning')).toBeNull();
  });
});

describe('retrieval-coverage notice wiring in a rendered reply', () => {
  const appTheme = extendTheme({ ...getThemeConfig() });

  const renderReply = (reply: string, { partial = true, showSyntaxHighlight = false } = {}) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CssVarsProvider theme={appTheme}>
          <PromptReplies
            messageData={{
              id: 'coverage-quest',
              sessionId: 'session-1',
              type: 'message',
              timestamp: new Date('2026-01-01T00:00:00Z'),
              prompt: 'What does the library say?',
              reply,
              questMasterReply: reply,
              status: 'done',
              promptMeta: {
                finishReason: TRUNCATED_FINISH_REASON,
                ...(partial
                  ? { retrievalCoverage: { partial: true, reasons: ['Some documents could not be searched.'] } }
                  : {}),
              },
            }}
            showSyntaxHighlight={showSyntaxHighlight}
            onSendMessage={async () => {}}
          />
        </CssVarsProvider>
      </QueryClientProvider>
    );

  it.each(['', '<think>Searching the library</think>'])(
    'keeps the notice when the reply has no visible answer: %j',
    reply => {
      renderReply(reply);

      expect(screen.getByTestId('reply-truncated-warning')).toBeInTheDocument();
      expect(screen.getByTestId('retrieval-coverage-warning')).toBeInTheDocument();
    }
  );

  it.each([false, true])('places the notice after the answer with syntax highlighting %s', showSyntaxHighlight => {
    renderReply('The library answer.', { showSyntaxHighlight });

    const answer = screen.getByText('The library answer.');
    const notice = screen.getByTestId('retrieval-coverage-warning');
    expect(answer.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.querySelector('details')).not.toHaveAttribute('open');
  });

  it('keeps an empty reply without partial coverage free of a body or coverage notice', () => {
    renderReply('', { partial: false });

    expect(screen.queryByTestId('retrieval-coverage-warning')).toBeNull();
    expect(screen.queryByTestId('ai-response-body')).toBeNull();
  });
});

describe('classifyGeneratedFiles', () => {
  it('routes each generated file to exactly one bucket (image grid / audio player / download chip)', () => {
    const { images, audio, others } = classifyGeneratedFiles(['a.png', 'b.mp3', 'c.xlsx']);
    expect(images).toEqual(['a.png']);
    expect(audio).toEqual(['b.mp3']);
    expect(others).toEqual(['c.xlsx']);
  });

  it('partitions with no loss and no double-counting across a mixed batch', () => {
    const files = ['x.jpeg', 'y.wav', 'z.pdf', 'w.svg', 'v.flac'];
    const { images, audio, others } = classifyGeneratedFiles(files);
    // Every input lands in exactly one bucket - the three buckets reconstruct the input set.
    expect([...images, ...audio, ...others].sort()).toEqual([...files].sort());
    expect(images).toEqual(['x.jpeg', 'w.svg']);
    expect(audio).toEqual(['y.wav', 'v.flac']);
    expect(others).toEqual(['z.pdf']);
  });

  it('treats .webm/.ogg as download chips, not audio (predominantly video containers)', () => {
    const { audio, others } = classifyGeneratedFiles(['clip.webm', 'track.ogg']);
    expect(audio).toEqual([]);
    expect(others).toEqual(['clip.webm', 'track.ogg']);
  });

  it('matches extensions case-insensitively', () => {
    const { images, audio } = classifyGeneratedFiles(['A.PNG', 'B.MP3']);
    expect(images).toEqual(['A.PNG']);
    expect(audio).toEqual(['B.MP3']);
  });

  it('returns empty buckets for an empty input', () => {
    expect(classifyGeneratedFiles([])).toEqual({ images: [], audio: [], others: [] });
  });
});

describe('server-marked tool output in a reply', () => {
  const appTheme = extendTheme({ ...getThemeConfig() });

  it('renders the marked block as a code block, not an artifact card', () => {
    const doc = '<!DOCTYPE html>\n<html><body><h1>Fetched page heading</h1></body></html>';
    const reply = `Here is what the page returned:\n\n~~~html b4m-tool-output\n${doc}\n~~~\n\nDone.`;
    const { artifacts, cleanedContent } = parseArtifactsWithFallback(reply);
    expect(artifacts).toHaveLength(0);

    const { container } = render(
      <CssVarsProvider theme={appTheme}>
        <ReplyCompleteContext.Provider value>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: createCodeComponent() }}>
            {cleanedContent}
          </ReactMarkdown>
        </ReplyCompleteContext.Provider>
      </CssVarsProvider>
    );

    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.querySelector('pre')?.textContent).toContain('<h1>Fetched page heading</h1>');
    expect(container.querySelector('h1')).toBeNull();
  });
});

describe('PendingActionButtons (MCP confirmation card)', () => {
  const appTheme = extendTheme({ ...getThemeConfig() });
  const pendingAction = { tool: 'create_issue', params: {}, ts: Date.now() } as React.ComponentProps<
    typeof PendingActionButtons
  >['pendingAction'];

  const renderCard = (action = pendingAction) =>
    render(
      <CssVarsProvider theme={appTheme}>
        <PendingActionButtons pendingAction={action} messageId="quest-1" sessionId="session-1" />
      </CssVarsProvider>
    );

  beforeEach(() => {
    postMock.mockReset();
    sessionStorage.clear();
  });

  it('renders Confirm and Cancel for a custom connector action, with its arguments', () => {
    renderCard({
      tool: 'create',
      params: { title: 'Ship it' },
      ts: Date.now(),
      customConnector: { connectionId: 'c1', slug: 'acme', displayName: 'Acme', urlHost: 'mcp.acme.test' },
    });

    expect(screen.getByTestId('mcp-confirm-btn')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-cancel-btn')).toBeInTheDocument();
    expect(screen.getByText(/Acme \(mcp\.acme\.test\)/)).toBeInTheDocument();
    expect(screen.getByTestId('mcp-custom-action-args')).toHaveTextContent('Ship it');
  });

  it('does not render a GitHub project chip for a custom action that reuses a project tool name', () => {
    renderCard({
      tool: 'update_project_item_fields',
      params: { display_project_name: 'Forged board', display_issue_title: '#1 - Forged' },
      ts: Date.now(),
      customConnector: { connectionId: 'c1', slug: 'acme', displayName: 'Acme', urlHost: 'mcp.acme.test' },
    });

    expect(screen.getByTestId('mcp-confirm-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-project-action-target')).not.toBeInTheDocument();
  });

  it('renders no card for an unrelated tool with no custom connector', () => {
    renderCard({ ...pendingAction, tool: 'get_issue' });

    expect(screen.queryByTestId('mcp-confirm-btn')).not.toBeInTheDocument();
  });

  it.each(['add_issue_to_project', 'update_project_item_fields'])(
    'shows the resolved project and issue target before confirming %s',
    async tool => {
      postMock.mockResolvedValue({ data: { success: true, message: 'done' } });
      renderCard({
        ...pendingAction,
        tool,
        params: {
          project_id: 'PVT_project',
          issue_node_id: 'I_issue',
          item_id: 'PVTI_item',
          display_project_name: 'Release board',
          display_issue_title: '#42 - Fix login',
          display_repository: 'example/app',
        },
      });

      const target = screen.getByTestId('mcp-project-action-target');
      expect(target).toHaveTextContent('Project: Release board');
      expect(target).toHaveTextContent('Item: #42 - Fix login');
      expect(target).toHaveTextContent('Repository: example/app');
      expect(postMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('mcp-confirm-btn'));
      await waitFor(() =>
        expect(postMock).toHaveBeenCalledExactlyOnceWith('/api/mcp/confirm', {
          questId: 'quest-1',
          sessionId: 'session-1',
          confirmed: true,
          pendingActionTs: pendingAction.ts,
        })
      );
    }
  );

  it.each(['PR #9 - Update dependencies', 'Draft: Plan the release'])(
    'shows a project item label without requiring a repository: %s',
    displayIssueTitle => {
      renderCard({
        ...pendingAction,
        tool: 'update_project_item_fields',
        params: { display_project_name: 'Roadmap', display_issue_title: displayIssueTitle },
      });

      const target = screen.getByTestId('mcp-project-action-target');
      expect(target).toHaveTextContent('Project: Roadmap');
      expect(target).toHaveTextContent(`Item: ${displayIssueTitle}`);
      expect(target).not.toHaveTextContent('Repository:');
    }
  );

  it.each([
    ['add_issue_to_project', { project_id: 'PVT_legacy', issue_node_id: 'I_legacy' }, 'I_legacy'],
    ['update_project_item_fields', { project_id: 'PVT_legacy', item_id: 'PVTI_legacy' }, 'PVTI_legacy'],
    [
      'add_issue_to_project',
      {
        project_id: 'PVT_legacy',
        issue_node_id: 'I_legacy',
        display_project_name: {},
        display_issue_title: '  ',
        display_repository: [],
      },
      'I_legacy',
    ],
  ])('falls back to target ids for %s with missing or invalid labels', (tool, params, itemId) => {
    renderCard({ ...pendingAction, tool, params });

    const target = screen.getByTestId('mcp-project-action-target');
    expect(target).toHaveTextContent('Project: PVT_legacy');
    expect(target).toHaveTextContent(`Item: ${itemId}`);
    expect(target).not.toHaveTextContent('Repository:');
  });

  it('handles missing target metadata without crashing', () => {
    renderCard({ ...pendingAction, tool: 'add_issue_to_project' });

    const target = screen.getByTestId('mcp-project-action-target');
    expect(target).toHaveTextContent('Project: Unknown project');
    expect(target).toHaveTextContent('Item: Unknown item');
  });

  it('renders labels as text rather than markup', () => {
    renderCard({
      ...pendingAction,
      tool: 'add_issue_to_project',
      params: { display_project_name: '<img src=x>', display_issue_title: '<b>Issue</b>' },
    });

    const target = screen.getByTestId('mcp-project-action-target');
    expect(target).toHaveTextContent('<img src=x>');
    expect(target).toHaveTextContent('<b>Issue</b>');
    expect(target.querySelector('img, b')).toBeNull();
  });

  it('does not add project target details to other tools', () => {
    renderCard({ ...pendingAction, params: { display_project_name: 'Unrelated' } });

    expect(screen.queryByTestId('mcp-project-action-target')).toBeNull();
    expect(screen.getByTestId('mcp-confirm-btn')).toBeInTheDocument();
  });

  it('renders no card for a pending action the confirm route will not execute', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <PendingActionButtons
          pendingAction={{ ...pendingAction, tool: 'image_generation' }}
          messageId="quest-1"
          sessionId="session-1"
        />
      </CssVarsProvider>
    );

    expect(screen.queryByTestId('mcp-confirm-btn')).toBeNull();
  });

  it('posts confirmed: true with the displayed action ts', async () => {
    postMock.mockResolvedValue({ data: { success: true, message: 'done' } });
    renderCard();

    fireEvent.click(screen.getByTestId('mcp-confirm-btn'));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith(
      '/api/mcp/confirm',
      expect.objectContaining({ confirmed: true, pendingActionTs: pendingAction.ts })
    );
  });

  it('posts confirmed: false with the displayed action ts on cancel', async () => {
    postMock.mockResolvedValue({ data: { success: true } });
    renderCard();

    fireEvent.click(screen.getByTestId('mcp-cancel-btn'));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith(
      '/api/mcp/confirm',
      expect.objectContaining({ confirmed: false, pendingActionTs: pendingAction.ts })
    );
  });

  it.each(['mcp-confirm-btn', 'mcp-cancel-btn'])(
    'keeps a lost claim unresolved and shows the 409 error after %s',
    async button => {
      postMock.mockRejectedValue({
        isAxiosError: true,
        message: 'Request failed with status code 409',
        response: { status: 409, data: { error: 'This action has already been processed.' } },
      });
      renderCard();

      fireEvent.click(screen.getByTestId(button));

      const error = await screen.findByTestId('mcp-confirm-error');
      expect(error.textContent).toContain('This action has already been processed.');
      expect(screen.queryByTestId('mcp-confirm-result')).toBeNull();
      expect(screen.getByTestId(button)).toBeTruthy();
    }
  );

  it.each(['mcp-confirm-btn', 'mcp-cancel-btn'])(
    'ends the stale card after %s receives a replaced 409',
    async button => {
      postMock.mockRejectedValue({
        isAxiosError: true,
        message: 'Request failed with status code 409',
        response: {
          status: 409,
          data: { error: 'This action was replaced by a newer one.', errorCode: 'action_replaced' },
        },
      });
      renderCard();

      fireEvent.click(screen.getByTestId(button));

      const result = await screen.findByTestId('mcp-confirm-result');
      expect(result.textContent).toContain('This action was replaced by a newer one.');
      expect(screen.queryByTestId('mcp-confirm-btn')).toBeNull();
      expect(screen.queryByTestId('mcp-cancel-btn')).toBeNull();
    }
  );

  it('shows a newly replaced action on the same mounted card', async () => {
    postMock.mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 409',
      response: {
        status: 409,
        data: { error: 'This action was replaced by a newer one.', errorCode: 'action_replaced' },
      },
    });
    const { rerender } = renderCard();

    fireEvent.click(screen.getByTestId('mcp-confirm-btn'));
    await screen.findByTestId('mcp-confirm-result');

    const nextAction = { ...pendingAction, ts: pendingAction.ts + 1 };
    rerender(
      <CssVarsProvider theme={appTheme}>
        <PendingActionButtons pendingAction={nextAction} messageId="quest-1" sessionId="session-1" />
      </CssVarsProvider>
    );

    expect(screen.getByTestId('mcp-confirm-btn')).toBeTruthy();
    expect(screen.queryByTestId('mcp-confirm-result')).toBeNull();
    expect(screen.queryByTestId('mcp-confirm-error')).toBeNull();
  });

  it('does not reuse a stored result when a newer action arrives on the same message', async () => {
    postMock.mockResolvedValue({ data: { success: true, message: 'Issue #1 created' } });
    const { rerender } = renderCard();

    fireEvent.click(screen.getByTestId('mcp-confirm-btn'));
    await screen.findByTestId('mcp-confirm-result');

    const nextAction = { ...pendingAction, ts: pendingAction.ts + 1 };
    rerender(
      <CssVarsProvider theme={appTheme}>
        <PendingActionButtons pendingAction={nextAction} messageId="quest-1" sessionId="session-1" />
      </CssVarsProvider>
    );

    expect(screen.getByTestId('mcp-confirm-btn')).toBeTruthy();
    expect(screen.queryByTestId('mcp-confirm-result')).toBeNull();
  });

  it('ends the card when the server reports a replaced action by code, not text', async () => {
    postMock.mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 409',
      response: {
        status: 409,
        data: { error: 'The action you reviewed is no longer current.', errorCode: 'action_replaced' },
      },
    });
    renderCard();

    fireEvent.click(screen.getByTestId('mcp-confirm-btn'));

    const result = await screen.findByTestId('mcp-confirm-result');
    expect(result.textContent).toContain('The action you reviewed is no longer current.');
    expect(screen.queryByTestId('mcp-confirm-btn')).toBeNull();
  });

  it('keeps the card open when the replaced code arrives without a 409', async () => {
    postMock.mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 400',
      response: { status: 400, data: { error: 'Bad request', errorCode: 'action_replaced' } },
    });
    renderCard();

    fireEvent.click(screen.getByTestId('mcp-confirm-btn'));

    const error = await screen.findByTestId('mcp-confirm-error');
    expect(error.textContent).toContain('Bad request');
    expect(screen.getByTestId('mcp-confirm-btn')).toBeTruthy();
    expect(screen.queryByTestId('mcp-confirm-result')).toBeNull();
  });

  it('keeps the card open on a 409 that carries no replaced code', async () => {
    postMock.mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 409',
      response: { status: 409, data: { error: 'This action has already been processed.' } },
    });
    renderCard();

    fireEvent.click(screen.getByTestId('mcp-confirm-btn'));

    const error = await screen.findByTestId('mcp-confirm-error');
    expect(error.textContent).toContain('This action has already been processed.');
    expect(screen.getByTestId('mcp-confirm-btn')).toBeTruthy();
  });

  it.each([
    ['an axios error with no body', { isAxiosError: true, message: 'Network Error' }, 'Network Error'],
    ['a plain Error', new Error('boom'), 'boom'],
    ['a thrown non-Error', 'x', 'Failed to execute action'],
  ])('surfaces the underlying message for %s', async (_label, thrown, expected) => {
    postMock.mockRejectedValue(thrown);
    renderCard();

    fireEvent.click(screen.getByTestId('mcp-confirm-btn'));

    const error = await screen.findByTestId('mcp-confirm-error');
    expect(error.textContent).toContain(expected);
  });

  it('keeps the card open for a retry when a pre-execution check rejects with a 400', async () => {
    postMock.mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 400',
      response: { status: 400, data: { success: false, error: 'Repository "o/r" is not enabled.' } },
    });
    renderCard();

    fireEvent.click(screen.getByTestId('mcp-confirm-btn'));

    const error = await screen.findByTestId('mcp-confirm-error');
    expect(error.textContent).toContain('Repository "o/r" is not enabled.');
    expect(screen.getByTestId('mcp-confirm-btn')).toBeTruthy();
  });

  // success:false only comes back after the claim, so the action is gone and there is nothing to retry.
  it('shows a post-claim execution failure as the final result', async () => {
    postMock.mockResolvedValue({ data: { success: false, message: 'Tool execution failed' } });
    renderCard();

    fireEvent.click(screen.getByTestId('mcp-confirm-btn'));

    const result = await screen.findByTestId('mcp-confirm-result');
    expect(result.textContent).toContain('Tool execution failed');
    expect(screen.queryByTestId('mcp-confirm-btn')).toBeNull();
  });
});

describe('reply UI side effects: live only on first arrival', () => {
  const appTheme = extendTheme({ ...getThemeConfig() });
  const effects = [{ type: 'plugin-effect', payload: { v: 1 } }];
  let seq = 0;
  const handler = vi.fn((_effects: unknown[], _options: { live?: boolean; dedupeKey?: string }) => 1);
  let unregister: () => void = () => {};

  beforeEach(async () => {
    const { registerUiSideEffectHandler } = await import('@client/app/utils/uiSideEffectDispatcher');
    unregister();
    handler.mockClear();
    unregister = registerUiSideEffectHandler(handler);
    seq += 1;
  });

  const replyId = (suffix = '') => `side-effect-quest-${seq}${suffix}`;
  const sessionOf = () => `side-effect-session-${seq}`;

  const reply = (id: string, status: string, withEffects = status === 'done') => (
    <QueryClientProvider client={new QueryClient()}>
      <CssVarsProvider theme={appTheme}>
        <PromptReplies
          key={id}
          messageData={
            {
              id,
              sessionId: sessionOf(),
              questMasterReply: 'answer',
              status,
              ...(withEffects ? { uiSideEffects: effects } : {}),
            } as never
          }
          onSendMessage={async () => {}}
        />
      </CssVarsProvider>
    </QueryClientProvider>
  );

  const liveCalls = () => handler.mock.calls.filter(([, options]) => options.live === true);
  const replayCalls = () => handler.mock.calls.filter(([, options]) => !options.live);

  it('dispatches live exactly once when a streaming reply finishes', () => {
    const id = replyId();
    const { rerender } = render(reply(id, 'running'));
    expect(handler).not.toHaveBeenCalled();
    rerender(reply(id, 'done'));
    rerender(reply(id, 'done'));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(liveCalls()[0][1]).toEqual({ live: true, dedupeKey: id });
  });

  it('does not dispatch the same finished reply again when it remounts', () => {
    const id = replyId();
    const first = render(reply(id, 'running'));
    first.rerender(reply(id, 'done'));
    first.unmount();
    render(reply(id, 'done'));
    expect(liveCalls()).toHaveLength(1);
    expect(replayCalls()).toHaveLength(0);
  });

  it('replays, never live, a finished reply a refetch re-keys under a new id', () => {
    const id = replyId();
    const { rerender } = render(reply(id, 'running'));
    rerender(reply(id, 'done'));
    handler.mockClear();
    const rekeyed = replyId('-rekeyed');
    rerender(reply(rekeyed, 'done'));
    expect(liveCalls()).toHaveLength(0);
    expect(replayCalls()).toHaveLength(1);
    expect(replayCalls()[0][1]).toEqual({ dedupeKey: rekeyed });
  });

  it('replays once, never live, a reply already finished when the page loaded', () => {
    const id = replyId();
    const first = render(reply(id, 'done'));
    first.unmount();
    render(reply(id, 'done'));
    expect(liveCalls()).toHaveLength(0);
    expect(replayCalls()).toHaveLength(1);
    expect(replayCalls()[0][1]).toEqual({ dedupeKey: id });
  });

  it('replays a finished reply again once its session view is released', async () => {
    const { forgetSessionDispatches } = await import('@client/app/utils/uiSideEffectDispatcher');
    const id = replyId();
    const first = render(reply(id, 'running'));
    first.rerender(reply(id, 'done'));
    first.unmount();
    forgetSessionDispatches(sessionOf());
    render(reply(id, 'done'));
    expect(liveCalls()).toHaveLength(1);
    expect(replayCalls()).toHaveLength(1);
  });

  it('replays, never live, a reply that finishes while its session view is away', async () => {
    const { forgetSessionDispatches, noteReplyInFlight } = await import('@client/app/utils/uiSideEffectDispatcher');
    const id = replyId();
    noteReplyInFlight(id, sessionOf());
    forgetSessionDispatches(sessionOf());
    render(reply(id, 'done'));
    expect(liveCalls()).toHaveLength(0);
    expect(replayCalls()).toHaveLength(1);
  });

  it('replays, never live, effects that a refetch adds to a reply that finished without any', () => {
    const id = replyId();
    const { rerender } = render(reply(id, 'running'));
    rerender(reply(id, 'done', false));
    expect(handler).not.toHaveBeenCalled();
    rerender(reply(id, 'done', true));
    expect(liveCalls()).toHaveLength(0);
    expect(replayCalls()).toHaveLength(1);
  });

  it('does not dispatch a reply the streaming completion already applied live', async () => {
    const { claimLiveDispatch, noteReplyInFlight } = await import('@client/app/utils/uiSideEffectDispatcher');
    const id = replyId();
    noteReplyInFlight(id, sessionOf());
    expect(claimLiveDispatch(id, sessionOf())).toBe(true);
    const { rerender } = render(reply(id, 'running'));
    rerender(reply(id, 'done'));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('artifact card ids agree with the rows persistence writes', () => {
  const appTheme = extendTheme({ ...getThemeConfig() });
  const questId = 'artifact-ids-quest';
  const stopwatch =
    '<artifact identifier="Stopwatch" type="application/vnd.ant.react" title="Stopwatch">\n' +
    'export default function Stopwatch() { return null; }\n</artifact>';
  const app =
    '<artifact identifier="App" type="application/vnd.ant.react" title="App">\n' +
    'import Stopwatch from "./Stopwatch";\nexport default function App() { return <Stopwatch />; }\n</artifact>';
  const board = '<artifact identifier="board" type="application/vnd.ant.chess" title="Board">no position</artifact>';
  const midStream = `Here is the timer:\n\n${stopwatch}\n\nAnd the app that uses it:`;
  const finished = `${midStream}\n\n${app}\n\nAnd a board:\n\n${board}`;

  const reply = (questMasterReply: string, status: string) => (
    <QueryClientProvider client={new QueryClient()}>
      <CssVarsProvider theme={appTheme}>
        <PromptReplies
          messageData={{ id: questId, sessionId: 'session-1', questMasterReply, status } as never}
          onSendMessage={async () => {}}
        />
      </CssVarsProvider>
    </QueryClientProvider>
  );

  const persistedIds = async (replyText: string) => {
    persistArtifactsMock.mockClear();
    const { result } = renderHook(() => useStreamingArtifactPersistence());
    result.current.persistArtifactsFromQuest({ id: questId, sessionId: 'session-1', replies: [replyText] });
    await waitFor(() => expect(persistArtifactsMock).toHaveBeenCalledTimes(1));
    const [rows] = persistArtifactsMock.mock.calls[0] as unknown as [{ id: string; identifier?: string }[]];
    return Object.fromEntries(rows.map(row => [row.identifier, row.id]));
  };

  it('gives each finished card the id its row is saved under, chess included in the count', async () => {
    const { rerender } = render(reply(midStream, 'running'));
    // Mid-stream the earlier artifact is the only one parsed, so it sits at index 0 - not the
    // index it ends up with. That id is provisional; the resolver must not keep it.
    const midStreamId = screen.getByTestId('artifact-card-Stopwatch').textContent;

    rerender(reply(finished, 'done'));
    const rows = await persistedIds(finished);

    expect(screen.getByTestId('artifact-card-App')).toHaveTextContent(rows.App);
    expect(screen.getByTestId('artifact-card-Stopwatch')).toHaveTextContent(rows.Stopwatch);
    expect(midStreamId).not.toBe(rows.Stopwatch);
  });

  it.each(['', '\n\n', ' \t\n'])(
    'keeps entry offsets stable through a sibling stream with leading whitespace %j',
    prefix => {
      const { rerender } = render(reply(`${prefix}${app}`, 'running'));
      const entryCard = screen.getByTestId('artifact-card-App');
      expect(entryCard).toHaveAttribute('data-sibling-files', '');

      const partialSibling = '<artifact identifier="Stopwatch" type="application/vnd.ant.react" title="Stopwatch">';
      rerender(reply(`${prefix}${app}\n\n${partialSibling}`, 'running'));
      expect(screen.getByTestId('artifact-card-App')).toBe(entryCard);

      rerender(reply(`${prefix}${app}\n\n${stopwatch}`, 'done'));
      expect(screen.getByTestId('artifact-card-App')).toBe(entryCard);
      expect(entryCard).toHaveAttribute('data-sibling-files', 'Stopwatch');
    }
  );

  it('keeps an earlier entry mounted when a later opening tag is cut off at completion', () => {
    const prefix = '\n\n';
    const { rerender } = render(reply(`${prefix}${app}`, 'running'));
    const entryCard = screen.getByTestId('artifact-card-App');
    const partialReply = `${prefix}${app}\n\n<artifact identifier="Stopwatch"`;

    rerender(reply(partialReply, 'running'));
    expect(screen.getByTestId('artifact-card-App')).toBe(entryCard);
    rerender(reply(partialReply, 'done'));
    expect(screen.getByTestId('artifact-card-App')).toBe(entryCard);
  });
});

describe('empty fences in a reply', () => {
  const appTheme = extendTheme({ ...getThemeConfig() });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws and copies empty fences without the word undefined', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { container } = render(
      <CssVarsProvider theme={appTheme}>
        <ReplyCompleteContext.Provider value>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: createCodeComponent() }}>
            {'```\n```\n\n```ts\n```'}
          </ReactMarkdown>
        </ReplyCompleteContext.Provider>
      </CssVarsProvider>
    );

    const codes = container.querySelectorAll('pre code');
    expect(codes).toHaveLength(2);
    codes.forEach(code => expect(code.textContent).toBe(''));
    expect(container.textContent).not.toContain('undefined');
    screen.getAllByTestId('code-block-copy-btn').forEach(button => fireEvent.click(button));
    await waitFor(() => expect(writeText.mock.calls).toEqual([[''], ['']]));
  });
});
