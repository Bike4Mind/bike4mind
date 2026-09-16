import { FeedbackModel, FeedbackTextModel, User } from '@bike4mind/database';
import {
  FeedbackStatus,
  FeedbackType,
  IFeedbackDocument,
  HelpFeedbackRating,
  HelpFeedbackReportType,
  IHelpFeedbackContext,
  IOrganizationDocument,
  feedbackContentExpiresAt,
  truncateFeedbackContent,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import mongoose from 'mongoose';
import { saveFeedbackOrRollbackText, writeFeedbackText } from '@server/utils/feedbackText';
import { hydrateFeedbackText } from '@server/utils/redactedFeedback';

/**
 * Consolidation seam for the help center: anything a user *wrote* goes to `Feedback`, while what
 * they *did* (views, searches, bare ratings, the outdated report) stays in the help-event store.
 *
 * Retention is preserved rather than extended - a help event carries a 90-day TTL and the comment
 * lands in the 90-day `FeedbackText` sibling, so the text moves from one 90-day window to another.
 * The comment is never written to the permanent `FeedbackModel.content` field.
 *
 * Deliberately not routed through `POST /api/feedback`: that handler fans every report it saves
 * out to Slack and email, gated only on the two admin settings and never on what the report is
 * about, so reusing it would put every "this article was unhelpful" note into the channel
 * operators watch for bug reports. This writes the same two rows without that fan-out.
 */

/** Thumbs map onto the existing thumbs types so a help verdict triages like any other; a comment
 * left without a rating is plain feedback. */
function feedbackTypeForRating(rating?: HelpFeedbackRating): FeedbackType {
  if (rating === 'helpful') return FeedbackType.THUMBS_UP;
  if (rating === 'not_helpful') return FeedbackType.THUMBS_DOWN;
  return FeedbackType.FEEDBACK;
}

/** E11000 off the unique partial index on `helpContext.eventId`. Both error shapes are checked for
 * the reason spelled out on the same helper in persistAgentArtifacts.ts: a driver error that
 * crossed a serialization boundary arrives as a plain object carrying only the message. */
function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code === 11000) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('E11000');
}

/**
 * Creates or revises the `Feedback` report carrying a help comment.
 *
 * Keyed on `helpContext.eventId` so it tracks the help handlers' own 10-minute dedup window: while
 * they are still revising one help event, this revises the one report attached to it instead of
 * stacking duplicates. Revising updates the text sibling's `content` but never its `expiresAt` -
 * the $setOnInsert below is what actually holds that line - so an edit cannot extend retention.
 *
 * The find-or-create is not atomic on its own, and two submissions for one help event do race it
 * (a double-submit, a retried request, a second tab). The unique partial index on
 * `helpContext.eventId` is what settles that race: the loser's insert fails with E11000 and is
 * retried as a revision of the winner, so the pair collapses to one report either way.
 *
 * Throws on failure rather than swallowing: the comment no longer lives on the help event, so a
 * silent failure here would lose it outright while still telling the user they were heard.
 */
export async function routeHelpCommentToFeedback({
  submitter,
  comment,
  helpContext,
  logger,
}: {
  /** The authenticated session's own identity - the display fields are taken from here rather
   * than re-read, matching the create handler, where an authenticated session always wins. */
  submitter: { id: string; username?: string | null; email?: string | null };
  comment: string;
  helpContext: IHelpFeedbackContext;
  logger: Pick<Logger, 'error' | 'warn'>;
}): Promise<void> {
  const userId = submitter.id;
  // Checked on the raw comment, before truncation - see writeFeedbackText's contract.
  if (comment.trim().length === 0) return;
  const { content, contentTruncated } = truncateFeedbackContent(comment);

  const existing = await FeedbackModel.findOne({ 'helpContext.eventId': helpContext.eventId, userId });
  if (existing) {
    await reviseRoutedComment({ existing, content, contentTruncated, helpContext });
    return;
  }

  // Looked up for the same reason the create handler does it: organizationId is the authorization
  // key a scoped reader filters on, and `organization` is the display label an admin triages by.
  const user = await User.findById(userId).populate('organizationId');
  const organizationDoc = user?.organizationId as unknown as IOrganizationDocument | undefined;

  const feedbackId = new mongoose.Types.ObjectId();
  const contentStored = await writeFeedbackText({ feedbackId, content, contentTruncated, logger });
  // Unlike a bug report - which still carries a type, a subject and promptMeta once its text is
  // gone - a help report IS its comment: without the text it says nothing the help event did not
  // already say. So a swallowed text write fails the submission here rather than persisting an
  // empty report and answering 201.
  if (!contentStored) {
    throw new Error('Failed to store help feedback comment');
  }

  const feedback = new FeedbackModel({
    _id: feedbackId,
    userId,
    status: FeedbackStatus.New,
    // `username` is required by the schema, so it falls back the same way the rest of the app
    // does (see admin/whats-new-config.ts) rather than failing an otherwise valid report.
    username: submitter.username ?? submitter.email ?? userId,
    userEmail: submitter.email,
    organization: organizationDoc?.name || 'Unknown',
    organizationId: organizationDoc?.id ?? null,
    type: feedbackTypeForRating(helpContext.rating),
    subject: 'help',
    helpContext,
    contentStored,
  });

  try {
    await saveFeedbackOrRollbackText({ feedback, contentStored, logger });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // A concurrent submission for this help event won the insert. Our text sibling was already
    // rolled back by the failed save, so the comment now has to land on the winner's row - the
    // same revision this call would have done had its read happened a moment later.
    //
    // Logged because this branch only fires under real contention: without it a smoke test cannot
    // tell "the race never happened" from "the race happened and was quietly absorbed".
    logger.warn('Lost the insert race for a help feedback report; revising the winner instead', {
      eventId: helpContext.eventId,
    });
    const winner = await FeedbackModel.findOne({ 'helpContext.eventId': helpContext.eventId, userId });
    if (!winner) throw error;
    await reviseRoutedComment({ existing: winner, content, contentTruncated, helpContext });
  }
}

/**
 * Carries a changed verdict - the thumbs and the outdated flag - onto the report already routed
 * for this help event.
 *
 * The thumbs and the comment are submitted independently - a user can rate, write a note, then
 * flip the thumb without touching the note - so the rating has two state-change sites and only
 * one of them carries a comment. Without this, a report routed as THUMBS_DOWN would keep saying
 * so after the user settled on "helpful", and the permanent record an admin triages would
 * contradict the verdict the user actually left.
 *
 * Deliberately update-only: a bare rating is behavior-shaped and belongs in the help event store,
 * so this never creates a report for a user who has not written anything.
 */
export async function syncRoutedVerdict({
  eventId,
  userId,
  rating,
  reportType,
}: {
  eventId: string;
  userId: string;
  rating?: HelpFeedbackRating;
  reportType?: HelpFeedbackReportType;
}): Promise<void> {
  await FeedbackModel.updateOne(
    { 'helpContext.eventId': eventId, userId },
    {
      $set: {
        'helpContext.rating': rating,
        'helpContext.reportType': reportType,
        type: feedbackTypeForRating(rating),
      },
    }
  );
}

/**
 * Updates the text of a report already routed for this help event.
 *
 * Upserts rather than updating in place. A revise only runs against an event inside the 10-minute
 * dedup window, so the sibling is minutes old and should always be there - the upsert is
 * defensive, not a TTL case, and costs nothing if that assumption ever stops holding.
 */
async function reviseRoutedComment({
  existing,
  content,
  contentTruncated,
  helpContext,
}: {
  existing: mongoose.HydratedDocument<IFeedbackDocument>;
  content: string;
  contentTruncated: boolean;
  helpContext: IHelpFeedbackContext;
}): Promise<void> {
  // $setOnInsert is the only path that sets `expiresAt`, so an existing row keeps the window it
  // was created with and an edit cannot extend it. Left to throw for the same reason the create
  // path above does: a revision the user cannot see fail is a revision they believe was saved.
  await FeedbackTextModel.updateOne(
    { _id: existing._id },
    {
      $set: { content, contentTruncated },
      $setOnInsert: { expiresAt: feedbackContentExpiresAt(new Date()) },
    },
    { upsert: true }
  );

  // The rating can change within the dedup window (a user flipping thumbs while editing their
  // note), so the stored context and the derived type must follow it rather than stay at the
  // value the first submission happened to carry.
  existing.set({
    helpContext,
    type: feedbackTypeForRating(helpContext.rating),
    contentStored: true,
  });
  await existing.save();
}

/**
 * The read half of the same seam: given the help events a caller is rendering, returns the routed
 * comment for each, keyed by event id. Every surface that used to project `HelpEvent.comment` has
 * to go through this now - the user's own panel (`api/help/my-feedback.ts`) and the admin help
 * analytics tab (`api/admin/help-analytics.ts`) - or it silently renders every comment as absent.
 *
 * One batched lookup per store, never N+1. Pass `userId` to scope the read to one user; the admin
 * surface deliberately omits it and relies on its own permission check instead.
 */
export async function routedCommentsByEventId(
  eventIds: string[],
  { userId }: { userId?: string } = {}
): Promise<Map<string, string>> {
  if (eventIds.length === 0) return new Map();

  const reports = await FeedbackModel.find({
    ...(userId ? { userId } : {}),
    subject: 'help',
    'helpContext.eventId': { $in: eventIds },
  })
    .select('helpContext contentStored content')
    .lean();

  const hydrated = await hydrateFeedbackText(
    reports.map(report => ({
      id: report._id.toString(),
      eventId: report.helpContext?.eventId,
      contentStored: report.contentStored,
      content: report.content,
    }))
  );

  return new Map(
    hydrated
      .filter((report): report is typeof report & { eventId: string; content: string } =>
        Boolean(report.eventId && report.content)
      )
      .map(report => [report.eventId, report.content])
  );
}

/**
 * Restores `comment` onto a help event read back from the store, preferring the routed report and
 * falling back to the event's own deprecated field so rows written before the split still render
 * until the 90-day TTL sweeps them.
 */
export function withRoutedComment<T extends { _id: unknown; comment?: string }>(
  comments: Map<string, string>
): (event: T) => T & { comment?: string } {
  return event => ({ ...event, comment: comments.get(String(event._id)) ?? event.comment });
}
