import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Composer } from './Composer';
import type { ComposerUsage } from './statusLine';
import type { AttachmentDraft } from './useAttachments';

/**
 * Rendered to a string, like the other component tests in this package, because its vitest runs
 * on `node`. What is asked here is answerable from the markup: the indicator reports exactly
 * one of four states, and which one it picks is the whole of the change.
 */
const draft: AttachmentDraft = {
  attachments: [],
  busy: false,
  rejected: [],
  dismissRejected: () => {},
  add: async () => {},
  pick: async () => {},
  remove: () => {},
  clear: () => {},
};

const usage: ComposerUsage = { contextTokens: 44_000, contextWindow: 200_000, credits: 31_667 };

function indicator(props: Partial<Parameters<typeof Composer>[0]> = {}): string {
  const html = renderToStaticMarkup(
    <CssVarsProvider>
      <Composer
        sessionId="s1"
        disabled={false}
        streaming={false}
        attachments={draft}
        usage={usage}
        onSend={() => {}}
        onStop={() => {}}
        {...props}
      />
    </CssVarsProvider>
  );
  const text = html.match(/data-testid="composer-status-text"[^>]*>([^<]*)</);
  return text?.[1] ?? '';
}

describe('the composer indicator', () => {
  it('replaces the idle word with how full the context window is', () => {
    expect(indicator()).toBe('Context 22%');
  });

  // The three states that say something the user may need to act on. They outrank the usage
  // line, which is the one state that used to carry no information at all.
  it('still speaks for a turn in flight', () => {
    expect(indicator({ streaming: true })).toBe('Working');
  });

  it('still says when there is no session', () => {
    expect(indicator({ disabled: true })).toBe('No session');
  });

  it('still names a Code session with no folder', () => {
    expect(indicator({ notReady: 'No folder' })).toBe('No folder');
  });

  it('falls back to the old word when it has no figure to show', () => {
    expect(indicator({ usage: { contextTokens: null, contextWindow: null, credits: null } })).toBe('Ready');
    expect(indicator({ usage: null })).toBe('Ready');
  });
});
