import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const listAiAbuseAdvisories = vi.fn();
vi.mock('@bike4mind/server-utils/admin/aiAdvisory/aiAbuseAdvisories', () => ({
  listAiAbuseAdvisories: (...args: unknown[]) => listAiAbuseAdvisories(...args),
}));
const loadAbuseAssessmentSettings = vi.fn();
vi.mock('@bike4mind/server-utils/security/abuseAssessment/abuseAssessment', () => ({
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

  it('reports disabled assessment alongside the existing advisories', async () => {
    loadAbuseAssessmentSettings.mockResolvedValue({ enabled: false, config: { model: 'some-model' } });

    const result = await runTool();

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ status: 'off', reason: 'disabled' });
    expect(result.data.message).toContain('abuseAssessmentEnabled');
    expect(result.data.advisoryCount).toBe(2);
    expect(result.data.advisories).toHaveLength(2);
    expect(result.data.networks).toEqual([network(1)]);
    expect(result.data.mailDomains).toEqual([domain(1)]);
    expect(listAiAbuseAdvisories).toHaveBeenCalledOnce();
  });

  it('says advisories are off when no model is configured', async () => {
    loadAbuseAssessmentSettings.mockResolvedValue({ enabled: true, config: { model: null } });

    const result = await runTool();

    expect(result.data).toMatchObject({ status: 'off', reason: 'no_model' });
    expect(result.data.advisoryCount).toBe(2);
    expect(result.data.advisories).toHaveLength(2);
    expect(result.data.networks).toEqual([network(1)]);
    expect(result.data.mailDomains).toEqual([domain(1)]);
    expect(listAiAbuseAdvisories).toHaveBeenCalledOnce();
  });

  it('reports disabled, not no_model, when both are off', async () => {
    loadAbuseAssessmentSettings.mockResolvedValue({ enabled: false, config: { model: null } });

    expect((await runTool()).data).toMatchObject({ status: 'off', reason: 'disabled' });
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
      networksTruncated: false,
      mailDomainsTruncated: false,
      networks: [network(1)],
      mailDomains: [domain(1)],
    });
    expect(result.data.advisories).toEqual([
      {
        userId: 'u1',
        detectionId: 'd1',
        verdict: 'abuse',
        detector: 'signupBurst',
        abuseProbability: 0.9,
        assessedAt: '2026-11-09T10:00:00.000Z',
      },
      {
        userId: 'u2',
        detectionId: 'd2',
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
    expect(data.advisories[0].userId).toBe('u0');
    expect(data.advisories[24].userId).toBe('u24');
    expect(data.advisoriesTruncated).toBe(true);
    expect(data.advisoryCount).toBe(30);
    expect(data.networks).toHaveLength(10);
    expect(data.networks.map((n: { ip: string }) => n.ip)).toEqual(many(10, i => `10.0.0.${i}`));
    expect(data.networksTruncated).toBe(true);
    expect(data.mailDomains).toHaveLength(10);
    expect(data.mailDomains.map((d: { domain: string }) => d.domain)).toEqual(many(10, i => `d${i}.example`));
    expect(data.mailDomainsTruncated).toBe(true);
  });

  it('does not flag truncation when lists sit exactly at the caps', async () => {
    listAiAbuseAdvisories.mockResolvedValue(
      summary({ advisories: many(25, advisory), networks: many(10, network), mailDomains: many(10, domain) })
    );

    const { data } = await runTool();

    expect(data.advisories).toHaveLength(25);
    expect(data.networks).toHaveLength(10);
    expect(data.mailDomains).toHaveLength(10);
    expect(data).toMatchObject({
      advisoriesTruncated: false,
      networksTruncated: false,
      mailDomainsTruncated: false,
    });
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

  it('reports an empty off window without implying assessment is enabled', async () => {
    loadAbuseAssessmentSettings.mockResolvedValue({ enabled: false, config: { model: null } });
    listAiAbuseAdvisories.mockResolvedValue(summary({ advisories: [], networks: [], mailDomains: [] }));

    expect((await runTool()).data).toMatchObject({ status: 'off', advisoryCount: 0, advisories: [] });
  });

  it('returns a failed envelope when settings cannot be read', async () => {
    loadAbuseAssessmentSettings.mockRejectedValue(new Error('settings unavailable'));

    expect(await runTool()).toMatchObject({ ok: false, error: 'failed' });
    expect(listAiAbuseAdvisories).not.toHaveBeenCalled();
  });

  it('returns a failed envelope when existing advisories cannot be read while assessment is off', async () => {
    loadAbuseAssessmentSettings.mockResolvedValue({ enabled: false, config: { model: null } });
    listAiAbuseAdvisories.mockRejectedValue(new Error('db down'));

    expect(await runTool()).toMatchObject({ ok: false, error: 'failed' });
  });

  it('returns a failed envelope when the summary rejects', async () => {
    listAiAbuseAdvisories.mockRejectedValue(new Error('db down'));

    expect(await runTool()).toMatchObject({ ok: false, error: 'failed' });
  });
});
