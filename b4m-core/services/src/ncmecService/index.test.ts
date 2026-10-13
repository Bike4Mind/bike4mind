import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { submitNcmecReport } from './index';

// Rekognition stores confidence in the 0-100 range (not 0-1).
const BASE_INPUT = {
  incidentId: 'inc-123',
  userId: 'user-456',
  detectedAt: new Date('2026-01-15T10:00:00Z'),
  labels: [{ name: 'Explicit Nudity', confidence: 98.0 }],
};

describe('submitNcmecReport', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const savedEnv: Record<string, string | undefined> = {};
  const TRACKED = ['B4M_SELF_HOST', 'NCMEC_ESP_ID', 'NCMEC_API_KEY', 'NCMEC_USE_SANDBOX'] as const;

  beforeEach(() => {
    for (const k of TRACKED) savedEnv[k] = process.env[k];

    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    process.env.B4M_SELF_HOST = 'false';
    process.env.NCMEC_ESP_ID = 'esp-test-id';
    process.env.NCMEC_API_KEY = 'test-api-key';
    process.env.NCMEC_USE_SANDBOX = 'true';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of TRACKED) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const okResponse = (reportId = 'RPT-001') => ({
    ok: true,
    text: async () => `<response><reportId>${reportId}</reportId></response>`,
  });

  it('throws immediately on self-host installs', async () => {
    process.env.B4M_SELF_HOST = 'true';
    await expect(submitNcmecReport(BASE_INPUT)).rejects.toThrow('not available on self-host');
  });

  it('throws when NCMEC_ESP_ID is not-configured', async () => {
    process.env.NCMEC_ESP_ID = 'not-configured';
    await expect(submitNcmecReport(BASE_INPUT)).rejects.toThrow('NCMEC credentials not configured');
  });

  it('throws when NCMEC_API_KEY is not-configured', async () => {
    process.env.NCMEC_API_KEY = 'not-configured';
    await expect(submitNcmecReport(BASE_INPUT)).rejects.toThrow('NCMEC credentials not configured');
  });

  it('throws when NCMEC_ESP_ID is absent', async () => {
    delete process.env.NCMEC_ESP_ID;
    await expect(submitNcmecReport(BASE_INPUT)).rejects.toThrow('NCMEC credentials not configured');
  });

  it('POSTs to the sandbox URL when NCMEC_USE_SANDBOX=true', async () => {
    fetchSpy.mockResolvedValue(okResponse());
    await submitNcmecReport(BASE_INPUT);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('extapipre.cybertipline.org');
  });

  it('POSTs to the production URL when NCMEC_USE_SANDBOX is not true', async () => {
    process.env.NCMEC_USE_SANDBOX = 'false';
    fetchSpy.mockResolvedValue(okResponse('RPT-PROD'));
    await submitNcmecReport(BASE_INPUT);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('extapi.cybertipline.org');
    expect(url).not.toContain('extapipre');
  });

  it('sends Basic auth derived from espId and apiKey', async () => {
    fetchSpy.mockResolvedValue(okResponse());
    await submitNcmecReport(BASE_INPUT);

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const expected = `Basic ${Buffer.from('esp-test-id:test-api-key').toString('base64')}`;
    expect((opts.headers as Record<string, string>).Authorization).toBe(expected);
  });

  it('returns the reportId parsed from the XML response', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => '<response><reportId>  RPT-TRIM-ME  </reportId></response>',
    });
    const result = await submitNcmecReport(BASE_INPUT);
    expect(result.reportId).toBe('RPT-TRIM-ME');
  });

  it('throws when the response is not ok', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
    await expect(submitNcmecReport(BASE_INPUT)).rejects.toThrow('NCMEC API error 401');
  });

  it('throws when the response XML is missing reportId', async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => '<response><status>ok</status></response>' });
    await expect(submitNcmecReport(BASE_INPUT)).rejects.toThrow('NCMEC response missing reportId');
  });

  it('XML-escapes userId to prevent injection', async () => {
    fetchSpy.mockResolvedValue(okResponse('RPT-XSS'));
    await submitNcmecReport({ ...BASE_INPUT, userId: '<evil>&"' });

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const formData = opts.body as FormData;
    const blob = formData.get('report') as Blob;
    const xml = await blob.text();
    expect(xml).toContain('&lt;evil&gt;&amp;&quot;');
    expect(xml).not.toContain('<evil>');
  });

  it('includes fabFileId in the additionalInfo when provided', async () => {
    fetchSpy.mockResolvedValue(okResponse('RPT-FILE'));
    await submitNcmecReport({ ...BASE_INPUT, fabFileId: 'file-789' });

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const formData = opts.body as FormData;
    const blob = formData.get('report') as Blob;
    const xml = await blob.text();
    expect(xml).toContain('file-789');
  });

  it('formats confidence as a 0-100 value (not 0-1) in the report XML', async () => {
    fetchSpy.mockResolvedValue(okResponse('RPT-CONF'));
    await submitNcmecReport(BASE_INPUT); // BASE_INPUT has confidence: 98.0

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const formData = opts.body as FormData;
    const blob = formData.get('report') as Blob;
    const xml = await blob.text();
    expect(xml).toContain('98.0%');
    expect(xml).not.toContain('9800.0%');
  });
});
