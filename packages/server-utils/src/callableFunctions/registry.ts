import {
  BadRequestError,
  CALLABLE_FUNCTION_EXAMPLE_LIMITS,
  CALLABLE_FUNCTION_LIMITS,
  CALLABLE_FUNCTION_SLUG_PATTERN,
  CallableFunctionBreakingChangeError,
  CallableFunctionContractUnreadableError,
  CallableFunctionSlugConflictError,
  ConflictError,
  FUNCTION_CONTRACT_LIMITS,
  NotFoundError,
  calculateContentHash,
  canonicalJson,
  calculateContentSize,
  diffFunctionContracts,
  effectiveCallableFunctionStatus,
  hasFunctionEntryPoint,
  parseFunctionContract,
  toCallableFunctionDetail,
  toCallableFunctionPublic,
  type CallableFunctionCallSummary,
  type CallableFunctionExample,
  type CallableFunctionHead,
  type CallableFunctionOwner,
  type FunctionContract,
  type FunctionContractProblem,
  type ICallableFunctionDetail,
  type ICallableFunctionOfferable,
  type ICallableFunctionPin,
  type ICallableFunctionPublic,
  type McpToolApprovalMode,
} from '@bike4mind/common';
import {
  artifactContentRepository,
  artifactRepository,
  callableFunctionCallRepository,
  callableFunctionRepository,
  callableFunctionReviewRepository,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { deleteCallableFunctionDataObjects, type CallableFunctionDataStorage } from './dataPins';

/**
 * Saved callable functions behind pages/api/callable-functions/**. Every operation is owner-scoped: another
 * person's function or artifact reads as not found. The routes check `assertCallableFunctionsEnabled` first.
 */

// The size refusal of `parseFunctionContract` (b4m-core/common/src/schemas/functionContract.ts).
const CONTRACT_SIZE_PROBLEM = /^FUNCTION is \d+ bytes/;

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
  // Promotion refuses a contract that breaks the promoted one, so such a pin could never be promoted again.
  const diff = diffFunctionContracts(current.promoted?.contract ?? current.contract, contract);
  if (!diff) throw new CallableFunctionContractUnreadableError();
  if (diff.breaking.length > 0) {
    throw new CallableFunctionBreakingChangeError(diff.breaking, current.promoted?.seq);
  }
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

export async function setCallableFunctionApproval(
  actor: CallableFunctionActor,
  id: string,
  approval: McpToolApprovalMode
): Promise<ICallableFunctionPublic> {
  const fn = await callableFunctionRepository.setApproval(id, userOwner(actor), approval);
  if (!fn) throw notFound();
  return toCallableFunctionPublic(fn, await readHead(actor, fn.pin.artifactId));
}

/** The actor's functions chat may offer: live, turned on, and with their artifact still in place. */
export async function listOfferedCallableFunctions(
  actor: CallableFunctionActor,
  options: { limit?: number; excludeAlwaysAsk?: boolean } = {}
): Promise<ICallableFunctionOfferable[]> {
  const { limit, excludeAlwaysAsk } = options;
  const functions = await callableFunctionRepository.listLiveForOwner(userOwner(actor), { excludeAlwaysAsk });
  const heads = await readHeads(
    actor,
    functions.map(fn => fn.pin.artifactId)
  );
  const live = functions.filter(
    fn => effectiveCallableFunctionStatus(fn, heads.get(fn.pin.artifactId) ?? null) === 'live'
  );
  // After the head filter, so a function whose artifact is gone never takes one of the `limit` slots.
  return limit ? live.slice(0, limit) : live;
}

/**
 * Replaces the owner's worked examples, each checked against the stored contract the way declared tests are. A live
 * tool whose examples change is `unverified` until the next promotion.
 */
export async function setCallableFunctionExamples(
  actor: CallableFunctionActor,
  id: string,
  examples: CallableFunctionExample[]
): Promise<ICallableFunctionPublic> {
  const owner = userOwner(actor);
  const current = await callableFunctionRepository.findByIdForOwner(id, owner);
  if (!current) throw notFound();
  const { maxExamples, maxCitationLength } = CALLABLE_FUNCTION_EXAMPLE_LIMITS;
  if (examples.length > maxExamples) {
    throw new BadRequestError(`At most ${maxExamples} worked examples are allowed.`, { code: 'too_many_examples' });
  }
  const problems: FunctionContractProblem[] = [];
  examples.forEach((example, index) => {
    const citation = example.citation.trim();
    if (!citation || citation.length > maxCitationLength) {
      problems.push({
        path: `examples.${index}.citation`,
        message: `must name a source a reader can check, in at most ${maxCitationLength} characters`,
      });
    }
  });
  // Checked as declared tests of the stored contract, so an example obeys the same rules as a test in the code.
  const cases = examples.map(({ name, input, expected, tolerance }) => ({
    name,
    input,
    expected,
    ...(tolerance ? { tolerance } : {}),
  }));
  const parsed = parseFunctionContract({ ...current.contract, tests: cases });
  if (!parsed.ok) {
    for (const problem of parsed.problems) {
      if (problem.path === '' && CONTRACT_SIZE_PROBLEM.test(problem.message)) {
        problems.push({
          path: 'examples',
          message: `together with the contract must fit in ${FUNCTION_CONTRACT_LIMITS.maxContractBytes} bytes; shorten or remove an example`,
        });
        continue;
      }
      const path = problem.path.startsWith('tests') ? `examples${problem.path.slice(5)}` : problem.path;
      problems.push({ ...problem, path });
    }
  }
  if (problems.length > 0) {
    throw new BadRequestError('The worked examples have problems.', { code: 'invalid_examples', problems });
  }
  const next = examples.map(example => ({ ...example, citation: example.citation.trim() }));
  // A live tool's label stands for the examples it was promoted with; changed ones have not run on the server.
  const unverify = current.state === 'live' && canonicalJson(next) !== canonicalJson(current.examples ?? []);
  const saved = await callableFunctionRepository.setExamples(id, owner, { updatedAt: current.updatedAt }, next, {
    unverify,
  });
  if (!saved) {
    throw new ConflictError('The tool changed since you opened it. Reload it and try again.', {
      code: 'version_changed',
    });
  }
  return toCallableFunctionPublic(saved, await readHead(actor, saved.pin.artifactId));
}

export const CALLABLE_FUNCTION_CALLS_WINDOW_DAYS = 30;
const RECENT_CALLS = 5;

/**
 * Calls of the owner's function over the last 30 days, theirs and its recipients': counts by outcome and the latest
 * few, each marked when a recipient made it.
 */
export async function summarizeCallableFunctionCalls(
  actor: CallableFunctionActor,
  id: string,
  now: Date = new Date()
): Promise<CallableFunctionCallSummary> {
  const fn = await callableFunctionRepository.findByIdForOwner(id, userOwner(actor));
  if (!fn) throw notFound();
  const since = new Date(now.getTime() - CALLABLE_FUNCTION_CALLS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return callableFunctionCallRepository.summarizeForOwner(fn.id, actor.id, since, RECENT_CALLS);
}

/**
 * The pinned code, data files, and recipients' reviews go with the record; the artifact and the files the data came
 * from are not touched.
 */
export async function deleteCallableFunction(
  actor: CallableFunctionActor,
  id: string,
  storage?: CallableFunctionDataStorage
): Promise<void> {
  const fn = await callableFunctionRepository.findByIdForOwner(id, userOwner(actor));
  if (!fn) throw notFound();
  // The objects first: a record left behind by a failed delete can be deleted again, an object without one cannot.
  // Always, pins or not: a lost pin race, a failed unpin delete, or a removed source leaves objects no pin names.
  await deleteCallableFunctionDataObjects(fn.id, storage);
  if (!(await callableFunctionRepository.deleteForOwner(id, userOwner(actor)))) throw notFound();
  await callableFunctionReviewRepository.deleteForFunction(id);
}
