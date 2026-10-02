import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TurnDot, turnState } from './TurnDot';

describe('turnState', () => {
  it('reads a window with a reply running as busy', () => {
    expect(turnState({ streaming: true, disabled: false, notReady: false })).toBe('streaming');
    expect(turnState({ streaming: false, disabled: false, notReady: false })).toBe('ready');
  });

  /**
   * The blocked states outrank the busy one rather than racing it: a window with no
   * conversation has nothing to run a turn in, and an unbound Code session cannot start one, so
   * a stale streaming flag must not paint over either.
   */
  it('lets the states that block a turn outrank the one that reports it', () => {
    expect(turnState({ streaming: true, disabled: true, notReady: false })).toBe('no-session');
    expect(turnState({ streaming: true, disabled: false, notReady: true })).toBe('not-ready');
    expect(turnState({ streaming: false, disabled: true, notReady: true })).toBe('no-session');
  });
});

describe('TurnDot', () => {
  // The dot lost the word that used to sit beside it in the composer. A bare coloured circle
  // states nothing on its own, so the word has to survive as the accessible name.
  it('names every state, because the colour is not readable on its own', () => {
    const name = (state: Parameters<typeof TurnDot>[0]['state']) =>
      renderToStaticMarkup(
        <CssVarsProvider>
          <TurnDot state={state} />
        </CssVarsProvider>
      ).match(/aria-label="([^"]*)"/)?.[1];

    expect(name('streaming')).toBe('Working');
    expect(name('no-session')).toBe('No session');
    expect(name('not-ready')).toBe('No folder');
    expect(name('ready')).toBe('Ready');
  });
});
