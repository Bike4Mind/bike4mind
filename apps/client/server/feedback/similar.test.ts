import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackStatus } from '@bike4mind/common';

const db = vi.hoisted(() => ({ findById: vi.fn(), find: vi.fn(), textOne: vi.fn(), textFind: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  FeedbackModel: { findById: db.findById, find: db.find },
  FeedbackTextModel: { findOne: db.textOne, find: db.textFind },
}));
import { feedbackTextSimilarity, getSimilarFeedback, SIMILAR_FEEDBACK_SCAN_LIMIT } from './similar';

const now = new Date('2026-11-13T00:00:00Z');
const id = '507f1f77bcf86cd799439011';
const content = 'The chat response stops streaming after I attach a file.';
const report = (reportId = id, status = FeedbackStatus.New) => ({
  _id: reportId,
  id: reportId,
  userId: 'reporter',
  type: 'Bug',
  status,
  contentStored: true,
  createdAt: now,
});
const audit = vi.fn();
const canRead = vi.fn((_item: { id: string }) => true);
let chain: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  db.findById.mockResolvedValue(report());
  db.textOne.mockReturnValue({ lean: vi.fn().mockResolvedValue({ content }) });
  db.textFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
  chain = Object.fromEntries(['select', 'sort', 'limit', 'hint'].map(key => [key, vi.fn(() => chain)]));
  chain.maxTimeMS = vi.fn().mockResolvedValue([]);
  db.find.mockReturnValue(chain);
  audit.mockResolvedValue(undefined);
  canRead.mockReturnValue(true);
});

describe('feedbackTextSimilarity', () => {
  it('matches near-identical text without AI and ignores case/punctuation', () => {
    expect(feedbackTextSimilarity(content, 'The chat response stops streaming after I attach a file!')).toBe(1);
    expect(
      feedbackTextSimilarity(content, 'The chat response stops streaming after I attach my file.')
    ).toBeGreaterThan(0.8);
    expect(feedbackTextSimilarity(content, 'Please add a light theme to settings')).toBeLessThan(0.8);
  });
  it('does not match empty or unrelated short reports', () => {
    expect(feedbackTextSimilarity('', '')).toBe(0);
    expect(feedbackTextSimilarity('yes', 'yesterday')).toBe(0);
    expect(feedbackTextSimilarity('broken', 'BROKEN!')).toBe(1);
  });
});

describe('getSimilarFeedback', () => {
  it('returns near-identical text, open before closed, with bounded same-type/14-day queries and read audit', async () => {
    const closed = report('507f1f77bcf86cd799439012', FeedbackStatus.Closed);
    const open = report('507f1f77bcf86cd799439013');
    chain.maxTimeMS.mockResolvedValue([closed, open]);
    db.textFind.mockReturnValue({
      lean: vi.fn().mockResolvedValue([
        { _id: closed.id, content },
        { _id: open.id, content: content.replace('a file', 'my file') },
      ]),
    });
    const result = await getSimilarFeedback(id, { canRead, audit, now });
    expect(result.items.map(item => item.id)).toEqual([open.id, closed.id]);
    expect(result.items[0].excerpt).toContain('my file');
    expect(db.find).toHaveBeenCalledWith({
      _id: { $ne: id },
      type: 'Bug',
      status: { $in: ['New', 'InProgress', 'Closed'] },
      createdAt: { $gte: new Date('2026-10-30T00:00:00Z'), $lte: now },
    });
    expect(chain.limit).toHaveBeenCalledWith(501);
    expect(chain.maxTimeMS).toHaveBeenCalledWith(2000);
    expect(db.textFind.mock.calls[0][0].expiresAt).toEqual({ $gt: now });
    expect(audit).toHaveBeenCalledWith([report(), open, closed].map(item => ({ id: item.id, userId: item.userId })));
  });

  it('does not match expired text or fall back to a stored sibling copy', async () => {
    db.textOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    db.findById.mockResolvedValue({ ...report(), content });
    expect(await getSimilarFeedback(id, { canRead, audit, now })).toEqual({ items: [], limited: false });
    expect(db.find).not.toHaveBeenCalled();
  });

  it('supports recent legacy text without resurrecting old text', async () => {
    db.textOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    db.findById.mockResolvedValue({ ...report(), contentStored: false, content });
    await getSimilarFeedback(id, { canRead, audit, now });
    expect(db.find).toHaveBeenCalledOnce();
    db.find.mockClear();
    db.findById.mockResolvedValue({ ...report(), contentStored: false, content, createdAt: new Date('2020-01-01') });
    await getSimilarFeedback(id, { canRead, audit, now });
    expect(db.find).not.toHaveBeenCalled();
  });

  it('rejects unauthorized/invalid sources and never returns denied candidates', async () => {
    await expect(getSimilarFeedback('invalid', { canRead, audit, now })).rejects.toThrow('Feedback not found');
    canRead.mockReturnValue(false);
    await expect(getSimilarFeedback(id, { canRead, audit, now })).rejects.toThrow('Feedback not found');
    expect(db.textOne).not.toHaveBeenCalled();
    canRead.mockImplementation(item => item.id === id);
    chain.maxTimeMS.mockResolvedValue([report('507f1f77bcf86cd799439012')]);
    expect((await getSimilarFeedback(id, { canRead, audit, now })).items).toEqual([]);
  });

  it('fails closed when read audit fails', async () => {
    audit.mockRejectedValue(new Error('audit unavailable'));
    await expect(getSimilarFeedback(id, { canRead, audit, now })).rejects.toThrow('audit unavailable');
  });

  it('discloses the scan cap and excludes the sentinel from text retrieval', async () => {
    chain.maxTimeMS.mockResolvedValue(
      Array.from({ length: SIMILAR_FEEDBACK_SCAN_LIMIT + 1 }, (_, i) => report(String(i)))
    );
    const result = await getSimilarFeedback(id, { canRead, audit, now });
    expect(result.limited).toBe(true);
    expect(db.textFind.mock.calls[0][0]._id.$in).toHaveLength(SIMILAR_FEEDBACK_SCAN_LIMIT);
  });
});
