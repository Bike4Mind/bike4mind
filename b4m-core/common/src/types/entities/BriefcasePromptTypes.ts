import { IBaseRepository, IMongoDocument } from '.';
import { B4MLLMTools } from '../../schemas/llm';

/**
 * Briefcase capability - a curated catalog of one-click AI prompts.
 *
 * A prompt is STORED DATA, not code: `promptText` is a template with
 * `{{variable}}` placeholders resolved against an IPromptContext at click time.
 * System prompts (shared) have `userId == null`; personal prompts (single-owner)
 * carry the owning user id. See the briefcase blueprint for the full contract.
 */

/**
 * How a resolved prompt is delivered into the chat surface when clicked.
 *
 * NOTE: 'hidden' is RESERVED but not yet wired - the host send path has no
 * server-side "hidden message" support today, so the launcher currently treats
 * 'hidden' the same as 'auto-fire'. True invisible-send (transcript shows only a
 * friendly label) is a tracked follow-up. See the blueprint's "Execution mode".
 */
export type ExecutionMode = 'inject' | 'auto-fire' | 'hidden';

/**
 * Tools the chat surface must run a briefcase send with. Constrained to the
 * host's closed tool set (`B4MLLMTools`), never free text - a stored prompt
 * cannot reference a tool that no longer exists.
 */
export type BriefcasePromptToolFlag = B4MLLMTools;

/**
 * The stored unit of the catalog. `userId == null/absent` => system prompt
 * (shared, surfaced by `type`/`tags`, gated by `visibilityScopes`); `userId`
 * set => personal prompt owned by that user and resolvable only for them.
 */
export interface IBriefcasePrompt {
  /** Category discriminator (e.g. 'account_insights', 'analyst_tools'). */
  type: string;
  /** Human-facing display name shown in the launcher. */
  name: string;
  /** Optional short description shown under the launcher label. */
  description?: string;
  /** Template text with `{{key}}` placeholders. */
  promptText: string;
  /** Backend filter tags for catalog grouping. */
  tags?: string[] | null;
  /** Owning user id. `null`/absent => system (shared) prompt; set => personal. */
  userId?: string | null;
  /** Delivery mode. Defaults to 'inject' when absent. */
  executionMode?: ExecutionMode;
  /**
   * Entitlement scoping for system prompts. `null`/empty => visible to all.
   * Otherwise visible only to users whose tags intersect this list (admins
   * bypass). Mapped to the host's existing user-tag entitlement concept.
   */
  visibilityScopes?: string[] | null;
  /** Tools the send must run with (validated against the host tool set). */
  requiredTools?: BriefcasePromptToolFlag[] | null;
  /** Document schema version; new fields default to absent-equals-legacy. */
  schemaVersion?: number;
  /** Soft-delete marker (set by the soft-delete plugin). */
  deletedAt?: Date | null;
}

/** A persisted briefcase prompt: IBriefcasePrompt plus the store's identity. */
export interface IBriefcasePromptDocument extends IBriefcasePrompt, IMongoDocument {}

export interface IBriefcasePromptRepository extends IBaseRepository<IBriefcasePromptDocument> {
  /** Caller's personal prompts (metadata only - promptText excluded). */
  listPersonal(userId: string): Promise<IBriefcasePromptDocument[]>;
  /**
   * System prompts of a category (metadata only - promptText excluded).
   * `visibility` pushes the entitlement filter INTO the query so the result cap
   * applies to the already-visible set: `null` => bypass (admin, see all);
   * `string[]` => only unscoped prompts or those whose scopes intersect these.
   */
  listSystemByType(type: string, visibility: string[] | null): Promise<IBriefcasePromptDocument[]>;
  /** System prompts matching any tag (metadata only - promptText excluded). See `visibility` above. */
  listSystemByTags(tags: string[], visibility: string[] | null): Promise<IBriefcasePromptDocument[]>;
  /**
   * Full prompt (incl. promptText) by id, visible to the caller: a system
   * prompt, or one the caller owns. Returns null otherwise - never another
   * user's personal prompt. This is the authoritative click-time refetch.
   */
  findByIdForCaller(id: string, callerUserId: string): Promise<IBriefcasePromptDocument | null>;
  /** Update a prompt only if owned by the caller. Returns null if not owned. */
  updateOwned(id: string, userId: string, patch: Partial<IBriefcasePrompt>): Promise<IBriefcasePromptDocument | null>;
  /** Soft-delete a prompt only if owned by the caller. Returns true if deleted. */
  softDeleteOwned(id: string, userId: string): Promise<boolean>;
}

/**
 * Values available for `{{variable}}` substitution, built fresh at click time
 * from the signed-in user, the selected org, and the current clock. The
 * load-bearing invariant is the `{{key}}` -> value resolution, not this exact
 * key set - a host adds/drops keys freely.
 */
export interface IPromptContext {
  organization?: string;
  userName?: string;
  userEmail?: string;
  userRole?: string;
  currentDateTime?: string;
  currentDate?: string;
  currentTime?: string;
  currentYear?: string;
}

/**
 * Payload the launcher publishes and the chat surface subscribes to. The two
 * halves communicate only through this message - neither imports the other.
 * Transport in this host is the `programmaticSubmit` Zustand channel (DOM-free).
 */
export interface IResolvedPromptDispatch {
  /** The selected prompt's id. Also the correlation id for analytics. */
  promptId: string;
  /**
   * Per-dispatch de-duplication token. The subscriber drops a message whose
   * nonce it has already processed - defends against double-click, re-mount,
   * and the auto-fire timer racing a second click.
   */
  dispatchNonce: string;
  /** Fully resolved prompt text (variables substituted, guard prepended). */
  promptContent: string;
  /** Display name for the transcript (used when isHidden). */
  promptName?: string;
  /** When true, send without showing the raw prompt (reserved; see ExecutionMode). */
  isHidden?: boolean;
  /** Tools the send must run with for this one message. */
  requiredTools?: BriefcasePromptToolFlag[] | null;
  /** The session this dispatch targets, so only the matching surface consumes it. */
  sessionId?: string | null;
}

/**
 * One query within a batched catalog request. Exactly one selector is used:
 * `personal: true` (resolved to the caller server-side), else `tags`, else `type`.
 */
export interface IPromptBatchQuery {
  /** Stable client key the result map is keyed by. */
  key: string;
  tags?: string[];
  type?: string;
  /** Resolve the caller's own personal prompts. Server ignores any client user id. */
  personal?: boolean;
}

/** A batched catalog request. The endpoint bounds the number of queries. */
export interface IPromptBatchRequest {
  queries: IPromptBatchQuery[];
}

/** key -> prompts map returned by the batch endpoint. */
export type IPromptCatalog = Record<string, IBriefcasePromptDocument[]>;

/**
 * The authenticated caller, resolved server-side from session/framework context
 * - never from client-supplied parameters.
 */
export interface ICaller {
  id: string;
  /** Entitlement tokens (mapped to the host's user tags). */
  entitlements: string[];
  isAdmin: boolean;
  /** True when the request is authenticated via an API key, not an interactive session. */
  isApiKey?: boolean;
}

/**
 * The server-side contract the catalog endpoint must satisfy. Wired to the
 * host's auth/policy system.
 */
export interface ICatalogAccessControl {
  /** Throws/denies unless the caller may read prompts. */
  assertCanReadPrompts(caller: ICaller | undefined): void;
  /** Resolve personal prompts for the AUTHENTICATED caller only - never a client id. */
  getPersonalPrompts(caller: ICaller): Promise<IBriefcasePromptDocument[]>;
  /** Filter a system-prompt list to those visible to the caller (admins bypass). */
  filterByEntitlement(prompts: IBriefcasePromptDocument[], caller: ICaller): IBriefcasePromptDocument[];
}
