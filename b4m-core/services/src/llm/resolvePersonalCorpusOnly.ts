import type { IFabFileDocument } from '@bike4mind/common';

export interface PersonalCorpusInput {
  /** `session.knowledgeIds` - the ids the caller ASKED to attach, before any permission filtering. */
  requestedKnowledgeIds: string[];
  /**
   * The attached files as RESOLVED by the host's permission filter. `null` means the lookup failed
   * or was skipped. A SHORT array (fewer than requested) means some ids were not visible to that
   * reader - which is not the same thing as those files being personal. See the count guard below.
   */
  resolvedFiles: IFabFileDocument[] | null;
  /** `datalakeTag`s of every lake the caller can reach. Empty means "could not resolve". */
  accessibleLakeTags: Set<string>;
  /** `session.retrievalTags` - a session already scoped to a lake is not a personal corpus. */
  retrievalTags: string[] | undefined;
  /** `session.corpusGroundingMode` - 'retrieve' means the tool IS the intended reader. */
  corpusGroundingMode: string | undefined;
  /**
   * How many attachments are reachable as LAKE content, asked through the lake arm rather than the
   * ownership/share reader that produced `resolvedFiles`. `null` means "could not tell". Any nonzero
   * count means the corpus is not personal, whatever `resolvedFiles` was able to see.
   *
   * A THUNK because resolving it costs a query, and the guards above it reject most callers first.
   */
  countLakeReachableAttachments: () => Promise<number | null>;
}

/**
 * Is this session's attached corpus entirely PERSONAL - nothing belonging to a data lake the caller
 * can reach? Drives the forced-retrieval skip and the knowledge tool's personal-corpus scope.
 *
 * Pure and exported so the predicate itself is testable. It was previously inline in
 * `ChatCompletionProcess.process()`, where both consumers were tested by injecting the RESULT and
 * nothing exercised the clauses - which is how the count guard below was missed.
 *
 * FAIL-SAFE DIRECTION: every uncertainty resolves to `false` (keep grounding). A wrong `true`
 * silently removes retrieval; a wrong `false` merely leaves today's behavior in place.
 */
export async function resolvePersonalCorpusOnly(input: PersonalCorpusInput): Promise<boolean> {
  const { requestedKnowledgeIds, resolvedFiles, accessibleLakeTags, retrievalTags, corpusGroundingMode } = input;


  if (requestedKnowledgeIds.length === 0) return false; // nothing attached -> nothing to classify
  if (resolvedFiles === null) return false; // lookup failed -> cannot judge
  if (accessibleLakeTags.size === 0) return false; // lake access unresolved -> cannot judge
  if ((retrievalTags?.length ?? 0) > 0) return false; // already lake-scoped
  if (corpusGroundingMode === 'retrieve') return false; // the tool is the intended reader

  // THE COUNT GUARD. `resolvedFiles` comes from a permission-filtered read, and the filters that
  // grant lake access are NOT the filter that read these ids: an organization lake widens reach via
  // the lake creator's identity (see lakeMembershipScope / fabFileSearchQuery's membership arm),
  // which an ownership/share-based reader cannot see. So a caller attaching org-lake files they do
  // not personally own resolves to a SHORT list - or an empty one.
  //
  // That matters because the emptiness is invisible to the test below: `[].every(...)` is `true`, so
  // "I could not see any of these files" would otherwise read as "none of them are lake files" and
  // suppress retrieval entirely. On the public API's grounded path the knowledge tool is not offered
  // either (skipAutoOffers), so that turn would have NO retrieval at all - silently.
  //
  // Anything short of full resolution therefore means "cannot judge", never "personal".
  if (resolvedFiles.length !== requestedKnowledgeIds.length) return false;

  // The authoritative half of the same question: the lake arm can see files the reader above
  // cannot, so a nonzero count means lake content is attached even when `resolvedFiles` showed none
  // of it. `null` is "could not tell", which is not permission to classify.
  const lakeReachableAttachments = await input.countLakeReachableAttachments();
  if (lakeReachableAttachments === null || lakeReachableAttachments > 0) return false;

  // Keying on lake MEMBERSHIP is what makes the corpus-defer path safe without a further gate:
  // resolveCorpusInlinePlan only ever defers a `lakeTagged` file, against this same accessible-tag
  // set, so a personal-only corpus has nothing deferrable and cannot be stranded by a raised
  // CorpusRetrievalMinInlineTokensPerDoc. Change this away from lake membership and that gate has
  // to be added there.
  return resolvedFiles.every(f => !(f.tags ?? []).some(t => accessibleLakeTags.has(t.name)));
}
