import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const listAiAbuseAdvisories = vi.fn();
vi.mock('@server/admin/aiAdvisory/aiAbuseAdvisories', () => ({
  listAiAbuseAdvisories: (...args: unknown[]) => listAiAbuseAdvisories(...args),
}));
const loadAbuseAssessmentSettings = vi.fn();
vi.mock('@server/security/abuseAssessment/abuseAssessment', () => ({
  loadAbuseAssessmentSettings: (...args: unknown[]) => loadAbuseAssessmentSettings(...args),
}));

import { getAiAdvisoriesTool } from './getAiAdvisories';

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const contextFor = (isAdmin: boolean) =>
  ({ user: { isAdmin }, userId: 'admin-1', logger }) as unknown as Omit<ToolContext, 'config'>;

const runTool = async (isAdmin = true) =>
  JSON.parse(await getAiAdvisoriesTool.implementation(contextFor(isAdmin), undefined).toolFn({}));

const advisory = (i: number) => ({
  userId: `u${i}`,
  detectionId: `d${i}`,
  detector: 'signupBurst',
  abuseProbability: 0.9,
  assessedAt: new Date('2026-11-09T10:00:00.000Z'),
});
const network = (i: number) => ({
  ip: `10.0.0.${i}`,
  country: 'US',
  asnOrg: 'Host',
  hosting: true,
  accountCount: 2,
  detectorWouldBlock: false,
});
const domain = (i: number) => ({ domain: `d${i}.example`, accountCount: 3 });
const summary = (overrides: Record<string, unknown> = {}) => ({
  since: new Date('2026-11-08T10:00:00.000Z'),
  advisories: [advisory(1), advisory(2)],
  networks: [network(1)],
  mailDomains: [domain(1)],
  truncated: false,
  ...overrides,
});
const many = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));

describe('getAiAdvisoriesTool', () => {
  beforeEach(() => {
    listAiAbuseAdvisories.mockReset().mockResolvedValue(summary());
    loadAbuseAssessmentSettings.mockReset().mockResolvedValue({ enabled: true, config: { model: 'some-model' } });
  });

  it('says advisories are off when the feature is disabled, without reading them', async () => {
    loadAbuseAssessmentSettings.mockResolvedValue({ enabled: false, config: { model: 'some-model' } });

    const result = await runTool();

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ status: 'off', reason: 'disabled' });
    expect(result.data.message).toContain('abuseAssessmentEnabled');
    expect(result.data).not.toHaveProperty('advisories');
    expect(listAiAbuseAdvisories).not.toHaveBeenCalled();
  });

  it('says advisories are off when no model is configured', async () => {
    loadAbuseAssessmentSettings.mockResolvedValue({ enabled: true, config: { model: null } });

    const result = await runTool();

    expect(result.data).toMatchObject({ status: 'off', reason: 'no_model' });
    expect(listAiAbuseAdvisories).not.toHaveBeenCalled();
  });

  it('maps the summary to picked fields in order', async () => {
    const result = await runTool();

    expect(result.data).toMatchObject({
      status: 'on',
      since: '2026-11-08T10:00:00.000Z',
      windowHours: 24,
      advisoryCount: 2,
      countIsLowerBound: false,
      advisoriesTruncated: false,
      networks: [network(1)],
      mailDomains: [domain(1)],
    });
    expect(result.data.advisories).toEqual([
      {
        userId: 'u1',
        verdict: 'abuse',
        detector: 'signupBurst',
        abuseProbability: 0.9,
        assessedAt: '2026-11-09T10:00:00.000Z',
      },
      {
        userId: 'u2',
        verdict: 'abuse',
        detector: 'signupBurst',
        abuseProbability: 0.9,
        assessedAt: '2026-11-09T10:00:00.000Z',
      },
    ]);
  });

  it('caps advisories, networks and mail domains but keeps the full advisory count', async () => {
    listAiAbuseAdvisories.mockResolvedValue(
      summary({
        advisories: many(30, advisory),
        networks: many(12, network),
        mailDomains: many(12, domain),
      })
    );

    const { data } = await runTool();

    expect(data.advisories).toHaveLength(25);
    expect(data.advisoriesTruncated).toBe(true);
    expect(data.advisoryCount).toBe(30);
    expect(data.networks).toHaveLength(10);
    expect(data.networksTruncated).toBe(true);
    expect(data.mailDomains).toHaveLength(10);
    expect(data.mailDomainsTruncated).toBe(true);
  });

  it('flags a lower-bound count when the summary was truncated', async () => {
    listAiAbuseAdvisories.mockResolvedValue(summary({ truncated: true }));

    expect((await runTool()).data.countIsLowerBound).toBe(true);
  });

  it('reports an empty list as on, distinct from off', async () => {
    listAiAbuseAdvisories.mockResolvedValue(summary({ advisories: [], networks: [], mailDomains: [] }));

    expect((await runTool()).data).toMatchObject({ status: 'on', advisoryCount: 0, advisories: [] });
  });

  it('refuses a non-admin without touching either source', async () => {
    const result = await runTool(false);

    expect(result).toMatchObject({ ok: false, error: 'forbidden' });
    expect(loadAbuseAssessmentSettings).not.toHaveBeenCalled();
    expect(listAiAbuseAdvisories).not.toHaveBeenCalled();
  });

  it('returns a failed envelope when the summary rejects', async () => {
    listAiAbuseAdvisories.mockRejectedValue(new Error('db down'));

    expect(await runTool()).toMatchObject({ ok: false, error: 'failed' });
  });
});
