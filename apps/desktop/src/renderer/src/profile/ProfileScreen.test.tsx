import { renderToStaticMarkup } from 'react-dom/server';
import type { AuthState } from '@shared/auth';
import { describe, expect, it } from 'vitest';
import { ProfileScreen } from './ProfileScreen';

const STATE: AuthState = {
  status: 'signed-in',
  environment: { preset: 'hosted', url: 'https://example.invalid', label: 'Production' },
  hostedAvailable: true,
  storage: 'available',
  busy: 'idle',
  user: { id: 'user-1', nickname: 'Ada Lovelace' },
};

/**
 * Rendered to a string, so no effect runs and what is under test is the state the screen shows
 * BEFORE any answer arrives - which is the one a signed-in user sees first.
 */
const html = renderToStaticMarkup(<ProfileScreen state={STATE} onClose={() => {}} />);

describe('ProfileScreen', () => {
  it('names the account and the server it is on', () => {
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Production');
  });

  // Loading is its own state. A zero here would be read as a balance of zero and a window that
  // spent nothing, neither of which has been established yet.
  it('says it is still reading rather than drawing zeros', () => {
    expect(html).toContain('profile-usage-loading');
    expect(html).not.toContain('profile-usage-error');
    expect(html).not.toContain('profile-credits-chart');
  });

  it('offers both windows and starts on the short one', () => {
    expect(html).toContain('Last 24 Hours');
    expect(html).toContain('Last 30 Days');
    expect(html).toContain('aria-pressed="true"');
  });
});
