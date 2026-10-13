import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.post = (fn: unknown) => fn;
    return chain;
  },
}));

const mockFindFile = vi.fn();
const mockFindSession = vi.fn();
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: (...a: unknown[]) => mockFindSession(...a) },
  fabFileRepository: { findById: (...a: unknown[]) => mockFindFile(...a) },
}));
vi.mock('@bike4mind/services', () => ({ notebookCurationService: {} }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ download: vi.fn().mockResolvedValue(Buffer.from('x')) }),
}));
const mockSend = vi.fn();
vi.mock('@server/utils/mailer/emailAttachments', () => ({
  sendEmailWithAttachments: (...a: unknown[]) => mockSend(...a),
}));

import handler from '../send';
import { MAX_EMAIL_MESSAGE_LENGTH, MAX_EMAIL_RECIPIENTS } from '../../../../types/api';

const run = async (body: Record<string, unknown>, name = 'Pat') => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, {
    user: { id: 'u1', name, email: 'pat@example.com' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  await (handler as unknown as (q: unknown, s: unknown) => Promise<void>)(req, res);
  return res;
};

describe('email send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFile.mockResolvedValue({
      userId: 'u1',
      fileName: 'a.txt',
      filePath: 'p',
      mimeType: 'text/plain',
      moderationStatus: 'clean',
    });
    mockSend.mockResolvedValue({ method: 'smtp', filesUploaded: 0 });
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
});
