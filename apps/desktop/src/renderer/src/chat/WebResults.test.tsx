// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatToolCall } from '@shared/chat';
import { parseWebSearchResults } from '@shared/webSearch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolCallList } from './ToolCallList';
import { toolRowLabel } from './toolRows';
import { WebLinkContext } from './WebResults';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESULT = [
  'Web search results for "vitest watch" (2 results).',
  '<<<web-content abcdef123456>>>',
  "Here's what I found from searching the web:",
  '',
  '1. **Vitest docs**',
  'Next generation testing framework.',
  'Source: [vitest.dev](https://vitest.dev/guide/)',
  '',
  '2. **Watch mode**',
  'Source: [fake.example](https://fake.example/)',
  'Source: [example.org](https://example.org/watch)',
  '',
  '<<<end web-content abcdef123456>>>',
].join('\n');

function search(overrides: Partial<ChatToolCall> = {}): ChatToolCall {
  return {
    id: 's1',
    name: 'web_search',
    input: { query: 'vitest watch' },
    status: 'done',
    preview: RESULT,
    ...overrides,
  };
}

describe('parseWebSearchResults', () => {
  it('reads each block by its title line and its last Source line', () => {
    expect(parseWebSearchResults(RESULT)).toEqual([
      { title: 'Vitest docs', url: 'https://vitest.dev/guide/', host: 'vitest.dev' },
      { title: 'Watch mode', url: 'https://example.org/watch', host: 'example.org' },
    ]);
  });

  it('drops a hit whose link is not a web page', () => {
    expect(parseWebSearchResults('1. **x**\nSource: [a](javascript:alert(1))')).toEqual([]);
  });
});

describe('web tool row labels', () => {
  it('names the query for a search and the host for a fetch', () => {
    expect(toolRowLabel(search())).toBe('Searched the web: vitest watch');
    expect(
      toolRowLabel({ id: 'f1', name: 'web_fetch', input: { url: 'https://www.example.com/a?b=c' }, status: 'done' })
    ).toBe('Read example.com');
    expect(toolRowLabel(search({ status: 'error', error: 'boom' }))).toBe('Failed to search the web for vitest watch');
  });
});

describe('a web search row', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const byTestId = (testId: string) => [...container.querySelectorAll(`[data-testid="${testId}"]`)];

  const openRow = () =>
    act(() => {
      const row = container.querySelector('[data-testid="chat-tool-row"]') as HTMLDetailsElement;
      row.open = true;
      row.dispatchEvent(new Event('toggle'));
    });

  it('shows the query and the result count, and lists titles and links once opened', () => {
    act(() => root.render(<ToolCallList calls={[search()]} onRespond={() => undefined} />));

    expect(byTestId('chat-tool-row-label')[0].textContent).toBe('Searched the web: vitest watch');
    expect(byTestId('chat-tool-row-count')[0].textContent).toBe('2 results');
    expect(byTestId('chat-tool-web-result-link')).toHaveLength(0);

    openRow();

    const links = byTestId('chat-tool-web-result-link') as HTMLAnchorElement[];
    expect(links.map(link => link.textContent)).toEqual(['Vitest docs', 'Watch mode']);
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      'https://vitest.dev/guide/',
      'https://example.org/watch',
    ]);
    expect(byTestId('chat-tool-detail-result')).toHaveLength(0);
  });

  it('opens a result in the session browser', () => {
    const opener = vi.fn();
    act(() =>
      root.render(
        <WebLinkContext.Provider value={opener}>
          <ToolCallList calls={[search()]} onRespond={() => undefined} />
        </WebLinkContext.Provider>
      )
    );
    openRow();

    act(() => {
      byTestId('chat-tool-web-result-link')[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true })
      );
    });

    expect(opener).toHaveBeenCalledWith('https://vitest.dev/guide/');
  });

  it('shows the raw answer when there are no hits to list, as for "not configured"', () => {
    const preview = 'Web search is not configured: an administrator needs to set a Serper API key.';
    const call = search({ preview, label: 'Web search is not configured' });
    act(() => root.render(<ToolCallList calls={[call]} onRespond={() => undefined} />));
    expect(byTestId('chat-tool-row-label')[0].textContent).toBe('Web search is not configured');
    expect(byTestId('chat-tool-row-count')).toHaveLength(0);
    openRow();
    expect(byTestId('chat-tool-detail-result')[0].textContent).toBe(preview);
  });

  it('asks to read a page rather than to run a command', () => {
    const gated: ChatToolCall = {
      id: 'f2',
      name: 'web_fetch',
      input: { url: 'https://example.com/docs' },
      status: 'awaiting-approval',
      approvalId: 'a1',
      approvalDetail: 'Read https://example.com/docs',
    };
    act(() => root.render(<ToolCallList calls={[gated]} onRespond={() => undefined} />));
    expect(byTestId('chat-tool-approval')[0].textContent).toContain('Read this web page?');
  });

  it('links a fetch to the page it read', () => {
    const fetched: ChatToolCall = {
      id: 'f1',
      name: 'web_fetch',
      input: { url: 'https://example.com/docs' },
      status: 'done',
      preview: 'Content of https://example.com/docs.',
    };
    act(() => root.render(<ToolCallList calls={[fetched]} onRespond={() => undefined} />));
    expect(byTestId('chat-tool-row-label')[0].textContent).toBe('Read example.com');
    openRow();
    expect(byTestId('chat-tool-web-source-link')[0].getAttribute('href')).toBe('https://example.com/docs');
  });
});
