import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';
import type { ParsedArtifact } from '../../utils/artifactParser';
import type { ReactArtifactGroupRole } from '../../utils/reactArtifactGroup';
import PromptReplies from './PromptReplies';

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

const appTheme = extendTheme({ ...getThemeConfig() });
const queryClient = new QueryClient();

const REPLY = [
  '# Heading',
  '',
  'See [the docs][d] and a claim[^1] with $E = mc^2$.',
  '',
  '1. alpha',
  '',
  '2. beta',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```ts',
  'const a = 1;',
  '```',
  '',
  '[d]: https://example.com',
  '[^1]: Source text.',
].join('\n');

const Reply = ({ text, status }: { text: string; status: string | undefined }) => (
  <QueryClientProvider client={queryClient}>
    <CssVarsProvider theme={appTheme}>
      <PromptReplies
        messageData={{ id: 'quest-r', sessionId: 'session-1', questMasterReply: text, status } as never}
        onSendMessage={async () => {}}
      />
    </CssVarsProvider>
  </QueryClientProvider>
);

const markdownHtml = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('h1, p, ol, table, section[data-footnotes], .katex'))
    .map(el => el.outerHTML)
    .join('\n');

describe('PromptReplies reply markdown across status transitions', () => {
  it.each(['done', 'stopped'])('running -> %s ends with the same markdown as a fresh %s render', status => {
    const fresh = render(<Reply text={REPLY} status={status} />);
    const expected = markdownHtml(fresh.container);
    expect(expected).toContain('example.com');
    expect(expected).toContain('katex');
    fresh.unmount();

    const { container, rerender } = render(<Reply text="" status="running" />);
    for (let i = 4; i < REPLY.length; i += 4) rerender(<Reply text={REPLY.slice(0, i)} status="running" />);
    rerender(<Reply text={REPLY} status="running" />);
    rerender(<Reply text={REPLY} status={status} />);

    expect(markdownHtml(container)).toBe(expected);
    expect(container.querySelectorAll('section[data-footnotes]')).toHaveLength(1);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('a pending quest renders the whole reply in one parse', () => {
    const { container } = render(<Reply text={REPLY} status="pending" />);
    expect(container.querySelector('a[href="https://example.com"]')).not.toBeNull();
    expect(container.querySelector('section[data-footnotes]')).not.toBeNull();
  });
});
