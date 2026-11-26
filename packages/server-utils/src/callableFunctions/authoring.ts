import { BadRequestError, ConflictError, NotFoundError, type ICallableFunctionDetail } from '@bike4mind/common';
import { callableFunctionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { artifactService } from '@bike4mind/services';
import { ARTIFACT_DB, hideArtifactDenial } from '../artifacts/artifactAccess';
import {
  assertCallableFunctionRepinnable,
  checkCallableFunctionCode,
  createCallableFunction,
  getCallableFunction,
  repinCallableFunction,
  type CallableFunctionActor,
} from './registry';

/*
 * Authoring from code alone, for a caller with no artifact editor (the public API). Each writes the code as a version
 * of the owner's own Python artifact and then pins it through the registry, the two steps the app takes. The code
 * checks run before the write, so a refused save leaves no artifact or version behind.
 */

export interface CallableFunctionCodeInput {
  code: string;
  /** The caller's read of `FUNCTION` in `code`, checked as the app's pin checks it. */
  contract: unknown;
}

// The artifact is filed under no session, quest, or parent, so a request naming one is refused.
const noSourceRefs: artifactService.ArtifactSourceRefsGuard = async (_userId, refs) => {
  if (refs.sessionId || refs.sourceQuestId || refs.parentArtifactId) {
    throw new BadRequestError('A function saved from code is filed under no session.');
  }
};

/** A new Python artifact holding `code`, pinned as a draft. */
export async function createCallableFunctionFromCode(
  actor: CallableFunctionActor,
  input: CallableFunctionCodeInput
): Promise<ICallableFunctionDetail> {
  const contract = checkCallableFunctionCode(input.code, input.contract);
  const { artifact } = await artifactService.create(
    actor.id,
    { type: 'python', title: contract.name, content: input.code, visibility: 'private', tags: [], metadata: {} },
    { assertSourceRefsAccessible: noSourceRefs, db: ARTIFACT_DB }
  );
  try {
    const created = await createCallableFunction(actor, {
      artifactId: artifact.id,
      expectedVersion: artifact.version,
      contract: input.contract,
    });
    return await getCallableFunction(actor, created.id);
  } catch (error) {
    // A refused create (a taken name, the owner's cap) leaves no artifact the caller never asked for.
    await artifactService
      .delete(actor.id, { id: artifact.id, hardDelete: false }, { db: ARTIFACT_DB })
      .catch((cleanup: Error) => {
        Logger.warn('[callableFunctions] artifact of a refused create not removed', {
          artifactId: artifact.id,
          message: cleanup.message,
        });
      });
    throw error;
  }
}

/**
 * Writes `code` as a new version of the function's artifact and moves the pin to it, returning the function to draft.
 * `pinVersion` is the pin the caller saw: a function moved since is refused as `version_changed`.
 */
export async function saveCallableFunctionCode(
  actor: CallableFunctionActor,
  id: string,
  input: CallableFunctionCodeInput & { pinVersion: number }
): Promise<ICallableFunctionDetail> {
  const current = await callableFunctionRepository.findByIdForOwner(id, { ownerType: 'user', ownerKey: actor.id });
  if (!current) throw new NotFoundError('Tool not found');
  if (current.pin.version !== input.pinVersion) {
    throw new ConflictError('The tool changed since you opened it. Reload it and try again.', {
      code: 'version_changed',
      version: current.pin.version,
    });
  }
  const contract = checkCallableFunctionCode(input.code, input.contract);
  assertCallableFunctionRepinnable(current, contract);
  const { artifact } = await hideArtifactDenial(
    artifactService.update(
      actor.id,
      { id: current.pin.artifactId, content: input.code, createNewVersion: true },
      { db: ARTIFACT_DB }
    )
  );
  await repinCallableFunction(actor, id, { expectedVersion: artifact.version, contract: input.contract });
  return getCallableFunction(actor, id);
}
