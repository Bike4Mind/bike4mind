import { FeedbackModel, HelpEventModel } from '@bike4mind/database';
import {
  FeedbackStatus,
  FeedbackType,
  HelpFeedbackRating,
  HelpFeedbackReportType,
  IHelpFeedbackContext,
  truncateFeedbackContent,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import mongoose from 'mongoose';
import { reviseFeedbackText, saveFeedbackOrRollbackText, writeFeedbackText } from '@server/utils/feedbackText';
import { resolveFeedbackOrganization } from '@server/utils/feedbackOrganization';
import { isDuplicateKeyError } from '@server/utils/isDuplicateKeyError';
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

/** What a handler knows about the comment it is routing: which help event it annotates, and where
 * the reader wrote it. Both are fixed for the life of the event, which is why they are carried in
 * while the verdict - the one part that changes under the caller - is not. */
export type RoutedCommentTarget = Pick<IHelpFeedbackContext, 'eventId' | 'surface' | 'slug'>;

/**
 * The verdict the help event carries right now, read at the moment of the write rather than taken
 * from the caller.
 *
 * The thumbs stay clickable while a note submit is in flight, so the two writers of a report's
 * verdict race each other. A caller's snapshot is read before its own text round trips, which then
 * sit between that read and the write - wide enough for a thumb flip to land in the middle and be
 * written straight back out, putting the permanent report on the verdict the reader moved away
 * from. Reading here shrinks every writer's window to the single round trip below, so a flip now
 * has to fit BOTH its event write and its verdict write inside that gap to be lost.
 *
 * Narrower, not zero, and worth saying plainly: closing it outright needs a monotonic version on
 * the help event so a stale write can be rejected outright, and `updatedAt` is millisecond-grained
 * - too coarse to be that guard without silently failing on same-millisecond writes.
 */
async function readEventVerdict(eventId: string): Promise<{ reportType?: HelpFeedbackReportType; type: FeedbackType }> {
  const event = await HelpEventModel.findById(eventId).select('rating reportType').lean();
  return { reportType: event?.reportType, type: feedbackTypeForRating(event?.rating) };
}

/**
 * Creates or revises the `Feedback` report carrying a help comment.
 *
 * Keyed on `helpContext.eventId` so it tracks the help handlers' own 10-minute dedup window: while
 * they are still revising one help event, this revises the one report attached to it instead of
 * stacking duplicates. Revising updates the text sibling's `content` but never its `expiresAt` -
 * `reviseFeedbackText` is what actually holds that line - so an edit cannot extend retention.
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
  helpContext: RoutedCommentTarget;
  logger: Pick<Logger, 'error' | 'warn'>;
}): Promise<void> {
  const userId = submitter.id;
  // Checked on the raw comment, before truncation - see writeFeedbackText's contract.
  if (comment.trim().length === 0) return;
  const { content, contentTruncated } = truncateFeedbackContent(comment);

  const existing = await FeedbackModel.findOne({ 'helpContext.eventId': helpContext.eventId, userId });
  if (existing) {
    await reviseRoutedComment({ feedbackId: existing._id, userId, content, contentTruncated, helpContext, logger });
    return;
  }

  const { organization, organizationId } = await resolveFeedbackOrganization({ userId });

  const feedbackId = new mongoose.Types.ObjectId();
  const contentStored = await writeFeedbackText({ feedbackId, content, contentTruncated, logger });
  // Unlike a bug report - which still carries a type, a subject and promptMeta once its text is
  // gone - a help report IS its comment: without the text it says nothing the help event did not
  // already say. So a swallowed text write fails the submission here rather than persisting an
  // empty report and answering 201.
  if (!contentStored) {
    throw new Error('Failed to store help feedback comment');
  }

  const { reportType, type } = await readEventVerdict(helpContext.eventId);

  const feedback = new FeedbackModel({
    _id: feedbackId,
    userId,
    status: FeedbackStatus.New,
    // `username` is required by the schema, so a submitter carrying neither display field would
    // fail validation on an otherwise valid report. `userId` is the last resort for exactly that
    // case - it is always present, and an opaque id in the admin list beats a dropped comment.
    //
    // `||`, not `??`: `username` is `required` in the schema and Mongoose treats '' as missing, so
    // a session carrying an empty display field has to fall through to the next one or the save
    // throws - after the HelpEvent was already written, losing the comment this line exists to keep.
    username: submitter.username || submitter.email || userId,
    userEmail: submitter.email,
    organization,
    organizationId,
    type,
    subject: 'help',
    helpContext: { ...helpContext, reportType },
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
    await reviseRoutedComment({ feedbackId: winner._id, userId, content, contentTruncated, helpContext, logger });
    return;
  }

  // A verdict that changed while this insert was in flight had no report to land on - the sync is
  // update-only, by design - so it matched nothing and was dropped. Re-applying it here is what
  // makes the FIRST submission as safe as every later one; without it a thumb flipped during the
  // opening note submit is the one flip that never reaches the permanent report.
  await syncRoutedVerdict({ eventId: helpContext.eventId, userId });
}

/**
 * Carries a changed verdict - the thumbs and the outdated flag - onto the report already routed
 * for this help event.
 *
 * The thumbs and the comment are submitted independently - a user can rate, write a note, then
 * flip the thumb without touching the note - so the rating has two state-change sites and only
 * one of them carries a comment. Without this, a report routed as THUMBS_DOWN would keep saying
 * so after the user settled on "helpful", within the one editing session the two submissions
 * share.
 *
 * That bound is real and worth stating precisely: this keys on `eventId`, and the handlers only
 * reuse an event for 10 minutes (see the dedup window in `api/help/feedback.ts`). A rating left
 * after the window opens a NEW event, which no report points at, so this matches nothing and the
 * report keeps the verdict its own submission carried. That is the intended binding - a report
 * belongs to the submission that wrote the comment, not to the article forever - but it does mean
 * the guarantee is "for as long as the user is still on this submission", not "permanently".
 *
 * Deliberately update-only: a bare rating is behavior-shaped and belongs in the help event store,
 * so this never creates a report for a user who has not written anything.
 *
 * The single writer of a routed report's verdict fields - the comment path calls it too rather
 * than writing them itself, so there is one place the rule "the verdict is whatever the event says
 * at write time" is expressed. Takes no verdict from its caller for the reason `readEventVerdict`
 * gives.
 */
export async function syncRoutedVerdict({ eventId, userId }: { eventId: string; userId: string }): Promise<void> {
  const { reportType, type } = await readEventVerdict(eventId);
  // A `reportType` of undefined is stripped by Mongoose's update casting rather than written as
  // null, so an event with no flag leaves a stored one alone. That is the intended behavior and
  // not a gap: the flag is only ever set, never cleared, on the event either.
  await FeedbackModel.updateOne(
    { 'helpContext.eventId': eventId, userId },
    { $set: { 'helpContext.reportType': reportType, type } }
  );
}

/**
 * Updates the text of a report already routed for this help event, and carries any verdict the
 * user changed while editing onto the report with it.
 */
async function reviseRoutedComment({
  feedbackId,
  userId,
  content,
  contentTruncated,
  helpContext,
  logger,
}: {
  feedbackId: mongoose.Types.ObjectId;
  userId: string;
  content: string;
  contentTruncated: boolean;
  helpContext: RoutedCommentTarget;
  logger: Pick<Logger, 'warn'>;
}): Promise<void> {
  // Retention is that helper's contract, not this one's: an edit must never extend the window the
  // sibling was created with, nor re-create one the TTL has already swept.
  const revised = await reviseFeedbackText({ feedbackId, content, contentTruncated });
  if (!revised) {
    // Unreachable while both handlers only ever hand over an event from inside their 10-minute
    // dedup window, which is far short of the sibling's 90 days. Logged rather than asserted so
    // the day that stops holding is visible instead of silently dropping the user's revision.
    logger.warn('Revised a help report whose text sibling was already gone', {
      feedbackId: feedbackId.toString(),
      eventId: helpContext.eventId,
    });
  }

  // Only `contentStored` - `eventId`, `surface` and `slug` are fixed for the life of the event
  // this report is keyed on, so a revision has nothing to say about them. Writing the whole
  // `helpContext` subdocument instead would take the absent keys with it, dropping the outdated
  // flag a comment-only revision arrives without.
  await FeedbackModel.updateOne({ _id: feedbackId }, { $set: { contentStored: true } });

  // Last, and through the one writer, so the verdict it applies is read after the text round trips
  // above rather than before them.
  await syncRoutedVerdict({ eventId: helpContext.eventId, userId });
}

/** A help-event row read back for rendering, whatever else the caller projected onto it. */
type RoutedCommentHost = { _id: unknown; comment?: string };

/**
 * The read half of the seam, and the only entry point into it.
 *
 * Every surface that used to project `HelpEvent.comment` has to go through this now - the user's
 * own panel (`api/help/my-feedback.ts`) and the admin help analytics tab
 * (`api/admin/help-analytics.ts`). Exposed as one call that returns stitched rows rather than a
 * lookup plus a mapper the caller has to remember to apply: forgetting the second half renders
 * every comment as absent with no error anywhere, which is not a mistake a reader of the call site
 * would catch.
 *
 * Takes the groups a caller renders separately (articles and chat answers) so both are served by
 * one batched lookup, never N+1 and never two round trips. Pass `userId` to scope the read to one
 * user; the admin surface deliberately omits it and relies on its own permission check instead.
 */
export async function stitchRoutedComments<A extends RoutedCommentHost, B extends RoutedCommentHost>(
  [first, second]: [A[], B[]],
  { userId }: { userId?: string } = {}
): Promise<[Array<A & { comment?: string }>, Array<B & { comment?: string }>]> {
  const comments = await routedCommentsByEventId(
    [...first, ...second].map(event => String(event._id)),
    { userId }
  );
  // Mapped inline rather than through one hoisted closure: a closure fixes its type parameter at
  // the constraint, so both groups would come back widened to `RoutedCommentHost`.
  return [
    first.map(event => withRoutedComment(event, comments)),
    second.map(event => withRoutedComment(event, comments)),
  ];
}

/**
 * Given the help events a caller is rendering, returns the routed comment for each, keyed by
 * event id. Internal to the seam - callers go through `stitchRoutedComments` above.
 */
async function routedCommentsByEventId(
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
function withRoutedComment<T extends RoutedCommentHost>(
  event: T,
  comments: Map<string, string>
): T & { comment?: string } {
  return { ...event, comment: comments.get(String(event._id)) ?? event.comment };
}
