import { ConflictError } from '../../errors';
import type { FunctionContract } from '../../schemas/functionContract';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * A Python artifact saved as a callable function: its code copied at one version, with the `FUNCTION` contract the
 * owner's browser read from it. Only the owner can see or call it. API responses go through
 * {@link toCallableFunctionPublic} or {@link toCallableFunctionDetail}.
 */

export const CALLABLE_FUNCTION_OWNER_TYPES = ['user'] as const;
export type CallableFunctionOwnerType = (typeof CALLABLE_FUNCTION_OWNER_TYPES)[number];

/** `live` is reserved for promotion and not written yet. Turning a function off is `enabled`, not a state. */
export const CALLABLE_FUNCTION_STATES = ['draft', 'live'] as const;
export type CallableFunctionState = (typeof CALLABLE_FUNCTION_STATES)[number];

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
}

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
  pin: ICallableFunctionPin;
  /** Display data only: every call reads `FUNCTION` from the code again. */
  contract: FunctionContract;
}

export interface ICallableFunctionDocument extends ICallableFunction, IMongoDocument {}

/** The list read: no contract and no pinned code. */
export type ICallableFunctionSummary = Omit<ICallableFunctionDocument, 'contract' | 'pin'> & {
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
  pin: Omit<ICallableFunctionPin, 'source'>;
  latestVersion: number | null;
  /** The artifact has a newer version than the pinned one. */
  updateAvailable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICallableFunctionDetail extends ICallableFunctionPublic {
  contract: FunctionContract;
  source: string;
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
    pin: {
      artifactId: doc.pin.artifactId,
      version: doc.pin.version,
      contentHash: doc.pin.contentHash,
      pinnedAt: doc.pin.pinnedAt,
    },
    latestVersion: head?.version ?? null,
    updateAvailable: live !== null && live.version > doc.pin.version,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function toCallableFunctionDetail(
  doc: ICallableFunctionDocument,
  head: CallableFunctionHead | null
): ICallableFunctionDetail {
  return { ...toCallableFunctionPublic(doc, head), contract: doc.contract, source: doc.pin.source };
}

/**
 * Top-level fields the generic `update`/`updateGuarded`/`updateMany` refuse. The owner fields never change; the
 * slug, description, pin, and contract move together through `repin`.
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

/** The `callablefn_owner_artifact` unique index: one function per artifact per owner. */
export class CallableFunctionArtifactConflictError extends ConflictError {
  constructor(readonly artifactId: string) {
    super('This artifact is already saved as a tool.', { code: 'artifact_has_function', artifactId });
    this.name = 'CallableFunctionArtifactConflictError';
  }
}

export type CallableFunctionCreateInput = Omit<ICallableFunctionDocument, 'id' | 'createdAt' | 'updatedAt'>;

export interface CallableFunctionRepin {
  pin: ICallableFunctionPin;
  contract: FunctionContract;
  description: string;
}

export interface ICallableFunctionRepository extends IBaseRepository<ICallableFunctionDocument> {
  /**
   * Creates only if the owner stays within `cap`: inserts, re-counts, and deletes its own insert when over, so
   * racing creates at the boundary may all fail but the cap is never passed. Throws `CallableFunctionCapError`,
   * `CallableFunctionSlugConflictError`, or `CallableFunctionArtifactConflictError`.
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
  /** Compare-and-set on `pin.version === expectedVersion`; null when stale, missing, or not the owner's. */
  repin(
    id: string,
    owner: CallableFunctionOwner,
    expectedVersion: number,
    update: CallableFunctionRepin
  ): Promise<ICallableFunctionDocument | null>;
  deleteForOwner(id: string, owner: CallableFunctionOwner): Promise<boolean>;
}
