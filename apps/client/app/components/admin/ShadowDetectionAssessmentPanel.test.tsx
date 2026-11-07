// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AbuseAssessmentRow } from '@client/app/hooks/data/shadowDetections';
import type { AbuseAssessmentAccountProfile } from '@bike4mind/common';
import { ShadowDetectionAssessmentPanel, describeAccountProfile } from './ShadowDetectionAssessmentPanel';

const hooks = vi.hoisted(() => ({
  useAbuseAssessments: vi.fn(),
  useRequestAbuseAssessment: vi.fn(),
  currentUser: { adminPermissions: ['support:read', 'users:moderate'] } as { adminPermissions: string[] },
}));
vi.mock('@client/app/hooks/data/shadowDetections', () => hooks);
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: hooks.currentUser }) }));

const DETECTION_ID = 'a'.repeat(24);
const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ShadowDetectionAssessmentPanel detectionId={DETECTION_ID} enabled />
    </CssVarsProvider>
  );

const makeItem = (overrides: Partial<AbuseAssessmentRow> = {}): AbuseAssessmentRow =>
  ({
    id: 'one',
    detectionId: DETECTION_ID,
    result: 'abuse',
    probabilities: [
      { value: 'abuse', probability: 0.7 },
      { value: 'legitimate_automation', probability: 0.2 },
      { value: 'insufficient_evidence', probability: 0.1 },
    ],
    confidence: 0.7,
    reasons: [],
    model: 'jev',
    modelVersion: 'v1',
    policyVersion: 1,
    evidenceVersion: 1,
    evidenceHash: 'h',
    featureSummary: { accounts: [] },
    failure: null,
    attempts: 1,
    costUsd: 0,
    trigger: 'admin',
    requestedBy: null,
    assessedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as unknown as AbuseAssessmentRow;

const makeProfile = (overrides: Partial<AbuseAssessmentAccountProfile> = {}): AbuseAssessmentAccountProfile => ({
  signupMethod: 'otc',
  signupNetwork: { asnKnown: true, hosting: false, datacenter: false, anonymousIp: null, ja4Present: true },
  email: { plusAddressed: true, randomLookingPlusTag: true, generatedLocalPart: false, consumerMailDomain: true },
  minutesToTwoFactor: 4,
  minutesToFirstSpend: 1200,
  spend: { totalCredits: 1500, byModel: [{ model: null, creditShare: 0.5, events: 3, creditsPerEvent: 250 }] },
  linkedAccounts: {
    windowHours: 72,
    total: 5,
    blocked: 1,
    sharedSignupIp: 4,
    sharedJa4: 2,
    sharedMailbox: 0,
    sharedMailDomain: 0,
    truncated: true,
  },
  ...overrides,
});

const mutateAsync = vi.fn();

describe('ShadowDetectionAssessmentPanel', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    hooks.currentUser = { adminPermissions: ['support:read', 'users:moderate'] };
    hooks.useAbuseAssessments.mockReturnValue({ data: [makeItem()], isPending: false, error: null });
    hooks.useRequestAbuseAssessment.mockReturnValue({ mutateAsync, isPending: false, error: null });
  });

  it('renders the latest result and its probabilities', () => {
    renderPanel();
    expect(screen.getByTestId('shadow-detection-assessment-result').textContent).toContain('Abuse');
    const list = screen.getByTestId('shadow-detection-assessment-probabilities').textContent;
    expect(list).toContain('Abuse: 70%');
    expect(list).toContain('Legitimate automation: 20%');
    expect(screen.getByTestId('shadow-detection-assessment-confidence').textContent).toContain('70%');
  });

  it('lists the model reasons in fixed wording beside the label', () => {
    hooks.useAbuseAssessments.mockReturnValue({
      data: [
        makeItem({
          reasons: [
            { key: 'anonymizedNetwork', probability: 0.91 },
            { key: 'rushedOnboarding', probability: 0.8 },
          ],
        }),
      ],
      isPending: false,
      error: null,
    });
    renderPanel();
    const reasons = screen.getAllByTestId('abuse-assessment-reason').map(node => node.textContent);
    expect(reasons).toEqual([
      'Signed up through a VPN, proxy or hosting network (91%)',
      'Two-factor or spending started within minutes of signup (80%)',
    ]);
  });

  it('shows no reasons block for an assessment without reasons', () => {
    renderPanel();
    expect(screen.queryByTestId('abuse-assessment-reasons')).toBeNull();
  });

  it('renders unknown with its failure in plain words', () => {
    hooks.useAbuseAssessments.mockReturnValue({
      data: [makeItem({ result: 'unknown', probabilities: [], confidence: null, failure: 'provider_overloaded' })],
      isPending: false,
      error: null,
    });
    renderPanel();
    expect(screen.getByTestId('shadow-detection-assessment-result').textContent).toContain('Unknown');
    expect(screen.getByTestId('shadow-detection-assessment-failure').textContent).toContain('overloaded');
  });

  it('requests an assessment when Assess now is clicked', async () => {
    mutateAsync.mockResolvedValue({ status: 'assessed', cached: true, item: makeItem() });
    renderPanel();
    fireEvent.click(screen.getByTestId('shadow-detection-assess-btn'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(DETECTION_ID));
    expect((await screen.findByTestId('shadow-detection-assessment-outcome')).textContent).toContain('reused');
  });

  it('hides Assess now from a support-only admin', () => {
    hooks.currentUser = { adminPermissions: ['support:read'] };
    renderPanel();
    expect(screen.getByTestId('shadow-detection-assessment-result')).toBeTruthy();
    expect(screen.queryByTestId('shadow-detection-assess-btn')).toBeNull();
  });

  it('shows the reason when the assessment is skipped', async () => {
    mutateAsync.mockResolvedValue({ status: 'skipped', reason: 'disabled' });
    renderPanel();
    fireEvent.click(screen.getByTestId('shadow-detection-assess-btn'));
    expect((await screen.findByTestId('shadow-detection-assessment-outcome')).textContent).toContain(
      'off in admin settings'
    );
  });

  it('shows each account profile above the raw evidence', () => {
    hooks.useAbuseAssessments.mockReturnValue({
      data: [
        makeItem({ evidenceVersion: 2, featureSummary: { accounts: [{ ref: 'acct_1', profile: makeProfile() }] } }),
      ],
      isPending: false,
      error: null,
    });
    renderPanel();
    const text = screen.getByTestId('shadow-detection-assessment-profiles').textContent;
    expect(text).toContain('acct_1');
    expect(text).toContain('Linked within 72h: 5+');
  });

  it('renders no profiles for a v1 summary or a profile that does not parse', () => {
    hooks.useAbuseAssessments.mockReturnValue({
      data: [makeItem({ featureSummary: { accounts: [{ ref: 'acct_1' }, { ref: 'acct_2', profile: { x: 1 } }] } })],
      isPending: false,
      error: null,
    });
    renderPanel();
    expect(screen.queryByTestId('shadow-detection-assessment-profiles')).toBeNull();
  });
});

describe('describeAccountProfile', () => {
  it('words the signup, email, timing, spend and link facts', () => {
    expect(describeAccountProfile(makeProfile())).toEqual([
      'Signup: email code; hosting/VPN network no, anonymous IP unknown, JA4 present',
      'Email: plus-addressed, random-looking tag, webmail domain',
      'Two-factor: 4 min after signup',
      'First spend: 1,200 min after signup',
      'Spend: 1,500 credits - no model 50% (250/call)',
      'Linked within 72h: 5+ (1 blocked; signup IP 4, JA4 2, mailbox 0, mail domain 0)',
    ]);
  });

  it('omits facts the profile does not have', () => {
    const lines = describeAccountProfile(
      makeProfile({
        signupMethod: 'oauth',
        email: null,
        minutesToTwoFactor: null,
        minutesToFirstSpend: null,
        spend: null,
        linkedAccounts: null,
      })
    );
    expect(lines).toEqual(['Signup: oauth; hosting/VPN network no, anonymous IP unknown, JA4 present']);
  });
});
