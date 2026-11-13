import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { BadRequestError } from '@bike4mind/common';
import {
  validateLoopBudget,
  validateLoopGoal,
  validateLoopMaxConcurrent,
  validateLoopModel,
  validateLoopName,
  validateLoopStageConfig,
  validateLoopStages,
} from '@bike4mind/common/loops';
import type { LocalLoop, LocalLoopStageConfig, UpdateLocalLoopRequest } from '@shared/localLoops';

/** The stage overrides a Desktop loop keeps: no `runner` (every stage runs here), tools or repo hint. */
function stageConfigOf(value: unknown, stages: string[]): LocalLoopStageConfig[] {
  return (validateLoopStageConfig(value ?? [], stages) ?? []).map(
    ({ runner: _runner, tools: _tools, repoHint: _repoHint, ...entry }) => entry
  );
}

/** undefined leaves the field as is, null clears it (an undefined value is dropped when the loop is stored). */
const optional = <T, R>(value: T | null | undefined, check: (value: T) => R): { value?: R } | undefined =>
  value === undefined ? undefined : { value: value === null ? undefined : check(value) };

/**
 * A loop request's fields, validated. `picked` holds the folders the owner chose in the native picker
 * (localloops:pick-folder): a directory is taken only from there, never as a path the renderer typed.
 */
export function checkedFields(
  request: Omit<UpdateLocalLoopRequest, 'id'>,
  current: LocalLoop | undefined,
  picked: ReadonlySet<string>
): Partial<LocalLoop> {
  const escalationModel = optional(request.escalationModel, validateLoopModel);
  const fallbackModel = optional(request.fallbackModel, validateLoopModel);
  const budgetCreditsPerDay = optional(request.budgetCreditsPerDay, validateLoopBudget);
  const p2RunsPerDay = optional(request.p2RunsPerDay, runs => runs);
  const stages = request.stages !== undefined ? validateLoopStages(request.stages) : current?.stages;
  if (request.directory !== undefined && request.directory !== current?.directory && !picked.has(request.directory))
    throw new BadRequestError('Choose the folder with Choose folder.');
  if (
    request.directory !== undefined &&
    !(isAbsolute(request.directory) && existsSync(join(request.directory, '.git')))
  )
    throw new BadRequestError('Pick a local git checkout.');
  return {
    ...(request.name !== undefined && { name: validateLoopName(request.name) }),
    ...(request.goal !== undefined && { goal: validateLoopGoal(request.goal) }),
    ...(stages && { stages }),
    ...((request.stageConfig !== undefined || request.stages !== undefined) && {
      stageConfig: stageConfigOf(request.stageConfig ?? current?.stageConfig, stages ?? []),
    }),
    ...(request.model !== undefined && { model: validateLoopModel(request.model) }),
    ...(escalationModel && { escalationModel: escalationModel.value }),
    ...(fallbackModel && { fallbackModel: fallbackModel.value }),
    ...(request.maxConcurrent !== undefined && { maxConcurrent: validateLoopMaxConcurrent(request.maxConcurrent) }),
    ...(budgetCreditsPerDay && { budgetCreditsPerDay: budgetCreditsPerDay.value }),
    ...(p2RunsPerDay && { p2RunsPerDay: p2RunsPerDay.value }),
    ...(request.directory !== undefined && { directory: request.directory }),
    ...(request.approvalMode !== undefined && { approvalMode: request.approvalMode }),
    ...(request.mirror !== undefined && { mirror: request.mirror }),
  };
}
