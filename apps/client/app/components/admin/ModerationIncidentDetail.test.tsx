import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ModerationIncidentView } from '@client/app/hooks/data/moderationIncidents';

const m = vi.hoisted(() => ({
  view: vi.fn(),
  mutateAsync: vi.fn(),
  reset: vi.fn(),
  escalate: vi.fn(),
  escalationReset: vi.fn(),
  refetch: vi.fn(),
  toastSuccess: vi.fn(),
  verdictState: { isPending: false, error: null as unknown },
  escalationState: { isPending: false, error: null as unknown },
}));
vi.mock('@client/app/hooks/data/moderationIncidents', () => ({
  useModerationIncidentView: m.view,
  useModerationIncidentVerdict: () => ({ mutateAsync: m.mutateAsync, reset: m.reset, ...m.verdictState }),
  useModerationIncidentEscalation: () => ({
    mutateAsync: m.escalate,
    reset: m.escalationReset,
    ...m.escalationState,
  }),
}));
vi.mock('sonner', () => ({ toast: { success: m.toastSuccess, error: vi.fn() } }));
// The real marker is a private symbol set by the api client's step-up interceptor.
vi.mock('@client/app/utils/stepUpInterceptor', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/utils/stepUpInterceptor')>()),
  isStepUpCancelled: (error: unknown) => (error as { stepUpCancelled?: boolean } | null)?.stepUpCancelled === true,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ params, children, ...rest }: { params: { userId: string }; children: React.ReactNode }) => (
    <a href={`/admin/users/${params.userId}`} {...rest}>
      {children}
    </a>
  ),
}));

import ModerationIncidentDetail from './ModerationIncidentDetail';

const appTheme = extendTheme({ ...getThemeConfig() });
const onBack = vi.fn();
const renderDetail = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ModerationIncidentDetail incidentId="inc-1" onBack={onBack} />
    </CssVarsProvider>
  );

const view = (over: Partial<ModerationIncidentView> = {}): ModerationIncidentView => ({
  id: 'inc-1',
  createdAt: '2026-10-30T10:00:00.000Z',
  surface: 'generation',
  reviewStatus: 'pending_review',
  previousReviewStatus: null,
  user: { id: 'user-1', email: 'flagged@example.com' },
  labels: [
    { name: 'Explicit', parentName: '', confidence: 91.25 },
    { name: 'Explicit Nudity', parentName: 'Explicit', confidence: 97.5 },
  ],
  provider: 'example-provider',
  model: 'example-model',
  sessionId: 'session-1',
  questId: 'quest-1',
  fabFileId: null,
  ncmecReportId: null,
  alertedAt: null,
  lastReminderAt: null,
  escalatedAt: null,
  escalationTrigger: null,
  escalationAlertedAt: null,
  reportedAt: null,
  falsePositiveAt: null,
  image: { availability: 'ready', url: 'https://signed.example/img', expiresAt: '2026-10-30T10:05:00.000Z' },
  ...over,
});
const loaded = (data: ModerationIncidentView) => ({
  data,
  isPending: false,
  isFetching: false,
  error: null,
  refetch: m.refetch,
});

// Synthetic records only; the escalation tests need no image at all.
const NO_IMAGE = { image: { availability: 'unavailable', reason: 'no_stored_image' } } as const;
const pickPreset = (dialogTestId: string) =>
  fireEvent.click(screen.getByTestId(`${dialogTestId}-reason-input-preset-0`));

describe('ModerationIncidentDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.verdictState = { isPending: false, error: null };
    m.escalationState = { isPending: false, error: null };
    m.mutateAsync.mockResolvedValue({ ok: true });
    m.view.mockReturnValue(loaded(view()));
  });

  it('shows the image inline with no download control or referrer', () => {
    renderDetail();
    const image = screen.getByTestId('moderation-incident-image') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('https://signed.example/img');
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    // The only link on the page is the flagged user's admin page, never the image.
    expect(screen.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/admin/users/user-1']);
    expect(screen.queryByText(/download/i)).toBeNull();
  });

  it('shows who and what was flagged', () => {
    renderDetail();
    const meta = screen.getByTestId('moderation-incident-meta').textContent ?? '';
    expect(screen.getByTestId('moderation-incident-surface').textContent).toBe('Generation');
    expect(screen.getByTestId('moderation-incident-provider').textContent).toBe('example-provider');
    expect(screen.getByTestId('moderation-incident-model').textContent).toBe('example-model');
    expect(meta).toContain('session-1');
    expect(meta).toContain('quest-1');

    const userLink = screen.getByTestId('moderation-incident-user-link');
    expect(userLink.textContent).toBe('flagged@example.com');
    expect(userLink.getAttribute('href')).toBe('/admin/users/user-1');
    expect(screen.getByTestId('moderation-incident-user-id').textContent).toBe('user-1');

    const nudity = screen.getByTestId('moderation-incident-label-1').textContent ?? '';
    expect(nudity).toContain('Explicit Nudity');
    expect(nudity).toContain('in Explicit');
    expect(nudity).toContain('97.5%');
    const topLevel = screen.getByTestId('moderation-incident-label-0').textContent ?? '';
    expect(topLevel).toContain('91.3%');
    expect(topLevel).not.toContain(' in ');
  });

  it('says the account is gone when the flagged user no longer exists, and that no labels were kept', () => {
    m.view.mockReturnValue(loaded(view({ user: { id: 'user-1', email: null }, labels: [] })));
    renderDetail();
    expect(screen.getByTestId('moderation-incident-user-link').textContent).toBe('Account no longer exists');
    expect(screen.getByTestId('moderation-incident-labels').textContent).toContain('No labels were recorded');
  });

  it('warns that the classifier is not a minor or CSAM detector', () => {
    renderDetail();
    const note = screen.getByTestId('moderation-incident-classifier-note').textContent ?? '';
    expect(note).toContain('does not detect minors or CSAM');
    expect(note).toContain('escalate it and file a report');
  });

  it('explains every verdict next to its button', () => {
    renderDetail();
    expect(screen.getByTestId('moderation-incident-no-action-help').textContent).toContain('nothing to report');
    expect(screen.getByTestId('moderation-incident-false-positive-help').textContent).toContain('was not explicit');
    const reportHelp = screen.getByTestId('moderation-incident-confirmed-help').textContent ?? '';
    expect(reportHelp).toContain('CyberTipline');
    expect(reportHelp).toContain('cannot be undone');
  });

  it('closes an incident as correctly blocked, with the reviewer reason, then goes back', async () => {
    renderDetail();
    fireEvent.click(screen.getByTestId('moderation-incident-no-action-btn'));
    const confirm = screen.getByTestId('moderation-incident-no-action-confirm-btn') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByTestId('moderation-incident-no-action-dialog-hint').textContent).toContain('Pick a reason');

    pickPreset('moderation-incident-no-action-dialog');
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(m.mutateAsync).toHaveBeenCalledWith({
        id: 'inc-1',
        verdict: { kind: 'no_action' },
        reason: 'Reviewed against the content policy',
      })
    );
    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(m.toastSuccess).toHaveBeenCalledWith('Closed as correctly blocked.', expect.anything());
  });

  it.each([
    ['no-action', 'moderation-incident-no-action-dialog'],
    ['false-positive', 'moderation-incident-false-positive-dialog'],
    ['confirmed', 'moderation-incident-confirmed-dialog'],
  ])('asks for a reason that does not describe the image in the %s dialog', (button, dialogTestId) => {
    renderDetail();
    fireEvent.click(screen.getByTestId(`moderation-incident-${button}-btn`));
    const dialog = screen.getByTestId(dialogTestId);
    expect(dialog.querySelector(`[data-testid="${dialogTestId}-reason-input"]`)).not.toBeNull();
    expect(screen.getByTestId('moderation-incident-reason-note').textContent).toBe(
      'The reason must not describe the image.'
    );
  });

  it('keeps the dialog open and shows a failed verdict', async () => {
    m.mutateAsync.mockRejectedValue(new Error('Incident is already no_action'));
    const { rerender } = renderDetail();
    fireEvent.click(screen.getByTestId('moderation-incident-no-action-btn'));
    pickPreset('moderation-incident-no-action-dialog');
    fireEvent.click(screen.getByTestId('moderation-incident-no-action-confirm-btn'));
    await waitFor(() => expect(m.mutateAsync).toHaveBeenCalled());

    m.verdictState = { isPending: false, error: new Error('Incident is already no_action') };
    rerender(
      <CssVarsProvider theme={appTheme}>
        <ModerationIncidentDetail incidentId="inc-1" onBack={onBack} />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('moderation-incident-verdict-error').textContent).toContain('already no_action');
    expect(screen.getByTestId('moderation-incident-no-action-dialog')).toBeTruthy();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('stays silent in the dialog when the reviewer dismissed the verification prompt', () => {
    m.verdictState = {
      isPending: false,
      error: Object.assign(new Error('Recent verification required'), { stepUpCancelled: true }),
    };
    m.escalationState = {
      isPending: false,
      error: Object.assign(new Error('Recent verification required'), { stepUpCancelled: true }),
    };
    m.view.mockReturnValue(loaded(view(NO_IMAGE)));
    renderDetail();
    fireEvent.click(screen.getByTestId('moderation-incident-no-action-btn'));
    expect(screen.queryByTestId('moderation-incident-verdict-error')).toBeNull();
    fireEvent.click(screen.getByTestId('moderation-incident-no-action-dialog-cancel-btn'));
    fireEvent.click(screen.getByTestId('moderation-incident-escalate-btn'));
    expect(screen.queryByTestId('moderation-incident-escalate-error')).toBeNull();
  });

  it('still lets a no_action verdict be overridden by a report, and nothing else', () => {
    m.view.mockReturnValue(loaded(view({ reviewStatus: 'no_action' })));
    renderDetail();
    expect((screen.getByTestId('moderation-incident-no-action-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('moderation-incident-false-positive-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('moderation-incident-confirmed-btn') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('moderation-incident-not-actionable').textContent).toContain('correctly blocked');
  });

  it('shows which verdict a recorded report overrode', () => {
    m.view.mockReturnValue(loaded(view({ reviewStatus: 'reported', previousReviewStatus: 'no_action' })));
    renderDetail();
    expect(screen.getByTestId('moderation-incident-meta').textContent).toContain('overrode No action');
  });

  it('says why there is no image instead of an empty frame', () => {
    m.view.mockReturnValue(loaded(view({ image: { availability: 'unavailable', reason: 'no_stored_image' } })));
    renderDetail();
    expect(screen.queryByTestId('moderation-incident-image')).toBeNull();
    expect(screen.getByTestId('moderation-incident-image-unavailable').textContent).toContain('No stored image');
  });

  it('offers a reload when the link has expired, and a fresh link clears the failure', () => {
    const { rerender } = renderDetail();
    fireEvent.error(screen.getByTestId('moderation-incident-image'));
    expect(screen.getByTestId('moderation-incident-image-failed')).toBeTruthy();
    fireEvent.click(screen.getByTestId('moderation-incident-reload-btn'));
    expect(m.refetch).toHaveBeenCalledTimes(1);

    // The refetch resolves with a new link; nothing else has to reset.
    m.view.mockReturnValue(
      loaded(
        view({
          image: { availability: 'ready', url: 'https://signed.example/img2', expiresAt: '2026-10-30T10:10:00.000Z' },
        })
      )
    );
    rerender(
      <CssVarsProvider theme={appTheme}>
        <ModerationIncidentDetail incidentId="inc-1" onBack={onBack} />
      </CssVarsProvider>
    );
    expect(screen.queryByTestId('moderation-incident-image-failed')).toBeNull();
    expect(screen.getByTestId('moderation-incident-image').getAttribute('src')).toBe('https://signed.example/img2');
  });

  it('still lets a recorded false positive be confirmed, matching the verdict route', () => {
    m.view.mockReturnValue(loaded(view({ reviewStatus: 'false_positive' })));
    renderDetail();
    expect((screen.getByTestId('moderation-incident-false-positive-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('moderation-incident-confirmed-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('marks a false positive with a typed reason', async () => {
    renderDetail();
    fireEvent.click(screen.getByTestId('moderation-incident-false-positive-btn'));
    fireEvent.change(screen.getByTestId('moderation-incident-false-positive-dialog-reason-input'), {
      target: { value: 'Classifier misread a drawing' },
    });
    fireEvent.click(screen.getByTestId('moderation-incident-false-positive-confirm-btn'));
    await waitFor(() =>
      expect(m.mutateAsync).toHaveBeenCalledWith({
        id: 'inc-1',
        verdict: { kind: 'false_positive' },
        reason: 'Classifier misread a drawing',
      })
    );
  });

  it('requires a well-formed report id and a reason before confirming', async () => {
    renderDetail();
    fireEvent.click(screen.getByTestId('moderation-incident-confirmed-btn'));
    const confirm = screen.getByTestId('moderation-incident-confirmed-confirm-btn') as HTMLButtonElement;
    const input = screen.getByTestId('moderation-incident-report-id-input');
    expect(confirm.disabled).toBe(true);

    pickPreset('moderation-incident-confirmed-dialog');
    expect(confirm.disabled).toBe(true);
    expect(screen.getByTestId('moderation-incident-confirmed-dialog-hint').textContent).toContain('report id');

    fireEvent.change(input, { target: { value: 'bad id!' } });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: ' 12345-AB ' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(m.mutateAsync).toHaveBeenCalledWith({
        id: 'inc-1',
        verdict: { kind: 'confirmed', reportId: '12345-AB' },
        reason: 'Report filed on the web form',
      })
    );
  });

  it('says no alert went out when none was delivered', () => {
    renderDetail();
    expect(screen.getByTestId('moderation-incident-alerted').textContent).toContain('No alert delivered yet');
    expect(screen.queryByTestId('moderation-incident-reminded')).toBeNull();
  });

  it('shows the alert time once one was delivered', () => {
    m.view.mockReturnValue(loaded(view({ alertedAt: '2026-10-30T10:01:00.000Z' })));
    renderDetail();
    expect(screen.getByTestId('moderation-incident-alerted').textContent).toMatch(/30 Oct 2026/);
  });

  it('shows when a reminder went out and when a verdict was recorded', () => {
    m.view.mockReturnValue(
      loaded(
        view({
          reviewStatus: 'reported',
          lastReminderAt: '2026-10-31T08:00:00.000Z',
          falsePositiveAt: '2026-10-30T12:00:00.000Z',
          reportedAt: '2026-10-31T09:00:00.000Z',
        })
      )
    );
    renderDetail();
    expect(screen.getByTestId('moderation-incident-reminded')).toBeTruthy();
    expect(screen.getByTestId('moderation-incident-false-positive-at')).toBeTruthy();
    expect(screen.getByTestId('moderation-incident-reported-at')).toBeTruthy();
  });

  it('disables every verdict once the incident is not awaiting review', () => {
    m.view.mockReturnValue(loaded(view({ reviewStatus: 'confirmed_csam' })));
    renderDetail();
    expect((screen.getByTestId('moderation-incident-no-action-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('moderation-incident-false-positive-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('moderation-incident-confirmed-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('moderation-incident-not-actionable')).toBeTruthy();
  });

  it('surfaces a load failure and still allows going back', () => {
    m.view.mockReturnValue({
      data: undefined,
      isPending: false,
      isFetching: false,
      error: new Error('Recent verification required'),
      refetch: m.refetch,
    });
    renderDetail();
    expect(screen.getByTestId('moderation-incident-error').textContent).toContain('Recent verification required');
    fireEvent.click(screen.getByTestId('moderation-incident-back-btn'));
    expect(onBack).toHaveBeenCalled();
  });
  describe('escalation', () => {
    const escalationResult = (alert: 'delivered' | 'no_recipients' | 'failed') => ({
      incident: {
        id: 'inc-1',
        reviewStatus: 'pending_review' as const,
        escalatedAt: '2026-10-30T12:00:00.000Z',
        escalationTrigger: 'manual' as const,
        escalationAlertedAt: alert === 'delivered' ? '2026-10-30T12:00:01.000Z' : null,
      },
      alert,
    });

    beforeEach(() => {
      m.view.mockReturnValue(loaded(view(NO_IMAGE)));
    });

    it('offers Escalate as a secondary action on a pending incident and says what it does', () => {
      renderDetail();
      expect(screen.getByTestId('moderation-incident-escalate-btn').textContent).toBe('Escalate to second reviewer');
      expect(screen.getByTestId('moderation-incident-escalate-help').textContent).toContain('second reviewer list');
      expect(screen.queryByTestId('moderation-incident-escalated-at')).toBeNull();
    });

    it.each([
      ['already escalated', { escalatedAt: '2026-10-30T12:00:00.000Z', escalationTrigger: 'manual' as const }],
      ['closed', { reviewStatus: 'no_action' as const }],
      ['stuck mid-report', { reviewStatus: 'confirmed_csam' as const }],
    ])('hides Escalate when the incident is %s', (_label, over) => {
      m.view.mockReturnValue(loaded(view({ ...NO_IMAGE, ...over })));
      renderDetail();
      expect(screen.queryByTestId('moderation-incident-escalate-btn')).toBeNull();
    });

    it.each([
      ['delivered', 'The second reviewers were emailed.'],
      ['no_recipients', 'no second reviewer is configured'],
      ['failed', 'did not send'],
    ] as const)('escalates with a reason and reports a %s email', async (alert, copy) => {
      m.escalate.mockResolvedValue(escalationResult(alert));
      renderDetail();
      fireEvent.click(screen.getByTestId('moderation-incident-escalate-btn'));
      expect(screen.getByTestId('moderation-incident-reason-note')).toBeTruthy();
      pickPreset('moderation-incident-escalate-dialog');
      fireEvent.click(screen.getByTestId('moderation-incident-escalate-dialog-confirm-btn'));

      await waitFor(() => expect(screen.getByTestId('moderation-incident-escalation-outcome')).toBeTruthy());
      expect(m.escalate).toHaveBeenCalledWith({ id: 'inc-1', reason: 'Needs a second opinion' });
      const outcome = screen.getByTestId('moderation-incident-escalation-outcome');
      expect(outcome.getAttribute('data-alert')).toBe(alert);
      expect(outcome.textContent).toContain(copy);
      expect(screen.queryByTestId('moderation-incident-escalate-dialog')).toBeNull();
      expect(screen.queryByTestId('moderation-incident-escalate-btn')).toBeNull();
      expect(screen.getByTestId('moderation-incident-escalation-trigger').textContent).toBe('Manual, by a reviewer');
      expect(screen.getByTestId('moderation-incident-escalation-alerted').textContent).toMatch(
        alert === 'delivered' ? /30 Oct 2026/ : /No escalation email delivered yet/
      );
      expect(onBack).not.toHaveBeenCalled();
    });

    it('names the setting to fill when no second reviewer is configured', async () => {
      m.escalate.mockResolvedValue(escalationResult('no_recipients'));
      renderDetail();
      fireEvent.click(screen.getByTestId('moderation-incident-escalate-btn'));
      pickPreset('moderation-incident-escalate-dialog');
      fireEvent.click(screen.getByTestId('moderation-incident-escalate-dialog-confirm-btn'));
      await waitFor(() =>
        expect(screen.getByTestId('moderation-incident-escalation-outcome').textContent).toContain(
          'Image Moderation Escalation Emails'
        )
      );
    });

    it('shows an automatic escalation and an email still owed', () => {
      m.view.mockReturnValue(
        loaded(
          view({
            ...NO_IMAGE,
            escalatedAt: '2026-10-31T10:00:00.000Z',
            escalationTrigger: 'timeout',
            escalationAlertedAt: null,
          })
        )
      );
      renderDetail();
      expect(screen.getByTestId('moderation-incident-escalated-at').textContent).toMatch(/31 Oct 2026/);
      expect(screen.getByTestId('moderation-incident-escalation-trigger').textContent).toBe(
        'Automatic, no verdict in time'
      );
      expect(screen.getByTestId('moderation-incident-escalation-alerted').textContent).toBe(
        'No escalation email delivered yet'
      );
    });

    it('shows a failed escalation in its dialog', () => {
      m.escalationState = { isPending: false, error: new Error('Incident is already escalated') };
      renderDetail();
      fireEvent.click(screen.getByTestId('moderation-incident-escalate-btn'));
      expect(screen.getByTestId('moderation-incident-escalate-error').textContent).toContain('already escalated');
    });
  });
});
