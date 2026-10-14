import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { submitNcmecReport, finishNcmecReport, NcmecRejectedError, NcmecFinishFailedError } from './index';

const TEST_CREDS = {
  espId: 'esp-test-id',
  apiKey: 'test-api-key',
  espEmail: 'esp-contact@example.com',
  useSandbox: true,
};

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
  const TRACKED = ['B4M_SELF_HOST'] as const;

  beforeEach(() => {
    for (const k of TRACKED) savedEnv[k] = process.env[k];
    process.env.B4M_SELF_HOST = 'false';

    // Return success for both /submit and /finish by default.
    fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<response><reportId>RPT-001</reportId></response>',
      })
      .mockResolvedValueOnce({ ok: true, text: async () => '<finishResponse><status>ok</status></finishResponse>' });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of TRACKED) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('throws immediately on self-host installs', async () => {
    process.env.B4M_SELF_HOST = 'true';
    await expect(submitNcmecReport(TEST_CREDS, BASE_INPUT)).rejects.toThrow('not available on self-host');
  });

  it('throws when espId is not-configured', async () => {
    await expect(submitNcmecReport({ ...TEST_CREDS, espId: 'not-configured' }, BASE_INPUT)).rejects.toThrow(
      'NCMEC credentials not configured'
    );
  });

  it('throws when apiKey is not-configured', async () => {
    await expect(submitNcmecReport({ ...TEST_CREDS, apiKey: 'not-configured' }, BASE_INPUT)).rejects.toThrow(
      'NCMEC credentials not configured'
    );
  });

  it('throws when espId is empty', async () => {
    await expect(submitNcmecReport({ ...TEST_CREDS, espId: '' }, BASE_INPUT)).rejects.toThrow(
      'NCMEC credentials not configured'
    );
  });

  it('POSTs /submit to the test host when useSandbox=true', async () => {
    await submitNcmecReport(TEST_CREDS, BASE_INPUT);
    const [submitUrl] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(submitUrl).toContain('exttest.cybertip.org');
    expect(submitUrl).toContain('/submit');
  });

  it('POSTs /submit to the production host only when useSandbox=false (explicit)', async () => {
    await submitNcmecReport({ ...TEST_CREDS, useSandbox: false }, BASE_INPUT);
    const [submitUrl] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(submitUrl).toContain('report.cybertip.org');
    expect(submitUrl).not.toContain('exttest');
  });

  it('sends Content-Type text/xml and Basic auth on /submit', async () => {
    await submitNcmecReport(TEST_CREDS, BASE_INPUT);
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('text/xml; charset=utf-8');
    const expected = `Basic ${Buffer.from('esp-test-id:test-api-key').toString('base64')}`;
    expect(headers.Authorization).toBe(expected);
  });

  it('calls /finish with the reportId as a form parameter (application/x-www-form-urlencoded)', async () => {
    await submitNcmecReport(TEST_CREDS, BASE_INPUT);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [finishUrl, finishOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(finishUrl).toContain('/finish');
    expect((finishOpts.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(finishOpts.body as string).toBe('id=RPT-001');
  });

  it('returns the reportId from /submit after /finish succeeds', async () => {
    const result = await submitNcmecReport(TEST_CREDS, BASE_INPUT);
    expect(result.reportId).toBe('RPT-001');
  });

  it('trims whitespace from the parsed reportId', async () => {
    fetchSpy
      .mockReset()
      .mockResolvedValueOnce({ ok: true, text: async () => '<response><reportId>  RPT-TRIM  </reportId></response>' })
      .mockResolvedValueOnce({ ok: true, text: async () => '' });
    const result = await submitNcmecReport(TEST_CREDS, BASE_INPUT);
    expect(result.reportId).toBe('RPT-TRIM');
  });

  it('throws NcmecRejectedError when /submit returns a 4xx status', async () => {
    fetchSpy.mockReset().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
    const err = await submitNcmecReport(TEST_CREDS, BASE_INPUT).catch(e => e);
    expect(err).toBeInstanceOf(NcmecRejectedError);
    expect(err.message).toContain('NCMEC /submit error 401');
  });

  it('throws plain Error (not NcmecRejectedError) when /submit returns a 5xx status', async () => {
    fetchSpy.mockReset().mockResolvedValue({ ok: false, status: 503, text: async () => 'Service Unavailable' });
    const err = await submitNcmecReport(TEST_CREDS, BASE_INPUT).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NcmecRejectedError);
    expect(err.message).toContain('NCMEC /submit error 503');
  });

  it('throws plain Error (not NcmecRejectedError) when /submit response XML is missing reportId', async () => {
    fetchSpy
      .mockReset()
      .mockResolvedValueOnce({ ok: true, text: async () => '<response><status>ok</status></response>' });
    const err = await submitNcmecReport(TEST_CREDS, BASE_INPUT).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NcmecRejectedError);
    expect(err.message).toContain('NCMEC /submit response missing reportId');
  });

  it('throws NcmecFinishFailedError (not NcmecRejectedError) when /finish returns a non-2xx status', async () => {
    fetchSpy
      .mockReset()
      .mockResolvedValueOnce({ ok: true, text: async () => '<response><reportId>RPT-FAIL</reportId></response>' })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal Error' });
    const err = await submitNcmecReport(TEST_CREDS, BASE_INPUT).catch(e => e);
    expect(err).toBeInstanceOf(NcmecFinishFailedError);
    expect(err).not.toBeInstanceOf(NcmecRejectedError);
    expect(err.message).toContain('NCMEC /finish error 500');
    // reportId is on the error so callers can persist it for manual recovery.
    expect(err.reportId).toBe('RPT-FAIL');
  });

  it('throws NcmecFinishFailedError carrying the reportId when the /finish fetch rejects (timeout)', async () => {
    fetchSpy
      .mockReset()
      .mockResolvedValueOnce({ ok: true, text: async () => '<response><reportId>RPT-77</reportId></response>' })
      .mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const err = await submitNcmecReport(TEST_CREDS, BASE_INPUT).catch(e => e);
    expect(err).toBeInstanceOf(NcmecFinishFailedError);
    expect(err.reportId).toBe('RPT-77');
    expect(err.message).toContain('TimeoutError');
  });

  it('XML-escapes userId in the report body', async () => {
    await submitNcmecReport(TEST_CREDS, { ...BASE_INPUT, userId: '<evil>&"' });
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const xml = opts.body as string;
    expect(xml).toContain('&lt;evil&gt;&amp;&quot;');
    expect(xml).not.toContain('<evil>');
  });

  it('formats confidence as a 0-100 value (not 0-1) in the report XML', async () => {
    await submitNcmecReport(TEST_CREDS, BASE_INPUT); // BASE_INPUT has confidence: 98.0
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const xml = opts.body as string;
    expect(xml).toContain('98.0%');
    expect(xml).not.toContain('9800.0%');
  });

  it('includes fabFileId in the additionalInfo when provided', async () => {
    await submitNcmecReport(TEST_CREDS, { ...BASE_INPUT, fabFileId: 'file-789' });
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const xml = opts.body as string;
    expect(xml).toContain('file-789');
  });

  it('gives /submit and /finish independent 25s timeouts (separate AbortSignal objects)', async () => {
    // Both calls succeed; verify that two distinct fetch calls were made.
    await submitNcmecReport(TEST_CREDS, BASE_INPUT);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const submitSignal = (fetchSpy.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    const finishSignal = (fetchSpy.mock.calls[1][1] as RequestInit).signal as AbortSignal;
    // Distinct signal objects: a slow /submit cannot starve /finish of its budget.
    expect(submitSignal).not.toBe(finishSignal);
  });

  it('uses <report> as the root element, <reportingPerson>/<email> for the ESP, and <espIdentifier> for the suspect', async () => {
    await submitNcmecReport(TEST_CREDS, BASE_INPUT);
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const xml = opts.body as string;
    expect(xml).toMatch(/<report>/);
    expect(xml).toContain('<personOrUserReported>');
    expect(xml).toContain('<espIdentifier>');
    expect(xml).not.toContain('<espUserId>');
    expect(xml).toContain('<reportingPerson>');
    expect(xml).toContain('<email>esp-contact@example.com</email>');
    expect(xml).not.toContain('<reportingEsp>');
    expect(xml).not.toContain('<cybertiplineReport>');
  });
});

describe('finishNcmecReport', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const savedEnv: Record<string, string | undefined> = {};
  const TRACKED = ['B4M_SELF_HOST'] as const;

  beforeEach(() => {
    for (const k of TRACKED) savedEnv[k] = process.env[k];
    process.env.B4M_SELF_HOST = 'false';
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of TRACKED) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('POSTs to /finish with the reportId as a form parameter', async () => {
    await finishNcmecReport(TEST_CREDS, 'RPT-RETRY-001');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/finish');
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(opts.body as string).toBe('id=RPT-RETRY-001');
  });

  it('throws NcmecFinishFailedError on non-2xx', async () => {
    fetchSpy.mockReset().mockResolvedValue({ ok: false, status: 500, text: async () => 'Internal Error' });
    const err = await finishNcmecReport(TEST_CREDS, 'RPT-RETRY-002').catch(e => e);
    expect(err).toBeInstanceOf(NcmecFinishFailedError);
    expect(err.reportId).toBe('RPT-RETRY-002');
  });
});
