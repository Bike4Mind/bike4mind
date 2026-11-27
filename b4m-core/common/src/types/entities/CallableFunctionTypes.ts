import { z } from 'zod';
import { ConflictError } from '../../errors';
import { VisibilitySchema } from '../../schemas/artifacts';
import {
  FUNCTION_CONTRACT_GLOBAL,
  describeFunctionContractChange,
  type FunctionContract,
  type FunctionContractChange,
  type FunctionTestTolerance,
} from '../../schemas/functionContract';
import { IBaseRepository } from './BaseTypes';
import type { CallableFunctionCallOutcome, CallableFunctionStamp } from './CallableFunctionCallTypes';
import type { ICallableFunctionReview, ICallableFunctionReviewView } from './CallableFunctionReviewTypes';
import { IMongoDocument } from './common';
import type { McpToolApprovalMode } from './McpConnectionTypes';

/**
 * A Python artifact saved as a callable function: its code copied at one version, with the `FUNCTION` contract the
 * owner's browser read from it. Only the owner can see or call it. API responses go through
 * {@link toCallableFunctionPublic} or {@link toCallableFunctionDetail}.
 */

/** Internal tool namespace: connector slugs must start with a lowercase letter. */
export const CALLABLE_FUNCTION_TOOL_CONNECTION_ID = '_fn';

export const CALLABLE_FUNCTION_OWNER_TYPES = ['user'] as const;
export type CallableFunctionOwnerType = (typeof CALLABLE_FUNCTION_OWNER_TYPES)[number];

/** `live` is written only by a promotion; any repin returns the function to `draft`. Turning it off is `enabled`. */
export const CALLABLE_FUNCTION_STATES = ['draft', 'live'] as const;
export type CallableFunctionState = (typeof CALLABLE_FUNCTION_STATES)[number];

/**
 * The label a reader sees. Promotion stores `verified` when at least one cited worked example passed on the server,
 * otherwise `unverified`; `platform` is never stored, only shown for a `verified` function an admin marked.
 */
export const CALLABLE_FUNCTION_TRUST_LABELS = ['platform', 'verified', 'unverified'] as const;
export type CallableFunctionTrustLabel = (typeof CALLABLE_FUNCTION_TRUST_LABELS)[number];

/** What promotion writes; see {@link shownCallableFunctionTrustLabel} for `platform`. */
export const CALLABLE_FUNCTION_PROMOTION_TRUST_LABELS = ['verified', 'unverified'] as const;
export type CallableFunctionPromotionTrustLabel = (typeof CALLABLE_FUNCTION_PROMOTION_TRUST_LABELS)[number];

export const CALLABLE_FUNCTION_TRUST_LABEL_TEXT: Record<CallableFunctionTrustLabel, string> = {
  platform: 'Platform: curated and checked by Bike4Mind.',
  verified: 'Verified: a worked example passed on the server when it was promoted.',
  unverified: 'Unverified: no worked example was checked when it was promoted.',
};

/** Who besides the grants an admin may offer a marked function to: every person who is signed in. */
export const CALLABLE_FUNCTION_PLATFORM_AUDIENCES = ['signed_in'] as const;
export type CallableFunctionPlatformAudience = (typeof CALLABLE_FUNCTION_PLATFORM_AUDIENCES)[number];

/** An admin's mark: the function shows as `platform` while its own label stays `verified`. */
export interface CallableFunctionPlatformMark {
  /** The admin's userId. */
  setBy: string;
  setAt: Date;
  /** Kept on the mark, so every write that drops the mark drops the audience with it. */
  audience?: CallableFunctionPlatformAudience;
}

export const CALLABLE_FUNCTION_EXAMPLE_LIMITS = {
  maxExamples: 20,
  maxCitationLength: 500,
} as const;

/**
 * A case the owner adds in the Function tab, never read from the code, with a source a reader can check the
 * expected output against.
 */
export interface CallableFunctionExample {
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  tolerance?: FunctionTestTolerance;
  citation: string;
}

/** The server runtime that ran the promotion, so a later call can tell whether it runs on the same one. */
export interface CallableFunctionRuntimePin {
  kind: string;
  version: string;
  lockHash?: string;
  packages: { name: string; version: string }[];
}

export interface CallableFunctionServerRunCase {
  name: string;
  kind: 'test' | 'example';
  passed: boolean;
  outcome: CallableFunctionCallOutcome;
  reason?: string;
  durationMs: number;
  /** The call-log row this case wrote. */
  callId: string;
}

/** The server run that promoted the function. */
export interface CallableFunctionServerRun {
  at: Date;
  passed: number;
  failed: number;
  results: CallableFunctionServerRunCase[];
  /** The first case's stamp: the code, runtime, and packages every case ran on. */
  stamp?: CallableFunctionStamp;
}

/** One case's latest server result on a pin. Only a pass is reused, and only on the same pin, runtime, and case. */
export interface CallableFunctionCaseResult {
  /** sha256 hex of the canonical JSON of the case's input, expected outputs, and tolerance. */
  caseHash: string;
  name: string;
  kind: 'test' | 'example';
  passed: boolean;
  outcome: CallableFunctionCallOutcome;
  durationMs: number;
  /** The call-log row the case wrote. */
  callId: string;
  at: Date;
}

/** Server results for one pin and runtime: a different pin version, code hash, or runtime makes every one stale. */
export interface CallableFunctionCaseResults {
  pinVersion: number;
  contentHash: string;
  runtimeVersion: string;
  lockHash: string | null;
  /** The pinned data files the cases read; absent when there were none. */
  dataHash?: string;
  cases: CallableFunctionCaseResult[];
}

/** The last promotion, kept across repins so the next promotion can refuse a breaking change against it. */
export interface CallableFunctionPromotion {
  seq: number;
  contract: FunctionContract;
  at: Date;
  /**
   * The promoted version as it ran, which recipients keep calling while the owner's edits leave the function a
   * draft. Absent on promotions recorded before it was kept.
   */
  pin?: ICallableFunctionPin;
  description?: string;
  trustLabel?: CallableFunctionPromotionTrustLabel;
  sources?: ICallableFunctionSource[];
}

/** A share has no public rung: every recipient is a named person or a member of the project or organization. */
export const CallableFunctionGrantVisibilitySchema = VisibilitySchema.exclude(['public']);
export type CallableFunctionGrantVisibility = z.infer<typeof CallableFunctionGrantVisibilitySchema>;

export const CALLABLE_FUNCTION_GRANT_LIMITS = { maxUserIds: 50 } as const;

/**
 * Who besides the owner may call the live pin: the people in `userIds`, plus the members of `projectId` when the
 * visibility is `project` or of `organizationId` when it is `organization`. The artifact is never shared.
 */
export interface ICallableFunctionGrants {
  visibility: CallableFunctionGrantVisibility;
  projectId?: string;
  organizationId?: string;
  userIds: string[];
}

/**
 * How a caller reaches a function: as its owner, through one arm of its grants, or as a signed-in person while an
 * admin offers it to everyone ({@link isOfferedToEverySignedInPerson}).
 */
export type CallableFunctionAccess = 'owner' | 'person' | 'project' | 'organization' | 'signed_in';

/** Computed at read by {@link effectiveCallableFunctionStatus}, so deleting the artifact needs no sweep. */
export type CallableFunctionStatus = CallableFunctionState | 'disabled' | 'source_deleted';

/**
 * `FUNCTION_NAME_PATTERN` without `__` or a trailing `_`: a tool id joins a namespace and this name with `__`, so
 * either would make the id ambiguous.
 */
export const CALLABLE_FUNCTION_SLUG_PATTERN = /^(?=.{2,40}$)[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export const CALLABLE_FUNCTION_LIMITS = {
  maxPerOwner: 100,
  /** UTF-8 bytes of the pinned code. */
  maxSourceBytes: 256 * 1024,
} as const;

export interface CallableFunctionOwner {
  ownerType: CallableFunctionOwnerType;
  ownerKey: string;
}

export interface ICallableFunctionPin {
  /** The artifact's string `id`, not its `_id`. */
  artifactId: string;
  version: number;
  /** sha256 hex of `source`, computed by the server from the stored artifact content. */
  contentHash: string;
  /** The code at `version`, copied so that later edits to the artifact, or its deletion, leave the function as saved. */
  source: string;
  pinnedAt: Date;
  /** Set when this pin is promoted: 1 for the function's first promotion, then one more for each. */
  seq?: number;
  runtime?: CallableFunctionRuntimePin;
  /** Kept across repins; changed only through `setDataPins`, which returns the function to draft. */
  dataPins?: ICallableFunctionDataPin[];
  /** The `pinned` sources as promotion fetched them; cleared when the sources change. */
  sourcePins?: ICallableFunctionSourcePin[];
}

export const CALLABLE_FUNCTION_SOURCE_MODES = ['live', 'pinned'] as const;
export type CallableFunctionSourceMode = (typeof CALLABLE_FUNCTION_SOURCE_MODES)[number];

/**
 * A URL on a listed data origin, read at `/data/<name>`: `live` is fetched on every call, `pinned` once at promotion
 * (and on every call before the first). Names share the data pins' pattern and namespace, not their count.
 */
export interface ICallableFunctionSource {
  name: string;
  url: string;
  mode: CallableFunctionSourceMode;
}

export interface ICallableFunctionSourcePin {
  name: string;
  sha256: string;
  bytes: number;
  fetchedAt: Date;
}

export const CALLABLE_FUNCTION_SOURCE_URL_MAX_CHARS = 2048;

/** A file's bytes copied once into the function-data store, read by every call at `/data/<name>`. */
export interface ICallableFunctionDataPin {
  name: string;
  sha256: string;
  bytes: number;
  /** The FabFile the bytes were copied from; later changes to it never reach the copy. */
  sourceFileId: string;
  pinnedAt: Date;
}

/** A safe file name: no path separator, no leading dot, at most 64 characters. */
export const CALLABLE_FUNCTION_DATA_PIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const CALLABLE_FUNCTION_DATA_LIMITS = {
  /** Data files per function; sources have their own count in `maxSources`, and both share one name space. */
  maxPins: 10,
  maxSources: 10,
  /** Defaults of the `CallableFunctionDataFileMaxMb` and `CallableFunctionDataTotalMaxMb` settings. */
  defaultFileMb: 100,
  defaultTotalMb: 1024,
  /** The runtime's data cache, and so the most `CallableFunctionDataTotalMaxMb` can allow. */
  cacheMb: 9216,
} as const;

export interface ICallableFunction {
  ownerType: CallableFunctionOwnerType;
  /** The owner's userId; slugs and artifacts are unique per (ownerType, ownerKey). */
  ownerKey: string;
  userId: string;
  /** `contract.name`, fixed at create. */
  slug: string;
  description: string;
  state: CallableFunctionState;
  enabled: boolean;
  /** When chat and agent runs ask before a call, as for a connector tool; unset reads as `default`. */
  approval?: McpToolApprovalMode;
  pin: ICallableFunctionPin;
  /** Display data only: every call reads `FUNCTION` from the code again. */
  contract: FunctionContract;
  examples?: CallableFunctionExample[];
  trustLabel?: CallableFunctionPromotionTrustLabel;
  /**
   * Set and cleared only through the admin route. Any write that returns the function to draft or leaves it
   * `unverified` drops it, so a re-promotion never brings it back.
   */
  platform?: CallableFunctionPlatformMark;
  lastServerRun?: CallableFunctionServerRun;
  promoted?: CallableFunctionPromotion;
  caseResults?: CallableFunctionCaseResults;
  grants?: ICallableFunctionGrants;
  /** Outside the code and the review hash; changed only through `setSources`, which returns the function to draft. */
  sources?: ICallableFunctionSource[];
}

export interface ICallableFunctionDocument extends ICallableFunction, IMongoDocument {}

/** The list read: no contract, pinned code, server run, promotion record, or case results. */
export type ICallableFunctionSummary = Omit<
  ICallableFunctionDocument,
  'contract' | 'pin' | 'lastServerRun' | 'promoted' | 'caseResults'
> & {
  pin: Omit<ICallableFunctionPin, 'source'>;
};

/** How many live functions one chat or agent turn offers, oldest first; connectors keep the rest of the tool budget. */
export const MAX_CALLABLE_FUNCTIONS_PER_TURN = 20;

/** The read chat offers from: the contract without the pinned code, server run, promotion record, or case results. */
export type ICallableFunctionOfferable = Omit<
  ICallableFunctionDocument,
  'pin' | 'lastServerRun' | 'promoted' | 'caseResults'
> & {
  pin: Omit<ICallableFunctionPin, 'source'>;
};

/** The artifact's current version and deletion, read beside a function; null when the artifact is gone. */
export interface CallableFunctionHead {
  version: number;
  deletedAt?: Date | null;
}

export interface ICallableFunctionPublic {
  id: string;
  slug: string;
  description: string;
  status: CallableFunctionStatus;
  state: CallableFunctionState;
  enabled: boolean;
  approval: McpToolApprovalMode;
  pin: Pick<ICallableFunctionPin, 'artifactId' | 'version' | 'contentHash' | 'pinnedAt' | 'seq'>;
  dataPins: Pick<ICallableFunctionDataPin, 'name' | 'sha256' | 'bytes' | 'pinnedAt'>[];
  /** Each declared source, with what promotion froze for a `pinned` one. */
  sources: (ICallableFunctionSource & { pinned?: Omit<ICallableFunctionSourcePin, 'name'> })[];
  latestVersion: number | null;
  /** The artifact has a newer version than the pinned one. */
  updateAvailable: boolean;
  /** Null unless the function is live. */
  trustLabel: CallableFunctionTrustLabel | null;
  examples: CallableFunctionExample[];
  grants: ICallableFunctionGrants | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The list read plus the contract and the last promotion, for a recipient's review: still no pinned code. */
export type ICallableFunctionSharedSource = ICallableFunctionSummary &
  Pick<ICallableFunctionDocument, 'contract' | 'promoted'>;

type RecipientReadable = Pick<
  ICallableFunction,
  'state' | 'contract' | 'description' | 'trustLabel' | 'sources' | 'promoted'
> & { pin: Omit<ICallableFunctionPin, 'source'> };

/**
 * The label every surface shows: null unless live, and `platform` while an admin's mark stands on a `verified`
 * function. On a recipient's kept promotion it reads that promotion's label beside the record's mark.
 */
export function shownCallableFunctionTrustLabel(
  fn: Pick<ICallableFunction, 'state' | 'trustLabel' | 'platform'>
): CallableFunctionTrustLabel | null {
  if (fn.state !== 'live' || !fn.trustLabel) return null;
  return fn.trustLabel === 'verified' && fn.platform ? 'platform' : fn.trustLabel;
}

/**
 * True only while the record itself is live and shows `platform` with the `signed_in` audience: never on a kept
 * promotion, so an edit that returns the function to draft ends the offer.
 */
export function isOfferedToEverySignedInPerson(
  fn: Partial<Pick<ICallableFunction, 'state' | 'trustLabel' | 'platform'>>
): boolean {
  return fn.state === 'live' && fn.trustLabel === 'verified' && fn.platform?.audience === 'signed_in';
}

/**
 * The version a recipient calls and reviews: the record while live, otherwise the last promotion kept on it, so an
 * owner's edit never takes the function away; null when neither is there.
 */
export function recipientCallableFunction<T extends RecipientReadable>(fn: T): T | null {
  if (fn.state === 'live') return fn;
  const kept = fn.promoted;
  if (!kept?.pin) return null;
  return {
    ...fn,
    state: 'live',
    pin: kept.pin,
    contract: kept.contract,
    description: kept.description ?? kept.contract.description,
    trustLabel: kept.trustLabel,
    sources: kept.sources,
  };
}

/** `pending_review` with no review or one of an earlier interface; `disabled` when the recipient turned it off. */
export type CallableFunctionSharedStatus = 'pending_review' | 'reviewed' | 'disabled';

export function callableFunctionReviewStatus(
  review: Pick<ICallableFunctionReview, 'reviewHash' | 'enabled'> | null,
  reviewHash: string
): CallableFunctionSharedStatus {
  if (!review || review.reviewHash !== reviewHash) return 'pending_review';
  return review.enabled ? 'reviewed' : 'disabled';
}

/**
 * What a recipient reads of a function shared with them: the interface they review, never the code, the artifact,
 * the examples, or the grants.
 */
export interface ICallableFunctionShared {
  id: string;
  slug: string;
  description: string;
  status: CallableFunctionSharedStatus;
  sharedVia: Exclude<CallableFunctionAccess, 'owner'>;
  pin: Pick<ICallableFunctionPin, 'version' | 'seq' | 'pinnedAt'>;
  trustLabel: CallableFunctionTrustLabel | null;
  ownerName: string;
  inputs: FunctionContract['inputs'];
  outputs: FunctionContract['outputs'];
  /** The live pin's interface hash; a review names it, so an interface changed since is not approved unseen. */
  reviewHash: string;
  review: ICallableFunctionReviewView | null;
  /**
   * What changed in the interface since the recipient's review, field by field; empty when the review is current,
   * absent when there is none or it predates keeping the reviewed interface.
   */
  changes?: FunctionContractChange[];
  /**
   * Names only of the data files and sources the live pin reads: never their bytes or a link to them, and no data
   * file names at all for `signed_in`.
   */
  dataPins: string[];
  sources: string[];
  updatedAt: Date;
}

export interface ICallableFunctionDetail extends ICallableFunctionPublic {
  contract: FunctionContract;
  source: string;
  lastServerRun: CallableFunctionServerRun | null;
}

export function effectiveCallableFunctionStatus(
  fn: Pick<ICallableFunction, 'enabled' | 'state'>,
  head: CallableFunctionHead | null
): CallableFunctionStatus {
  // A deleted artifact outranks turned off: the tool can only be deleted, so turning it off must not hide why.
  if (!head || head.deletedAt) return 'source_deleted';
  if (!fn.enabled) return 'disabled';
  return fn.state;
}

/** An allowlist, so a field added to the document later stays server-side until it is named here. */
export function toCallableFunctionPublic(
  doc: ICallableFunctionDocument | ICallableFunctionSummary,
  head: CallableFunctionHead | null
): ICallableFunctionPublic {
  const live = head && !head.deletedAt ? head : null;
  return {
    id: doc.id,
    slug: doc.slug,
    description: doc.description,
    status: effectiveCallableFunctionStatus(doc, head),
    state: doc.state,
    enabled: doc.enabled,
    approval: doc.approval ?? 'default',
    pin: {
      artifactId: doc.pin.artifactId,
      version: doc.pin.version,
      contentHash: doc.pin.contentHash,
      pinnedAt: doc.pin.pinnedAt,
      ...(doc.pin.seq !== undefined ? { seq: doc.pin.seq } : {}),
    },
    dataPins: (doc.pin.dataPins ?? []).map(({ name, sha256, bytes, pinnedAt }) => ({ name, sha256, bytes, pinnedAt })),
    sources: (doc.sources ?? []).map(({ name, url, mode }) => {
      const frozen = mode === 'pinned' ? doc.pin.sourcePins?.find(entry => entry.name === name) : undefined;
      return {
        name,
        url,
        mode,
        ...(frozen ? { pinned: { sha256: frozen.sha256, bytes: frozen.bytes, fetchedAt: frozen.fetchedAt } } : {}),
      };
    }),
    latestVersion: head?.version ?? null,
    updateAvailable: live !== null && live.version > doc.pin.version,
    trustLabel: shownCallableFunctionTrustLabel(doc),
    examples: doc.examples ?? [],
    grants: doc.grants
      ? {
          visibility: doc.grants.visibility,
          ...(doc.grants.projectId ? { projectId: doc.grants.projectId } : {}),
          ...(doc.grants.organizationId ? { organizationId: doc.grants.organizationId } : {}),
          userIds: [...doc.grants.userIds],
        }
      : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** An allowlist, like {@link toCallableFunctionPublic}, for a caller who is not the owner. */
export function toCallableFunctionShared(
  doc: ICallableFunctionDocument | ICallableFunctionSharedSource,
  sharedVia: ICallableFunctionShared['sharedVia'],
  context: {
    ownerName: string;
    reviewHash: string;
    review: ICallableFunctionReview | null;
    changes?: FunctionContractChange[];
  }
): ICallableFunctionShared {
  const { review, reviewHash, changes } = context;
  return {
    id: doc.id,
    slug: doc.slug,
    description: doc.description,
    status: callableFunctionReviewStatus(review, reviewHash),
    sharedVia,
    ownerName: context.ownerName,
    inputs: doc.contract.inputs,
    outputs: doc.contract.outputs,
    reviewHash,
    review: review
      ? {
          approval: review.approval,
          enabled: review.enabled,
          reviewedAt: review.reviewedAt,
          current: review.reviewHash === reviewHash,
        }
      : null,
    ...(changes ? { changes } : {}),
    // The audience reaches anyone signed in, so it shows the interface without naming the owner's data files.
    dataPins: sharedVia === 'signed_in' ? [] : (doc.pin.dataPins ?? []).map(({ name }) => name),
    sources: (doc.sources ?? []).map(({ name }) => name),
    pin: {
      version: doc.pin.version,
      pinnedAt: doc.pin.pinnedAt,
      ...(doc.pin.seq !== undefined ? { seq: doc.pin.seq } : {}),
    },
    trustLabel: shownCallableFunctionTrustLabel(doc),
    updatedAt: doc.updatedAt,
  };
}

export function toCallableFunctionDetail(
  doc: ICallableFunctionDocument,
  head: CallableFunctionHead | null
): ICallableFunctionDetail {
  return {
    ...toCallableFunctionPublic(doc, head),
    contract: doc.contract,
    source: doc.pin.source,
    lastServerRun: doc.lastServerRun ?? null,
  };
}

/** Promotion's label: `verified` only when a worked example ran and passed. */
export function callableFunctionTrustLabel(
  results: Pick<CallableFunctionServerRunCase, 'kind' | 'passed'>[]
): CallableFunctionPromotionTrustLabel {
  return results.some(result => result.kind === 'example' && result.passed) ? 'verified' : 'unverified';
}

/**
 * Top-level fields the generic `update`/`updateGuarded`/`updateMany` refuse. The owner fields never change; the
 * slug, description, pin, and contract move together through `repin`; `pin.seq`, `pin.runtime`, the state, the
 * label, the server run, and the promotion record only through `promote`; the examples only through `setExamples`;
 * the case results only through `recordCaseResults`; the grants only through `setGrants`; the platform mark only
 * through `setPlatformMark`, `setPlatformAudience`, and `clearPlatformMark`.
 */
export const CALLABLE_FUNCTION_PROTECTED_FIELDS = [
  'ownerType',
  'ownerKey',
  'userId',
  'slug',
  'description',
  'pin',
  'contract',
  'state',
  'trustLabel',
  'platform',
  'lastServerRun',
  'promoted',
  'examples',
  'caseResults',
  'grants',
  'sources',
] as const;

export class CallableFunctionProtectedFieldError extends Error {
  constructor(readonly field: string) {
    super(`CallableFunction.${field} cannot be written through a generic update; use the dedicated repository method`);
    this.name = 'CallableFunctionProtectedFieldError';
  }
}

export class CallableFunctionCapError extends ConflictError {
  constructor(readonly limit: number) {
    super(`You can have at most ${limit} saved tools.`, { code: 'function_limit', limit });
    this.name = 'CallableFunctionCapError';
  }
}

/** The owner's function that already holds a name, so the client can offer to replace one whose artifact is gone. */
export interface CallableFunctionSlugHolder {
  functionId: string;
  sourceDeleted: boolean;
}

/** The `callablefn_owner_slug` unique index. */
export class CallableFunctionSlugConflictError extends ConflictError {
  constructor(
    readonly slug: string,
    holder?: CallableFunctionSlugHolder
  ) {
    super(`You already have a tool named ${slug}.`, { code: 'slug_taken', slug, ...holder });
    this.name = 'CallableFunctionSlugConflictError';
  }
}

function breakingChangeMessage(changes: FunctionContractChange[], promotedSeq?: number): string {
  const what = changes
    .map(change => {
      const { subject, field, words } = describeFunctionContractChange(change);
      return [subject, field, words].filter(Boolean).join(' ');
    })
    .join('; ');
  const lead = what ? what.charAt(0).toUpperCase() + what.slice(1) : 'This version changes the contract';
  const since = promotedSeq !== undefined ? ` since promotion ${promotedSeq}` : '';
  return (
    `${lead}${since}, which could break callers of the tool, so it stays on its current version. To keep it as it ` +
    `is and save this version as a new tool, give the function a new name in ${FUNCTION_CONTRACT_GLOBAL}, save the ` +
    'artifact, and select Make this a tool.'
  );
}

/**
 * A repin refused because the new contract could break callers of the pinned one, or of the promoted one when
 * `promotedSeq` is set; `changes` names each change.
 */
export class CallableFunctionBreakingChangeError extends ConflictError {
  constructor(
    readonly changes: FunctionContractChange[],
    readonly promotedSeq?: number
  ) {
    super(breakingChangeMessage(changes, promotedSeq), {
      code: 'breaking_change',
      changes,
      ...(promotedSeq !== undefined ? { promotedSeq } : {}),
    });
    this.name = 'CallableFunctionBreakingChangeError';
  }
}

/** A repin refused because the stored contract does not parse, so it cannot be compared with the new one. */
export class CallableFunctionContractUnreadableError extends ConflictError {
  constructor() {
    super('The saved contract cannot be read; save this version as a new tool.', { code: 'contract_unreadable' });
    this.name = 'CallableFunctionContractUnreadableError';
  }
}

/** A pin as create and repin write it: `seq` and `runtime` come only from promotion. */
export type CallableFunctionNewPin = Omit<ICallableFunctionPin, 'seq' | 'runtime'>;

/** Fields `create` refuses at run time too, so a create is always a draft with nothing promotion writes. */
export const CALLABLE_FUNCTION_CREATE_REFUSED_FIELDS = [
  'state',
  'trustLabel',
  'platform',
  'lastServerRun',
  'promoted',
  'examples',
  'caseResults',
  'sources',
] as const;

export type CallableFunctionCreateInput = Omit<
  ICallableFunctionDocument,
  'id' | 'createdAt' | 'updatedAt' | 'pin' | 'grants' | (typeof CALLABLE_FUNCTION_CREATE_REFUSED_FIELDS)[number]
> & { pin: CallableFunctionNewPin };

export interface CallableFunctionRepin {
  pin: CallableFunctionNewPin;
  contract: FunctionContract;
  description: string;
}

export interface CallableFunctionPromote {
  seq: number;
  runtime: CallableFunctionRuntimePin;
  lastServerRun: CallableFunctionServerRun;
  /** `unverified` also drops the platform mark. */
  trustLabel: CallableFunctionPromotionTrustLabel;
  contract: FunctionContract;
  /** The `pinned` sources as fetched for this promotion. */
  sourcePins: ICallableFunctionSourcePin[];
  /** The pin being promoted and the record fields beside it, kept as `promoted` for recipients. */
  pin: ICallableFunctionPin;
  description: string;
  sources?: ICallableFunctionSource[];
}

export interface ICallableFunctionRepository extends IBaseRepository<ICallableFunctionDocument> {
  /**
   * Creates only if the owner stays within `cap`: inserts, re-counts, and deletes its own insert when over, so
   * racing creates at the boundary may all fail but the cap is never passed. Throws `CallableFunctionCapError` or
   * `CallableFunctionSlugConflictError`.
   */
  createWithinOwnerCap(data: CallableFunctionCreateInput, cap: number): Promise<ICallableFunctionDocument>;
  /** Null for another owner's function and for an id that is not an ObjectId. */
  findByIdForOwner(id: string, owner: CallableFunctionOwner): Promise<ICallableFunctionDocument | null>;
  /** Without the contract and the pinned code. */
  findBySlugForOwner(slug: string, owner: CallableFunctionOwner): Promise<ICallableFunctionSummary | null>;
  /** Oldest first, without the contract and the pinned code. */
  listForOwner(owner: CallableFunctionOwner, filter?: { artifactId?: string }): Promise<ICallableFunctionSummary[]>;
  countForOwner(owner: CallableFunctionOwner): Promise<number>;
  setEnabled(id: string, owner: CallableFunctionOwner, enabled: boolean): Promise<ICallableFunctionDocument | null>;
  setApproval(
    id: string,
    owner: CallableFunctionOwner,
    approval: McpToolApprovalMode
  ): Promise<ICallableFunctionDocument | null>;
  /** Live and turned on, oldest first, without the pinned code; the artifact may still be gone. */
  listLiveForOwner(
    owner: CallableFunctionOwner,
    options?: { limit?: number; excludeAlwaysAsk?: boolean }
  ): Promise<ICallableFunctionOfferable[]>;
  /** Compare-and-set on `pin.version === expectedVersion`; null when stale, missing, or not the owner's. */
  repin(
    id: string,
    owner: CallableFunctionOwner,
    expectedVersion: number,
    update: CallableFunctionRepin
  ): Promise<ICallableFunctionDocument | null>;
  /**
   * Compare-and-set on `updatedAt`, so a promotion cannot land between the read that decided `unverify` and this
   * write. `unverify` sets the label to `unverified` until the next promotion and drops the platform mark.
   */
  setExamples(
    id: string,
    owner: CallableFunctionOwner,
    expected: { updatedAt: Date },
    examples: CallableFunctionExample[],
    options?: { unverify?: boolean }
  ): Promise<ICallableFunctionDocument | null>;
  /**
   * Replaces the case results only while the record is still on `results.pinVersion` and `results.contentHash`, and
   * leaves `updatedAt` alone so a promotion in progress still matches; false when the pin moved.
   */
  recordCaseResults(id: string, owner: CallableFunctionOwner, results: CallableFunctionCaseResults): Promise<boolean>;
  /**
   * Writes `pin.seq`, `pin.runtime`, the server run, the label, the promotion record, and `state: 'live'`, only if
   * the record is unchanged since `expected.updatedAt` was read; null when it changed or is not the owner's.
   */
  promote(
    id: string,
    owner: CallableFunctionOwner,
    expected: { updatedAt: Date },
    update: CallableFunctionPromote
  ): Promise<ICallableFunctionDocument | null>;
  /** Writes the grants of a live function, or removes them when `grants` is null; null when not the owner's. */
  setGrants(
    id: string,
    owner: CallableFunctionOwner,
    grants: ICallableFunctionGrants | null
  ): Promise<ICallableFunctionDocument | null>;
  /**
   * Live, turned-on functions of other owners whose grants name `userId` or one of the projects or organizations,
   * with the contract and without the pinned code. The caller still checks each with `canCallFunction`.
   */
  listSharedWith(reach: {
    userId: string;
    projectIds: string[];
    organizationIds: string[];
  }): Promise<ICallableFunctionSharedSource[]>;
  /**
   * Replaces `pin.dataPins` only if the record is unchanged since `expected.updatedAt`, and returns the function to
   * draft as a repin does, since the files it promoted with changed; null when it changed or is not the owner's.
   */
  setDataPins(
    id: string,
    owner: CallableFunctionOwner,
    expected: { updatedAt: Date },
    dataPins: ICallableFunctionDataPin[]
  ): Promise<ICallableFunctionDocument | null>;
  /** Replaces `sources` and drops what promotion froze, returning the function to draft as `setDataPins` does. */
  setSources(
    id: string,
    owner: CallableFunctionOwner,
    expected: { updatedAt: Date },
    sources: ICallableFunctionSource[]
  ): Promise<ICallableFunctionDocument | null>;
  /**
   * Admin only, so no owner filter: marks the function only while it is live and `verified` at the moment of the
   * write; null otherwise.
   */
  setPlatformMark(id: string, mark: CallableFunctionPlatformMark): Promise<ICallableFunctionDocument | null>;
  /** Admin only: removes the mark; null when there was none. */
  clearPlatformMark(id: string): Promise<ICallableFunctionDocument | null>;
  /**
   * Admin only: sets or, with null, removes the mark's audience. Setting needs the mark on a live, `verified`
   * function at the moment of the write; null when that fails or there is no audience to remove.
   */
  setPlatformAudience(
    id: string,
    audience: CallableFunctionPlatformAudience | null
  ): Promise<ICallableFunctionDocument | null>;
  deleteForOwner(id: string, owner: CallableFunctionOwner): Promise<boolean>;
}
