import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getThemeConfig } from '../../utils/themes';
import { parseArtifactsWithFallback } from '../../utils/artifactParser';
import {
  classifyGeneratedFiles,
  createCodeComponent,
  PendingActionButtons,
  ReplyCompleteContext,
} from './PromptReplies';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, api: { post: postMock } };
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

  const renderCard = () =>
    render(
      <CssVarsProvider theme={appTheme}>
        <PendingActionButtons pendingAction={pendingAction} messageId="quest-1" sessionId="session-1" />
      </CssVarsProvider>
    );

  beforeEach(() => {
    postMock.mockReset();
    sessionStorage.clear();
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

  it('shows the server error message when the request is rejected with a 409', async () => {
    postMock.mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 409',
      response: { status: 409, data: { error: 'This action was replaced by a newer one.' } },
    });
    renderCard();

    fireEvent.click(screen.getByTestId('mcp-confirm-btn'));

    const error = await screen.findByTestId('mcp-confirm-error');
    expect(error.textContent).toContain('This action was replaced by a newer one.');
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
