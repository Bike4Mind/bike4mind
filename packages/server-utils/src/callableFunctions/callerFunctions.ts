import {
  callableFunctionReviewStatus,
  effectiveCallableFunctionStatus,
  reviewHash,
  type CallableFunctionAccess,
  type CallableFunctionSharedStatus,
  type ICallableFunctionSharedSource,
  type ICallableFunctionSummary,
  type McpToolApprovalMode,
} from '@bike4mind/common';
import { artifactRepository, callableFunctionRepository, callableFunctionReviewRepository } from '@bike4mind/database';
import { listOfferedCallableFunctions, type CallableFunctionActor } from './registry';
import { reachableSharedFunctions } from './sharing';

/**
 * The functions a caller reaches by their access, for every surface that lists or names one (REST, MCP and the CLI
 * through them, chat, agent runs): their own live functions, then those shared with them. A shared entry is the
 * version the recipient calls, never its code; the dispatcher checks the share and the review again on each call.
 */

export interface CallerFunction<Fn extends ICallableFunctionSummary = ICallableFunctionSharedSource> {
  fn: Fn;
  access: CallableFunctionAccess;
  /**
   * Unique among the caller's functions: the slug, or on a shared function whose slug another of them holds, the
   * slug and the id's last six characters. A shared name can change when the caller promotes a function of that slug.
   */
  name: string;
  /** The owner's mode on their own function; the mode a recipient chose in their review. */
  approval: McpToolApprovalMode;
  /** Always for the owner; for a recipient, while they hold a current, enabled review. */
  reviewed: boolean;
  /** A recipient's review of the version they call, and that version's interface hash; absent for the owner. */
  review?: { status: CallableFunctionSharedStatus; hash: string };
}

export type CallerFunctionLookup<Fn extends ICallableFunctionSummary = ICallableFunctionSharedSource> =
  { found: CallerFunction<Fn> } | { refused: 'not_found' } | { refused: 'not_live'; fn: ICallableFunctionSummary };

const NAME_SUFFIX_LENGTH = 6;

const userOwner = (actor: CallableFunctionActor) => ({ ownerType: 'user' as const, ownerKey: actor.id });

const ownEntry = <Fn extends ICallableFunctionSummary>(fn: Fn): CallerFunction<Fn> => ({
  fn,
  access: 'owner',
  name: fn.slug,
  approval: fn.approval ?? 'default',
  reviewed: true,
});

async function isOwnLive(actor: CallableFunctionActor, fn: ICallableFunctionSummary): Promise<boolean> {
  const artifact = await artifactRepository.findOne({ id: fn.pin.artifactId, userId: actor.id });
  const head = artifact ? { version: artifact.version, deletedAt: artifact.deletedAt } : null;
  return effectiveCallableFunctionStatus(fn, head) === 'live';
}

/** Shared functions the actor reaches now, reviewed or not, named around `ownSlugs`. */
async function sharedEntries(actor: CallableFunctionActor, ownSlugs: Set<string>): Promise<CallerFunction[]> {
  const reachable = await reachableSharedFunctions(actor);
  const reviews = await callableFunctionReviewRepository.findForUser(
    actor.id,
    reachable.map(({ fn }) => fn.id)
  );
  const reviewOf = new Map(reviews.map(review => [review.functionId, review]));
  const slugCount = new Map<string, number>();
  for (const { fn } of reachable) slugCount.set(fn.slug, (slugCount.get(fn.slug) ?? 0) + 1);
  return Promise.all(
    reachable.map(async ({ fn, access }) => {
      const review = reviewOf.get(fn.id) ?? null;
      const taken = ownSlugs.has(fn.slug) || (slugCount.get(fn.slug) ?? 0) > 1;
      const hash = await reviewHash(fn.contract);
      const status = callableFunctionReviewStatus(review, hash);
      return {
        fn,
        access,
        name: taken ? `${fn.slug}_${fn.id.slice(-NAME_SUFFIX_LENGTH)}` : fn.slug,
        approval: review?.approval ?? 'default',
        reviewed: status === 'reviewed',
        review: { status, hash },
      };
    })
  );
}

/**
 * Every function the actor may call now: their own live ones, oldest first, then shared ones they have reviewed,
 * newest share first. `excludeAlwaysAsk` drops those that would ask before each call; `includeUnreviewed` keeps
 * shared ones still awaiting the actor's review, for a surface that lists them to be reviewed.
 */
export async function listCallerFunctions(
  actor: CallableFunctionActor,
  options: { excludeAlwaysAsk?: boolean; includeUnreviewed?: boolean; limit?: number } = {}
): Promise<CallerFunction[]> {
  const { excludeAlwaysAsk, includeUnreviewed, limit } = options;
  const own = await listOfferedCallableFunctions(actor, { excludeAlwaysAsk, ...(limit ? { limit } : {}) });
  const shared = await sharedEntries(actor, new Set(own.map(fn => fn.slug)));
  const all = [...own.map(ownEntry), ...shared.filter(entry => includeUnreviewed || entry.reviewed)].filter(
    entry => !(excludeAlwaysAsk && entry.approval === 'always_ask')
  );
  return limit ? all.slice(0, limit) : all;
}

/**
 * The function `ref` names for the actor: their own live one by id or slug first, then one shared with them by id or
 * by its name in {@link listCallerFunctions}. A shared function found here may still await review, so the dispatcher
 * refuses it with `review_required`. By id, the entry carries the contract; by name, an own entry does not.
 */
export function findCallerFunction(
  actor: CallableFunctionActor,
  ref: { id: string }
): Promise<CallerFunctionLookup<ICallableFunctionSharedSource>>;
export function findCallerFunction(
  actor: CallableFunctionActor,
  ref: { name: string }
): Promise<CallerFunctionLookup<ICallableFunctionSummary>>;
export async function findCallerFunction(
  actor: CallableFunctionActor,
  ref: { id: string } | { name: string }
): Promise<CallerFunctionLookup<ICallableFunctionSummary>> {
  const owner = userOwner(actor);
  const owned =
    'id' in ref
      ? await callableFunctionRepository.findByIdForOwner(ref.id, owner)
      : await callableFunctionRepository.findBySlugForOwner(ref.name, owner);
  if (owned && (await isOwnLive(actor, owned))) return { found: ownEntry(owned) };
  // A shared function may hold a name the caller's own draft also has; only an id that is the caller's ends here.
  if (!owned || 'name' in ref) {
    const ownSlugs = new Set((await listOfferedCallableFunctions(actor)).map(fn => fn.slug));
    const shared = (await sharedEntries(actor, ownSlugs)).find(entry =>
      'id' in ref ? entry.fn.id === ref.id : entry.name === ref.name
    );
    if (shared) return { found: shared };
  }
  return owned ? { refused: 'not_live', fn: owned } : { refused: 'not_found' };
}
