import {
  BadRequestError,
  CALLABLE_FUNCTION_LIMITS,
  CALLABLE_FUNCTION_SLUG_PATTERN,
  CallableFunctionBreakingChangeError,
  CallableFunctionContractUnreadableError,
  CallableFunctionSlugConflictError,
  ConflictError,
  NotFoundError,
  calculateContentHash,
  calculateContentSize,
  diffFunctionContracts,
  effectiveCallableFunctionStatus,
  hasFunctionEntryPoint,
  parseFunctionContract,
  toCallableFunctionDetail,
  toCallableFunctionPublic,
  type CallableFunctionHead,
  type CallableFunctionOwner,
  type FunctionContract,
  type ICallableFunctionDetail,
  type ICallableFunctionPin,
  type ICallableFunctionPublic,
} from '@bike4mind/common';
import { artifactContentRepository, artifactRepository, callableFunctionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';

/**
 * Saved callable functions behind pages/api/callable-functions/**. Every operation is owner-scoped: another
 * person's function or artifact reads as not found. The routes check `assertCallableFunctionsEnabled` first.
 */

export interface CallableFunctionActor {
  id: string;
}

export interface CallableFunctionPinInput {
  /** The artifact version the caller saw: a precondition only, since the server pins the artifact's head. */
  expectedVersion: number;
  /** The caller's read of `FUNCTION`, checked with `parseFunctionContract`. */
  contract: unknown;
}

const userOwner = (actor: CallableFunctionActor): CallableFunctionOwner => ({ ownerType: 'user', ownerKey: actor.id });

const notFound = () => new NotFoundError('Tool not found');

interface ArtifactPin {
  pin: ICallableFunctionPin;
  contract: FunctionContract;
  head: CallableFunctionHead;
}

/** Reads the artifact's current version and checks it can be pinned, in the order the routes' errors are listed. */
async function readArtifactPin(
  actor: CallableFunctionActor,
  artifactId: string,
  expectedVersion: number,
  rawContract: unknown
): Promise<ArtifactPin> {
  // A collaborator with write access is refused too: a function copies the code into its owner's account.
  const artifact = await artifactRepository.findOne({ id: artifactId });
  if (!artifact || artifact.deletedAt || artifact.userId !== actor.id) throw new NotFoundError('Artifact not found');
  if (artifact.type !== 'python') {
    throw new BadRequestError('Only a Python artifact can be saved as a tool.', { code: 'not_python' });
  }
  if (artifact.version !== expectedVersion) {
    throw new ConflictError('The artifact changed since you opened it. Reload it and try again.', {
      code: 'version_changed',
      version: artifact.version,
    });
  }

  const row = await artifactContentRepository.findByArtifactAndVersion(artifact.id, artifact.version);
  if (!row) throw new NotFoundError('Artifact version not found');
  const contentHash = calculateContentHash(row.content);
  if (contentHash !== row.contentHash) {
    Logger.warn('[callableFunctions] Stored artifact content does not match its hash', {
      artifactId: artifact.id,
      version: artifact.version,
    });
    throw new ConflictError('The saved code could not be verified.', { code: 'hash_mismatch' });
  }
  if (calculateContentSize(row.content) > CALLABLE_FUNCTION_LIMITS.maxSourceBytes) {
    throw new BadRequestError(`The code is larger than ${CALLABLE_FUNCTION_LIMITS.maxSourceBytes / 1024} KB.`, {
      code: 'source_too_large',
    });
  }
  if (!hasFunctionEntryPoint(row.content)) {
    throw new BadRequestError('The saved code has no FUNCTION contract and run function.', { code: 'no_entry_point' });
  }

  const parsed = parseFunctionContract(rawContract);
  if (!parsed.ok) {
    throw new BadRequestError('The function contract has problems.', {
      code: 'invalid_contract',
      problems: parsed.problems,
    });
  }
  if (!CALLABLE_FUNCTION_SLUG_PATTERN.test(parsed.contract.name)) {
    throw new BadRequestError('A function name cannot contain two underscores in a row or end with an underscore.', {
      code: 'invalid_name',
    });
  }

  return {
    pin: { artifactId: artifact.id, version: artifact.version, contentHash, source: row.content, pinnedAt: new Date() },
    contract: parsed.contract,
    head: { version: artifact.version, deletedAt: null },
  };
}

/**
 * The current version of each artifact the actor still owns, in one read. An artifact that is gone, or that now
 * belongs to someone else, has no head, so its function reads as `source_deleted`.
 */
async function readHeads(
  actor: CallableFunctionActor,
  artifactIds: string[]
): Promise<Map<string, CallableFunctionHead>> {
  if (artifactIds.length === 0) return new Map();
  const artifacts = await artifactRepository.find(
    { id: { $in: [...new Set(artifactIds)] }, userId: actor.id },
    { id: 1, version: 1, deletedAt: 1 }
  );
  return new Map(
    artifacts.map(artifact => [artifact.id, { version: artifact.version, deletedAt: artifact.deletedAt }])
  );
}

async function readHead(actor: CallableFunctionActor, artifactId: string): Promise<CallableFunctionHead | null> {
  return (await readHeads(actor, [artifactId])).get(artifactId) ?? null;
}

/**
 * Names the function holding `slug`, and whether its artifact is gone, so the client can offer to replace a tool
 * that can no longer be opened from its artifact. Names are unique per owner, so the holder is the actor's own.
 */
async function slugTakenError(
  actor: CallableFunctionActor,
  error: CallableFunctionSlugConflictError
): Promise<CallableFunctionSlugConflictError> {
  const holder = await callableFunctionRepository.findBySlugForOwner(error.slug, userOwner(actor));
  if (!holder) return error;
  const status = effectiveCallableFunctionStatus(holder, await readHead(actor, holder.pin.artifactId));
  return new CallableFunctionSlugConflictError(error.slug, {
    functionId: holder.id,
    sourceDeleted: status === 'source_deleted',
  });
}

/** Pins the artifact's current version as a draft. */
export async function createCallableFunction(
  actor: CallableFunctionActor,
  input: CallableFunctionPinInput & { artifactId: string }
): Promise<ICallableFunctionPublic> {
  const { pin, contract, head } = await readArtifactPin(actor, input.artifactId, input.expectedVersion, input.contract);
  try {
    const created = await callableFunctionRepository.createWithinOwnerCap(
      {
        ...userOwner(actor),
        userId: actor.id,
        slug: contract.name,
        description: contract.description,
        state: 'draft',
        enabled: true,
        pin,
        contract,
      },
      CALLABLE_FUNCTION_LIMITS.maxPerOwner
    );
    return toCallableFunctionPublic(created, head);
  } catch (error) {
    if (error instanceof CallableFunctionSlugConflictError) throw await slugTakenError(actor, error);
    throw error;
  }
}

export async function listCallableFunctions(
  actor: CallableFunctionActor,
  filter: { artifactId?: string } = {}
): Promise<ICallableFunctionPublic[]> {
  const functions = await callableFunctionRepository.listForOwner(userOwner(actor), filter);
  const heads = await readHeads(
    actor,
    functions.map(fn => fn.pin.artifactId)
  );
  return functions.map(fn => toCallableFunctionPublic(fn, heads.get(fn.pin.artifactId) ?? null));
}

export async function getCallableFunction(actor: CallableFunctionActor, id: string): Promise<ICallableFunctionDetail> {
  const fn = await callableFunctionRepository.findByIdForOwner(id, userOwner(actor));
  if (!fn) throw notFound();
  return toCallableFunctionDetail(fn, await readHead(actor, fn.pin.artifactId));
}

/**
 * Moves the pin to the artifact's current version. The name is fixed at create, so a renamed contract is refused, as
 * is one that could break callers of the pinned contract (`diffFunctionContracts`).
 */
export async function repinCallableFunction(
  actor: CallableFunctionActor,
  id: string,
  input: CallableFunctionPinInput
): Promise<ICallableFunctionPublic> {
  const owner = userOwner(actor);
  const current = await callableFunctionRepository.findByIdForOwner(id, owner);
  if (!current) throw notFound();
  const { pin, contract, head } = await readArtifactPin(
    actor,
    current.pin.artifactId,
    input.expectedVersion,
    input.contract
  );
  if (contract.name !== current.slug) {
    throw new ConflictError(
      `The function name in the code changed from ${current.slug} to ${contract.name}. Save this version as a new tool under the new name.`,
      { code: 'name_changed' }
    );
  }
  const diff = diffFunctionContracts(current.contract, contract);
  if (!diff) throw new CallableFunctionContractUnreadableError();
  if (diff.breaking.length > 0) throw new CallableFunctionBreakingChangeError(diff.breaking);
  const repinned = await callableFunctionRepository.repin(id, owner, current.pin.version, {
    pin,
    contract,
    description: contract.description,
  });
  // Another update moved the pin between the read and this write.
  if (!repinned) {
    throw new ConflictError('The tool changed since you opened it. Reload it and try again.', {
      code: 'version_changed',
    });
  }
  return toCallableFunctionPublic(repinned, head);
}

export async function setCallableFunctionEnabled(
  actor: CallableFunctionActor,
  id: string,
  enabled: boolean
): Promise<ICallableFunctionPublic> {
  const fn = await callableFunctionRepository.setEnabled(id, userOwner(actor), enabled);
  if (!fn) throw notFound();
  return toCallableFunctionPublic(fn, await readHead(actor, fn.pin.artifactId));
}

/** The pinned code goes with the record; the artifact is not touched. */
export async function deleteCallableFunction(actor: CallableFunctionActor, id: string): Promise<void> {
  if (!(await callableFunctionRepository.deleteForOwner(id, userOwner(actor)))) throw notFound();
}
