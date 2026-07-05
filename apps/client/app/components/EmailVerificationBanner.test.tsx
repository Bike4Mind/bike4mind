import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';
import EmailVerificationBanner from './EmailVerificationBanner';
import {
  EMAIL_VERIFICATION_DISMISSED_KEY,
  EMAIL_VERIFICATION_PERMANENT_DISMISS_KEY,
} from '@client/app/utils/onboarding';

// Router mock: useLocation is the reactive hook the component reads; useNavigate drives "Change email".
let mockPathname = '/chat';
const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: mockPathname }),
  useNavigate: () => mockNavigate,
}));

// UserContext mock
type MockUser = { email?: string; emailVerified?: boolean } | null;
let mockCurrentUser: MockUser = null;

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { currentUser: MockUser }) => unknown) => selector({ currentUser: mockCurrentUser }),
}));

// API / useMutation mock
const mockMutate = vi.fn();
let mutationCallbacks: {
  onSuccess?: () => void;
  onError?: (e: { response?: { status?: number; data?: { message?: string; isConfigError?: boolean } } }) => void;
} = {};

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: typeof mutationCallbacks) => {
    mutationCallbacks = opts;
    return { mutate: mockMutate, isPending: false };
  },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: vi.fn() },
}));

// localStorage mock
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

const TestWrapper = ({ children }: { children: React.ReactNode }) => <CssVarsProvider>{children}</CssVarsProvider>;

function renderBanner() {
  return render(
    <TestWrapper>
      <EmailVerificationBanner />
    </TestWrapper>
  );
}

describe('EmailVerificationBanner', () => {
  beforeEach(() => {
    localStorageMock.clear();
    mockCurrentUser = null;
    mockMutate.mockClear();
    mockNavigate.mockClear();
    mockPathname = '/chat';
  });

  it('renders for an unverified user with no prior dismissal', () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    renderBanner();
    expect(screen.getByTestId('email-verification-banner')).toBeInTheDocument();
    expect(screen.getByText(/test@example\.com/)).toBeInTheDocument();
  });

  it('does not render for a verified user', () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: true };
    renderBanner();
    expect(screen.queryByTestId('email-verification-banner')).not.toBeInTheDocument();
  });

  it('does not render when user is not loaded yet', () => {
    mockCurrentUser = null;
    renderBanner();
    expect(screen.queryByTestId('email-verification-banner')).not.toBeInTheDocument();
  });

  it.each(['/login', '/register', '/verify-email', '/verify-change'])('does not render on excluded route %s', route => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    mockPathname = route;
    renderBanner();
    expect(screen.queryByTestId('email-verification-banner')).not.toBeInTheDocument();
  });

  it('does not suppress banner on a route that merely starts with an excluded prefix', () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    mockPathname = '/verify-email-preferences';
    renderBanner();
    expect(screen.getByTestId('email-verification-banner')).toBeInTheDocument();
  });

  it('does not render when permanently dismissed', () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    localStorageMock.setItem(EMAIL_VERIFICATION_PERMANENT_DISMISS_KEY, '1');
    renderBanner();
    expect(screen.queryByTestId('email-verification-banner')).not.toBeInTheDocument();
  });

  it('does not render when timed-dismissed within 24h', () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    localStorageMock.setItem(EMAIL_VERIFICATION_DISMISSED_KEY, Date.now().toString());
    renderBanner();
    expect(screen.queryByTestId('email-verification-banner')).not.toBeInTheDocument();
  });

  it('shows banner again after 24h timed dismissal has expired', () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    const yesterday = Date.now() - 25 * 60 * 60 * 1000;
    localStorageMock.setItem(EMAIL_VERIFICATION_DISMISSED_KEY, yesterday.toString());
    renderBanner();
    expect(screen.getByTestId('email-verification-banner')).toBeInTheDocument();
  });

  it('"Remind me later" (×) sets the timed dismiss key and hides the banner', () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    renderBanner();
    fireEvent.click(screen.getByTestId('email-verification-banner-dismiss-btn'));
    expect(localStorageMock.getItem(EMAIL_VERIFICATION_DISMISSED_KEY)).not.toBeNull();
    expect(screen.queryByTestId('email-verification-banner')).not.toBeInTheDocument();
  });

  it('"Don\'t show again" sets the permanent dismiss key and hides the banner', () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    renderBanner();
    fireEvent.click(screen.getByTestId('email-verification-banner-dont-show-btn'));
    expect(localStorageMock.getItem(EMAIL_VERIFICATION_PERMANENT_DISMISS_KEY)).toBe('1');
    expect(screen.queryByTestId('email-verification-banner')).not.toBeInTheDocument();
  });

  it('"Resend" calls the mutation', () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    renderBanner();
    fireEvent.click(screen.getByTestId('email-verification-banner-resend-btn'));
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it('shows "Email Sent!" and starts cooldown only after successful resend', async () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    renderBanner();
    fireEvent.click(screen.getByTestId('email-verification-banner-resend-btn'));
    // Before success: no "Email Sent!" yet
    expect(screen.queryByText('Email Sent!')).not.toBeInTheDocument();
    await act(async () => {
      mutationCallbacks.onSuccess?.();
    });
    expect(screen.getByText('Email Sent!')).toBeInTheDocument();
  });

  it('does not start cooldown when resend fails', async () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    renderBanner();
    fireEvent.click(screen.getByTestId('email-verification-banner-resend-btn'));
    await act(async () => {
      mutationCallbacks.onError?.({ response: { status: 429 } });
    });
    // Button should still say "Resend" (no cooldown started), not "Resend in Xs"
    expect(screen.getByTestId('email-verification-banner-resend-btn')).toHaveTextContent('Resend');
  });

  it('shows rate-limit error Snackbar on 429', async () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    renderBanner();
    fireEvent.click(screen.getByTestId('email-verification-banner-resend-btn'));
    await act(async () => {
      mutationCallbacks.onError?.({ response: { status: 429 } });
    });
    expect(screen.getByTestId('email-verification-banner-error')).toBeInTheDocument();
    expect(screen.getByTestId('email-verification-banner-error')).toHaveTextContent('wait 15 minutes');
  });

  it('shows config-error Snackbar on 503 + isConfigError', async () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    renderBanner();
    fireEvent.click(screen.getByTestId('email-verification-banner-resend-btn'));
    await act(async () => {
      mutationCallbacks.onError?.({
        response: { status: 503, data: { message: 'Email service is not configured.', isConfigError: true } },
      });
    });
    expect(screen.getByTestId('email-verification-banner-error')).toHaveTextContent('not configured');
  });

  it('shows generic error Snackbar on unexpected failure', async () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    renderBanner();
    fireEvent.click(screen.getByTestId('email-verification-banner-resend-btn'));
    await act(async () => {
      mutationCallbacks.onError?.({});
    });
    expect(screen.getByTestId('email-verification-banner-error')).toHaveTextContent('Failed to send');
  });

  it('"Change email" navigates to /profile', () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    renderBanner();
    fireEvent.click(screen.getByTestId('email-verification-banner-change-email-btn'));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/profile' });
  });

  it('banner disappears when emailVerified becomes true (store update)', () => {
    mockCurrentUser = { email: 'test@example.com', emailVerified: false };
    const { rerender } = renderBanner();
    expect(screen.getByTestId('email-verification-banner')).toBeInTheDocument();

    mockCurrentUser = { email: 'test@example.com', emailVerified: true };
    rerender(
      <TestWrapper>
        <EmailVerificationBanner />
      </TestWrapper>
    );
    expect(screen.queryByTestId('email-verification-banner')).not.toBeInTheDocument();
  });
});
