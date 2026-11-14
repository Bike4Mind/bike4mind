import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  assertOutboundActionAllowed: async () => undefined,
}));
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.post = (...fns: unknown[]) => fns[fns.length - 1];
    return chain;
  },
}));

const mockFindFile = vi.fn();
const mockFindSession = vi.fn();
const mockFindOrganization = vi.fn();
const mockFindRecipient = vi.fn();
const mockDownload = vi.fn().mockResolvedValue(Buffer.from('x'));
const counters = new Map<string, { count: number; expiresAt: Date }>();
const mockTryAdd = vi.fn(async (key: string, amount: number, limit: number, ttlMs: number) => {
  const now = Date.now();
  const cur = counters.get(key);
  const live = cur && cur.expiresAt.getTime() > now ? cur : { count: 0, expiresAt: new Date(now + ttlMs) };
  if (live.count + amount > limit) return { success: false, count: live.count, expiresAt: live.expiresAt };
  live.count += amount;
  counters.set(key, live);
  return { success: true, count: live.count, expiresAt: live.expiresAt };
});
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: (...args: unknown[]) => mockFindOrganization(...args) },
  userRepository: { findOne: (...args: unknown[]) => mockFindRecipient(...args) },
  cacheRepository: { tryAddWithinLimitFixedWindow: (...a: [string, number, number, number]) => mockTryAdd(...a) },
  sessionRepository: { findById: (...a: unknown[]) => mockFindSession(...a) },
  fabFileRepository: { findById: (...a: unknown[]) => mockFindFile(...a) },
}));
vi.mock('@bike4mind/services', () => ({ notebookCurationService: {} }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ download: mockDownload }),
}));
const mockSend = vi.fn();
vi.mock('@server/utils/mailer/emailAttachments', () => ({
  sendEmailWithAttachments: (...a: unknown[]) => mockSend(...a),
}));

import handler from '../send';
import { MAX_EMAIL_MESSAGE_LENGTH, MAX_EMAIL_RECIPIENTS } from '../../../../types/api';

const run = async (body: Record<string, unknown>, name = 'Pat', userExtra: Record<string, unknown> = {}, id = 'u1') => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, {
    user: { id, name, email: 'pat@example.com', ...userExtra },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  await (handler as unknown as (q: unknown, s: unknown) => Promise<void>)(req, res);
  return res;
};

describe('email send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    counters.clear();
    mockFindOrganization.mockResolvedValue({
      userId: 'owner',
      users: [],
      sharingPolicy: {
        allowPublicLinks: false,
        allowExternalSharing: false,
        allowedDomains: ['partner.example'],
      },
    });
    mockFindRecipient.mockResolvedValue(null);
    mockDownload.mockResolvedValue(Buffer.from('x'));
    mockFindFile.mockResolvedValue({
      userId: 'u1',
      fileName: 'a.txt',
      filePath: 'p',
      mimeType: 'text/plain',
      moderationStatus: 'clean',
    });
    mockSend.mockResolvedValue({ method: 'smtp', filesUploaded: 0 });
  });

  it.each(['files', 'notebooks'] as const)('rejects outside %s recipients before any download or send', async type => {
    mockFindFile.mockResolvedValue({ userId: 'u1', fileName: 'a.md', filePath: 'p', organizationId: 'restricted' });
    mockFindSession.mockResolvedValue({ userId: 'u1', curatedNotebookFileId: 'c1', organizationId: 'restricted' });
    const body =
      type === 'files'
        ? { type, fileIds: ['f1'], recipients: ['outside@example.com'] }
        : { type, sessionIds: ['s1'], recipients: ['outside@example.com'], format: 'markdown' };
    const response = await run(body);
    expect(response._getStatusCode()).toBe(403);
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
  it('preflights every file and recipient before sending a mixed batch', async () => {
    mockFindFile.mockImplementation(async (id: string) => ({
      userId: 'u1',
      fileName: 'a.txt',
      filePath: 'p',
      ...(id === 'restricted' ? { organizationId: 'org' } : {}),
    }));
    mockFindRecipient
      .mockResolvedValueOnce({ id: 'member', email: 'member@example.com', emailVerified: true })
      .mockResolvedValueOnce(null);
    mockFindOrganization.mockResolvedValue({
      userId: 'member',
      users: [],
      sharingPolicy: {
        allowPublicLinks: false,
        allowExternalSharing: false,
        allowedDomains: [],
      },
    });
    const response = await run({
      type: 'files',
      fileIds: ['personal', 'restricted'],
      recipients: ['member@example.com', 'outside@example.com'],
    });
    expect(response._getStatusCode()).toBe(403);
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
  it.each([
    ['member', 'member@example.com', false, true],
    ['verified domain', 'person@partner.example', true, true],
    ['direct approved address', 'person@partner.example', false, true],
    ['subdomain', 'person@sub.partner.example', true, false],
    ['suffix', 'person@evilpartner.example', true, false],
  ] as const)('applies existing recipient policy to %s email', async (kind, email, verified, allowed) => {
    mockFindFile.mockResolvedValue({
      userId: 'u1',
      fileName: 'a.txt',
      filePath: 'p',
      moderationStatus: 'clean',
      organizationId: 'org',
    });
    mockFindRecipient.mockResolvedValue({ id: 'recipient', email, emailVerified: verified });
    mockFindOrganization.mockResolvedValue({
      userId: kind === 'member' ? 'recipient' : 'owner',
      users: [],
      sharingPolicy: { allowPublicLinks: false, allowExternalSharing: false, allowedDomains: ['partner.example'] },
    });
    const response = await run({ type: 'files', fileIds: ['f1'], recipients: [email] });
    expect(response._getStatusCode()).toBe(allowed ? 200 : 403);
    expect(mockDownload).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(mockSend).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });
  it('allows delivery to an approved-domain address without requiring an account', async () => {
    mockFindFile.mockResolvedValue({
      userId: 'u1',
      fileName: 'a.txt',
      filePath: 'p',
      moderationStatus: 'clean',
      organizationId: 'org',
    });
    mockFindRecipient.mockResolvedValue(null);
    const response = await run({ type: 'files', fileIds: ['f1'], recipients: ['new@partner.example'] });
    expect(response._getStatusCode()).toBe(200);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@partner.example' }), 'u1', 'Pat');
  });
  it('checks curated export binding even when its notebook is legacy unbound', async () => {
    mockFindSession.mockResolvedValue({ userId: 'u1', curatedNotebookFileId: 'c1' });
    mockFindFile.mockResolvedValue({ userId: 'u1', fileName: 'a.md', filePath: 'p', organizationId: 'restricted' });
    const response = await run({
      type: 'notebooks',
      sessionIds: ['s1'],
      recipients: ['outside@example.com'],
      format: 'markdown',
    });
    expect(response._getStatusCode()).toBe(403);
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('escapes html-special characters in file names', async () => {
    mockFindFile.mockResolvedValue({
      userId: 'u1',
      fileName: '<img src=x>.txt',
      filePath: 'p',
      mimeType: 'text/plain',
      moderationStatus: 'clean',
    });
    await run({ type: 'files', fileIds: ['f1'], recipients: ['a@example.com'] });
    const body: string = mockSend.mock.calls[0][0].body;
    expect(body).not.toContain('<img src=x>');
    expect(body).toContain('<li>&lt;img src=x&gt;.txt</li>');
  });

  it('escapes html-special characters in session names', async () => {
    mockFindSession.mockResolvedValue({ userId: 'u1', name: '<i>nb</i>', curatedNotebookFileId: 'c1' });
    await run({ type: 'notebooks', sessionIds: ['s1'], recipients: ['a@example.com'], format: 'markdown' });
    const body: string = mockSend.mock.calls[0][0].body;
    expect(body).not.toContain('<i>nb</i>');
    expect(body).toContain('<li>&lt;i&gt;nb&lt;/i&gt;</li>');
  });

  it('escapes html-special characters in sender name and message', async () => {
    await run(
      { type: 'files', fileIds: ['f1'], recipients: ['a@example.com'], message: '<b onclick="x">hi</b>\nline2' },
      '<script>alert(1)</script>'
    );
    const body: string = mockSend.mock.calls[0][0].body;
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).toContain('&lt;b onclick=&quot;x&quot;&gt;hi&lt;/b&gt;<br/>line2');
  });

  it('escapes html-special characters in sender name and message in notebook emails', async () => {
    mockFindSession.mockResolvedValue({ userId: 'u1', name: 'nb', curatedNotebookFileId: 'c1' });
    await run(
      {
        type: 'notebooks',
        sessionIds: ['s1'],
        recipients: ['a@example.com'],
        format: 'markdown',
        message: '<b>hi</b>\nbye',
      },
      '<script>x</script>'
    );
    const body: string = mockSend.mock.calls[0][0].body;
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('<b>hi</b>');
    expect(body).toContain('<p>&lt;script&gt;x&lt;/script&gt; has shared');
    expect(body).toContain('please contact &lt;script&gt;x&lt;/script&gt;.');
    expect(body).toContain('&lt;b&gt;hi&lt;/b&gt;<br/>bye');
  });

  it('accepts a message at the maximum length', async () => {
    const res = await run({
      type: 'files',
      fileIds: ['f1'],
      recipients: ['a@example.com'],
      message: 'a'.repeat(MAX_EMAIL_MESSAGE_LENGTH),
    });
    expect(res._getStatusCode()).toBe(200);
    expect(mockSend).toHaveBeenCalled();
  });

  it('rejects a message over the maximum length', async () => {
    const res = await run({
      type: 'files',
      fileIds: ['f1'],
      recipients: ['a@example.com'],
      message: 'a'.repeat(MAX_EMAIL_MESSAGE_LENGTH + 1),
    });
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().errors[0].field).toBe('message');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('accepts a recipient list at the maximum', async () => {
    const recipients = Array.from({ length: MAX_EMAIL_RECIPIENTS }, (_, i) => `u${i}@example.com`);
    const res = await run({ type: 'files', fileIds: ['f1'], recipients });
    expect(res._getStatusCode()).toBe(200);
    expect(mockSend).toHaveBeenCalled();
  });

  it('rejects recipient lists over the maximum', async () => {
    const recipients = Array.from({ length: MAX_EMAIL_RECIPIENTS + 1 }, (_, i) => `u${i}@example.com`);
    const res = await run({ type: 'files', fileIds: ['f1'], recipients });
    expect(res._getStatusCode()).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  describe('limits', () => {
    const one = { type: 'files', fileIds: ['f1'], recipients: ['a@example.com'] };
    const five = { ...one, recipients: Array.from({ length: 5 }, (_, i) => `u${i}@example.com`) };

    it('caps the recipient list at 5', () => {
      expect(MAX_EMAIL_RECIPIENTS).toBe(5);
    });

    it('answers 429 with Retry-After once the hourly budget is spent', async () => {
      for (let i = 0; i < 15; i++) expect((await run(one)).statusCode).toBe(200);
      mockSend.mockClear();
      const res = await run(one);
      expect(res.statusCode).toBe(429);
      const retryAfter = Number(res.getHeader('Retry-After'));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(3600);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('charges more for wider sends', async () => {
      for (let i = 0; i < 5; i++) expect((await run(five)).statusCode).toBe(200);
      expect((await run(five)).statusCode).toBe(429);
    });

    it('answers 429 on the daily budget after the hourly window rolls over', async () => {
      vi.useFakeTimers();
      try {
        for (let h = 0; h < 4; h++) {
          for (let i = 0; i < 15; i++) await run(one);
          vi.advanceTimersByTime(3600 * 1000 + 1);
        }
        const res = await run(one);
        expect(res.statusCode).toBe(429);
        expect(Number(res.getHeader('Retry-After'))).toBeGreaterThan(3600);
      } finally {
        vi.useRealTimers();
      }
    });

    it('counts each user separately', async () => {
      for (let i = 0; i < 15; i++) await run(one);
      expect((await run(one)).statusCode).toBe(429);
      mockFindFile.mockResolvedValue({
        userId: 'u2',
        fileName: 'a.txt',
        filePath: 'p',
        mimeType: 'text/plain',
        moderationStatus: 'clean',
      });
      expect((await run(one, 'Pat', {}, 'u2')).statusCode).toBe(200);
    });

    it('does not spend budget on an invalid body', async () => {
      await run({ ...one, recipients: [] });
      expect(mockTryAdd).not.toHaveBeenCalled();
    });

    it.each([
      ['moderated', { isModerated: true }],
      ['banned', { isBanned: true }],
    ])('refuses a %s account without sending', async (_label, extra) => {
      const res = await run(one, 'Pat', extra);
      expect(res.statusCode).toBe(403);
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockTryAdd).not.toHaveBeenCalled();
    });
  });
});
