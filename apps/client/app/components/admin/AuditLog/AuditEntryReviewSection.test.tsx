import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import type { AuditReview } from '@bike4mind/common';
import { AuditEntryReviewSection } from './AuditEntryReviewSection';
import { makeAuditEntry, makeAuditReview } from './shared/auditTestFixtures';

const mocks = vi.hoisted(() => ({
  currentUser: { id: 'me', isAdmin: true, adminPermissions: [] as string[] },
  review: null as unknown,
  isLoading: false,
  mark: vi.fn(),
  unmark: vi.fn(),
}));

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('@client/app/hooks/data/adminAuditLog', () => ({
  useAuditReview: () => ({ data: mocks.review, isLoading: mocks.isLoading }),
  useMarkAuditReviewed: () => ({ mutate: mocks.mark, isPending: false }),
  useUnmarkAuditReviewed: () => ({ mutate: mocks.unmark, isPending: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const entry = makeAuditEntry({ id: 'e1', severity: 'critical' });
const renderSection = (target = entry) => render(<AuditEntryReviewSection entry={target} />, { wrapper: TestWrapper });

describe('AuditEntryReviewSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = { id: 'me', isAdmin: true, adminPermissions: [] };
    mocks.review = null;
    mocks.isLoading = false;
  });

  afterEach(() => {
    useAccessToken.setState({ impersonating: false });
  });

  it('shows a skeleton while the review loads', () => {
    mocks.isLoading = true;
    renderSection();
    expect(screen.getByTestId('audit-review-loading')).toBeTruthy();
  });

  it('shows who reviewed it and the note, without Undo for another reviewer', () => {
    mocks.review = makeAuditReview({ note: 'Checked with finance' });
    renderSection();
    expect(screen.getByTestId('audit-review-reviewed').textContent).toContain('Reviewed by Rita Reviewer');
    expect(screen.getByTestId('audit-review-reviewed').textContent).toContain('Checked with finance');
    expect(screen.queryByTestId('audit-review-undo-btn')).toBeNull();
  });

  it('offers Undo review to the reviewer', () => {
    mocks.review = makeAuditReview({ reviewer: { userId: 'me', name: 'Me' } } as Partial<AuditReview>);
    renderSection();
    fireEvent.click(screen.getByTestId('audit-review-undo-btn'));
    expect(mocks.unmark).toHaveBeenCalledWith({ entryIds: ['e1'] });
  });

  it('words a rollout baseline as baselined, with no Undo', () => {
    mocks.review = makeAuditReview({ baseline: true, reviewer: { userId: null, name: 'Rollout' } });
    renderSection();
    expect(screen.getByTestId('audit-review-reviewed').textContent).toContain('Baselined at rollout');
    expect(screen.queryByTestId('audit-review-undo-btn')).toBeNull();
  });

  it('tells the actor another admin needs to review their own action', () => {
    renderSection(makeAuditEntry({ id: 'e1', severity: 'critical', actor: { ...entry.actor, userId: 'me' } }));
    expect(screen.getByTestId('audit-review-own-action').textContent).toBe(
      'You performed this action. Another admin needs to review it.'
    );
    expect(screen.queryByTestId('audit-review-mark-btn')).toBeNull();
  });

  it('tells the viewer another admin needs to review an entry about their own account', () => {
    renderSection(
      makeAuditEntry({
        id: 'e1',
        severity: 'critical',
        target: { kind: 'user', id: 'ME', displayName: 'Me' },
      })
    );
    expect(screen.getByTestId('audit-review-about-you').textContent).toBe(
      'This entry is about your account. Another admin needs to review it.'
    );
    expect(screen.queryByTestId('audit-review-own-action')).toBeNull();
    expect(screen.queryByTestId('audit-review-mark-btn')).toBeNull();
  });

  it('says only full admins can sign off when the viewer is not one', () => {
    mocks.currentUser = { id: 'me', isAdmin: false, adminPermissions: ['support:read'] };
    renderSection();
    expect(screen.getByTestId('audit-review-not-allowed').textContent).toBe(
      'Only full admins can sign off on critical entries.'
    );
    expect(screen.queryByTestId('audit-review-mark-btn')).toBeNull();
  });

  it('hides the review controls for a full admin who is impersonating', () => {
    useAccessToken.setState({ impersonating: true });
    renderSection();
    expect(screen.getByTestId('audit-review-not-allowed').textContent).toBe(
      'Stop impersonating to review audit entries.'
    );
    expect(screen.queryByTestId('audit-review-mark-btn')).toBeNull();
  });

  it('marks as reviewed with the trimmed note', () => {
    renderSection();
    fireEvent.change(screen.getByTestId('audit-review-note-input'), { target: { value: '  looks fine  ' } });
    fireEvent.click(screen.getByTestId('audit-review-mark-btn'));
    expect(mocks.mark).toHaveBeenCalledWith({ entryIds: ['e1'], note: 'looks fine' });
  });

  it('omits the note when it is blank', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('audit-review-mark-btn'));
    expect(mocks.mark).toHaveBeenCalledWith({ entryIds: ['e1'], note: undefined });
  });
});
