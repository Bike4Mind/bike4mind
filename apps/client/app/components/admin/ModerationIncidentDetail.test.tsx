import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ModerationIncidentView } from '@client/app/hooks/data/moderationIncidents';

const m = vi.hoisted(() => ({
  view: vi.fn(),
  mutate: vi.fn(),
  reset: vi.fn(),
  refetch: vi.fn(),
  verdictState: { isPending: false, error: null as unknown },
}));
vi.mock('@client/app/hooks/data/moderationIncidents', () => ({
  useModerationIncidentView: m.view,
  useModerationIncidentVerdict: () => ({ mutate: m.mutate, reset: m.reset, ...m.verdictState }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
  surface: 'upload',
  reviewStatus: 'pending_review',
  provider: 'bfl',
  model: 'flux-pro-1.1',
  labels: [],
  alertedAt: null,
  lastReminderAt: null,
  reportedAt: null,
  ncmecReportId: null,
  reportChannel: null,
  falsePositiveAt: null,
  previousReviewStatus: null,
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

describe('ModerationIncidentDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.verdictState = { isPending: false, error: null };
    m.view.mockReturnValue(loaded(view()));
  });

  it('shows the image inline with no download control or referrer', () => {
    renderDetail();
    const image = screen.getByTestId('moderation-incident-image') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('https://signed.example/img');
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/download/i)).toBeNull();
    expect(screen.getByTestId('moderation-incident-meta').textContent).toContain('Upload');
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

  it('marks a false positive', () => {
    renderDetail();
    fireEvent.click(screen.getByTestId('moderation-incident-false-positive-btn'));
    fireEvent.click(screen.getByTestId('moderation-incident-false-positive-confirm-btn'));
    expect(m.mutate).toHaveBeenCalledWith(
      { id: 'inc-1', verdict: { kind: 'false_positive' } },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('requires a well-formed report id before confirming', () => {
    renderDetail();
    fireEvent.click(screen.getByTestId('moderation-incident-confirmed-btn'));
    const confirm = screen.getByTestId('moderation-incident-confirmed-confirm-btn') as HTMLButtonElement;
    const input = screen.getByTestId('moderation-incident-report-id-input');
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'bad id!' } });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: ' 12345-AB ' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(m.mutate).toHaveBeenCalledWith(
      { id: 'inc-1', verdict: { kind: 'confirmed', reportId: '12345-AB' } },
      expect.anything()
    );
  });

  it('lets a reviewer decide without an image: labels by confidence, model and alert time', () => {
    m.view.mockReturnValue(
      loaded(
        view({
          surface: 'generation',
          labels: [
            { name: 'Low one', parentName: '', confidence: 61.04 },
            { name: 'Explicit Nudity', parentName: 'Explicit', confidence: 97.31 },
          ],
          alertedAt: '2026-10-30T10:01:00.000Z',
          image: { availability: 'unavailable', reason: 'no_stored_image' },
        })
      )
    );
    renderDetail();
    expect(screen.getByTestId('moderation-incident-image-unavailable').textContent).toContain(
      'Decide from the detection and review details'
    );
    const labels = screen.getAllByTestId('moderation-incident-label').map(el => el.textContent);
    expect(labels).toEqual(['Explicit / Explicit Nudity - 97.3% confidence', 'Low one - 61.0% confidence']);
    expect(screen.getByTestId('moderation-incident-provider').textContent).toContain('bfl');
    expect(screen.getByTestId('moderation-incident-model').textContent).toContain('flux-pro-1.1');
    expect(screen.getByTestId('moderation-incident-alerted').textContent).toMatch(/Sent .*30 Oct 2026/);
  });

  it('says plainly when no labels were stored and no alert went out', () => {
    renderDetail();
    expect(screen.getByTestId('moderation-incident-no-labels')).toBeTruthy();
    expect(screen.getByTestId('moderation-incident-alerted').textContent).toContain('No alert delivered yet');
    expect(screen.queryByTestId('moderation-incident-reminded')).toBeNull();
    expect(screen.queryByTestId('moderation-incident-report-id')).toBeNull();
  });

  it('shows the prior verdict and report id once recorded', () => {
    m.view.mockReturnValue(
      loaded(
        view({
          reviewStatus: 'reported',
          reportedAt: '2026-10-31T09:00:00.000Z',
          reportChannel: 'manual',
          ncmecReportId: 'RPT-1',
          falsePositiveAt: '2026-10-30T12:00:00.000Z',
          previousReviewStatus: 'false_positive',
          lastReminderAt: '2026-10-31T08:00:00.000Z',
        })
      )
    );
    renderDetail();
    expect(screen.getByTestId('moderation-incident-report-id').textContent).toContain('RPT-1');
    expect(screen.getByTestId('moderation-incident-reported-at').textContent).toContain('filed on the web form');
    expect(screen.getByTestId('moderation-incident-false-positive-at')).toBeTruthy();
    expect(screen.getByTestId('moderation-incident-reminded')).toBeTruthy();
    expect(screen.getByTestId('moderation-incident-overrode')).toBeTruthy();
  });

  it('explains what each verdict does before the buttons', () => {
    renderDetail();
    const help = screen.getByTestId('moderation-incident-verdict-help').textContent ?? '';
    expect(help).toContain('Mark false positive:');
    expect(help).toContain('takes it out of the queue');
    expect(help).toContain('Record report:');
    expect(help).toContain('does not file a report for you');
  });

  it('disables both verdicts once the incident is not awaiting review', () => {
    m.view.mockReturnValue(loaded(view({ reviewStatus: 'confirmed_csam' })));
    renderDetail();
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
});
