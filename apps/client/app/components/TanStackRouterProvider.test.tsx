// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { render } from '@testing-library/react';

// The address each effect-time request would carry as its Referer. The stand-in router records it from
// an effect, which is when the app's first requests go out.
const addressAtEffect = vi.hoisted(() => [] as string[]);

vi.mock('../router', () => ({ router: {} }));
vi.mock('../contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'u1' } }) }));
vi.mock('../contexts/UserSettingsContext', () => ({
  UserSettingsProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('next/dynamic', () => ({
  default: () =>
    function RouterStandIn() {
      useEffect(() => {
        addressAtEffect.push(window.location.href);
      }, []);
      return null;
    },
}));

describe('TanStackRouterProvider', () => {
  afterEach(() => {
    vi.resetModules();
    addressAtEffect.length = 0;
    window.history.replaceState(null, '', '/');
  });

  it.each(['/verify-email', '/email/unsubscribe'] as const)(
    'clears a %s link token that Next wrote back after router.tsx took it, before any effect runs',
    async path => {
      window.history.replaceState(null, '', `${path}?token=tok-1`);
      const { captureEmailLinkToken, getEmailLinkToken } = await import('../utils/emailLinkToken');
      captureEmailLinkToken(); // router.tsx at module load
      // Next's App Router commits the URL it read at boot.
      window.history.replaceState(null, '', `${path}?token=tok-1`);

      const { TanStackRouterProvider } = await import('./TanStackRouterProvider');
      render(<TanStackRouterProvider />);

      expect(addressAtEffect).toEqual([`${window.location.origin}${path}`]);
      expect(window.location.href).not.toContain('tok-1');
      expect(getEmailLinkToken(path)).toBe('tok-1');
    }
  );
});
