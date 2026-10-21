import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AuthState, EnvironmentPresetId } from '@shared/auth';
import { EnvironmentPicker } from './EnvironmentPicker';

/**
 * Rendered to a string, like CustomizePanel's tests and for the same reason: this package's
 * vitest runs on `node`.
 *
 * That confines these to the first render, where the pending choice still equals the active
 * environment. The state this component used to get wrong - a pending choice beside an
 * unlabelled active one - needs a click to reach, so it is checked by hand; what is asserted
 * here is the structure that makes it unreadable-proof, namely that the active server is
 * captioned and sits ahead of the control that replaces it.
 */
const markup = (node: React.ReactNode) => renderToStaticMarkup(<CssVarsProvider>{node}</CssVarsProvider>);

function stateFor(preset: EnvironmentPresetId, url: string, label: string): AuthState {
  return {
    status: 'signed-out',
    environment: { preset, url, label },
    hostedAvailable: true,
    storage: 'available',
    busy: 'idle',
  };
}

const local = stateFor('local', 'http://localhost:3000', 'Local Dev');

describe('the environment picker', () => {
  it('captions the active server instead of leaving a bare label and URL', () => {
    const html = markup(<EnvironmentPicker state={local} />);
    expect(html).toContain('data-testid="environment-active-text"');
    expect(html).toContain('Now using Local Dev');
    expect(html).toContain('http://localhost:3000');
  });

  // The original bug: the active server sat inline with the button that switches away from it,
  // so "Use this server" read as naming the server printed next to it.
  it('puts the active server ahead of the apply button', () => {
    const html = markup(<EnvironmentPicker state={local} />);
    expect(html.indexOf('environment-active-text')).toBeLessThan(html.indexOf('environment-apply-btn'));
    expect(html.slice(html.indexOf('environment-apply-btn'))).not.toContain('http://localhost:3000');
  });

  it('names the server the button would switch to', () => {
    expect(markup(<EnvironmentPicker state={local} />)).toContain('Switch to Local Dev');
    expect(
      markup(<EnvironmentPicker state={stateFor('hosted', 'https://app.bike4mind.com', 'Production')} />)
    ).toContain('Switch to Production');
    expect(markup(<EnvironmentPicker state={stateFor('custom', 'https://b4m.example.com', 'Remote')} />)).toContain(
      'Switch to this URL'
    );
    expect(markup(<EnvironmentPicker state={local} />)).not.toContain('Use this server');
  });

  it('says so plainly when the pending choice is already the active server', () => {
    const html = markup(<EnvironmentPicker state={local} />);
    expect(html).toContain('Already the server in use.');
    expect(html).toMatch(
      /data-testid="environment-apply-btn"[^>]*disabled|disabled[^>]*data-testid="environment-apply-btn"/
    );
  });

  it('keeps the custom preset editable', () => {
    const html = markup(<EnvironmentPicker state={stateFor('custom', 'https://b4m.example.com', 'Remote')} />);
    expect(html).toContain('data-testid="environment-url-input"');
    expect(html).toContain('value="https://b4m.example.com"');
  });

  /**
   * An unconfigured build reports a preset with an empty url, so `unchanged` is true there
   * without the user being on any server. The caption has to say that, not the opposite.
   */
  it('does not pretend a server is in use when none resolves', () => {
    const html = markup(
      <EnvironmentPicker state={{ ...stateFor('custom', '', 'Unconfigured'), status: 'unconfigured' }} />
    );
    expect(html).toContain('No server is set yet.');
    expect(html).not.toContain('Now using');
    expect(html).not.toContain('Already the server in use.');
  });
});
