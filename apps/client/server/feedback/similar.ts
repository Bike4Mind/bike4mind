import { FeedbackStatus, FeedbackType, type IFeedbackDocument } from '@bike4mind/common';
import { FeedbackModel, FeedbackTextModel } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import type { SimilarFeedbackResponse } from '@client/app/components/admin/Feedback/feedbackSimilar';

export const SIMILAR_FEEDBACK_SCAN_LIMIT = 500;
export const SIMILAR_FEEDBACK_RESULT_LIMIT = 50;
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const TEXT_LIMIT = 4000;

const normalize = (text: string) =>
  text
    .slice(0, TEXT_LIMIT)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export function feedbackTextSimilarity(left: string, right: string): number {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 12) return 0;
  const grams = (text: string) => new Set(Array.from({ length: text.length - 2 }, (_, i) => text.slice(i, i + 3)));
  const first = grams(a);
  const second = grams(b);
  const overlap = [...first].filter(gram => second.has(gram)).length;
  return (2 * overlap) / (first.size + second.size);
}

type ReadReport = { id: string; userId: string };

export async function getSimilarFeedback(
  id: string,
  options: {
    canRead: (report: IFeedbackDocument) => boolean;
    audit: (reports: ReadReport[]) => Promise<void>;
    now?: Date;
  }
): Promise<SimilarFeedbackResponse> {
  const report = isValidObjectId(id) ? await FeedbackModel.findById(id) : null;
  if (!report || !options.canRead(report)) throw new NotFoundError('Feedback not found');
  const now = options.now ?? new Date();
  const from = new Date(now.getTime() - WINDOW_MS);
  const sourceText = await FeedbackTextModel.findOne({ _id: report._id, expiresAt: { $gt: now } }).lean();
  const source = sourceText?.content ?? (!report.contentStored && report.createdAt >= from ? report.content : '');
  if (!source?.trim()) return { items: [], limited: false };

  const candidates = await FeedbackModel.find({
    _id: { $ne: report._id },
    type:
      (report.type ?? FeedbackType.FEEDBACK) === FeedbackType.FEEDBACK
        ? { $in: [FeedbackType.FEEDBACK, null] }
        : report.type,
    status: { $in: [FeedbackStatus.New, FeedbackStatus.InProgress, FeedbackStatus.Closed] },
    createdAt: { $gte: from, $lte: now },
  })
    .select('_id userId status createdAt content contentStored type')
    .sort({ createdAt: -1, _id: -1 })
    .limit(SIMILAR_FEEDBACK_SCAN_LIMIT + 1)
    .hint('feedback_status_createdAt')
    .maxTimeMS(2000);
  const visible = candidates.slice(0, SIMILAR_FEEDBACK_SCAN_LIMIT).filter(candidate => options.canRead(candidate));
  const texts = await FeedbackTextModel.find({
    _id: { $in: visible.map(candidate => candidate._id) },
    expiresAt: { $gt: now },
  }).lean();
  const textById = new Map(texts.map(text => [String(text._id), text.content]));
  const matches = visible.flatMap(candidate => {
    const content = textById.get(candidate.id) ?? (!candidate.contentStored ? candidate.content : '');
    const similarity = feedbackTextSimilarity(source, content ?? '');
    return similarity >= 0.8 ? [{ candidate, similarity, excerpt: (content ?? '').slice(0, 240) }] : [];
  });
  matches.sort(
    (a, b) =>
      Number(a.candidate.status === FeedbackStatus.Closed) - Number(b.candidate.status === FeedbackStatus.Closed) ||
      b.similarity - a.similarity ||
      b.candidate.createdAt.getTime() - a.candidate.createdAt.getTime() ||
      a.candidate.id.localeCompare(b.candidate.id)
  );
  const selected = matches.slice(0, SIMILAR_FEEDBACK_RESULT_LIMIT);
  await options.audit(
    [report, ...selected.map(item => item.candidate)].map(item => ({ id: item.id, userId: item.userId }))
  );
  return {
    items: selected.map(({ candidate, similarity, excerpt }) => ({
      id: candidate.id,
      status: candidate.status,
      createdAt: candidate.createdAt.toISOString(),
      excerpt,
      similarity,
    })),
    limited: candidates.length > SIMILAR_FEEDBACK_SCAN_LIMIT || matches.length > SIMILAR_FEEDBACK_RESULT_LIMIT,
  };
}
