import { FeedbackAiModel, FeedbackTextModel } from '@bike4mind/database';
import { FeedbackStatus, FeedbackType } from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils';
import type { FilterQuery } from 'mongoose';
import type { FeedbackListFilterParams } from '@client/app/components/admin/Feedback/types';
import { feedbackReceivedSince } from '@client/app/components/admin/Feedback/feedbackTrends';
import { feedbackAiVisible } from '@server/admin/ai/feedbackVisibility';

export async function buildFeedbackListFilter(
  query: Omit<FeedbackListFilterParams, 'status' | 'type' | 'organization'> & {
    status?: FeedbackStatus | FeedbackStatus[];
    type?: FeedbackType | FeedbackType[];
    organization?: string | string[];
  },
  readable: FilterQuery<unknown>,
  isAdmin: boolean
): Promise<FilterQuery<unknown>> {
  const clauses: FilterQuery<unknown>[] = [readable];
  for (const key of ['userId', 'sessionId', 'questId', 'organizationId', 'subject'] as const) {
    if (query[key]) clauses.push({ [key]: query[key] });
  }
  if (query.area || query.severity) {
    if (!isAdmin || !(await feedbackAiVisible())) {
      clauses.push({ _id: { $in: [] } });
    } else {
      const labelClauses = Object.entries({ area: query.area, severity: query.severity })
        .filter(([, value]) => value)
        .map(([key, value]) => ({
          $or: [{ [`override.${key}`]: value }, { override: { $exists: false }, [`labels.${key}`]: value }],
        }));
      const matches = await FeedbackAiModel.find({ expiresAt: { $gt: new Date() }, $and: labelClauses })
        .select('feedbackId')
        .lean();
      clauses.push({ _id: { $in: matches.map(row => row.feedbackId) } });
    }
  }
  if (query.resolution) clauses.push({ status: FeedbackStatus.Closed, resolution: query.resolution });
  for (const key of ['organization', 'status'] as const) {
    const value = query[key];
    const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
    if (values.length > 0) clauses.push({ [key]: { $in: values } });
  }
  const types = query.type === undefined ? [] : Array.isArray(query.type) ? query.type : [query.type];
  if (types.length > 0)
    clauses.push({ type: { $in: types.includes(FeedbackType.FEEDBACK) ? [...types, null] : types } });
  if (query.received) clauses.push({ createdAt: { $gt: feedbackReceivedSince(query.received, new Date()) } });
  if (query.createdFrom || query.createdTo) {
    clauses.push({
      createdAt: {
        ...(query.createdFrom ? { $gte: new Date(query.createdFrom) } : {}),
        ...(query.createdTo ? { $lte: new Date(query.createdTo) } : {}),
      },
    });
  }
  // "Has comment" means text was submitted, which `contentStored` records permanently. It is not
  // hasFeedbackComment(): a report whose only text is the legacy placeholder counts as having one,
  // since on older rows the text that would tell them apart has expired. `false`, not `$ne: true`:
  // the field is always present (schema default, and the text-split migration backfilled it), and
  // an equality keeps feedback_status_contentStored_createdAt usable.
  if (query.hasComment !== undefined) clauses.push({ contentStored: query.hasComment });
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    const matchingText = await FeedbackTextModel.find({ content: pattern }).select('_id').lean();
    const searchClauses: FilterQuery<unknown>[] = [{ username: pattern }, { userEmail: pattern }];
    if (matchingText.length > 0) searchClauses.push({ _id: { $in: matchingText.map(text => text._id) } });
    clauses.push({ $or: searchClauses });
  }
  // CASL and text search can both carry $or; neither may overwrite the other.
  return { $and: clauses };
}
