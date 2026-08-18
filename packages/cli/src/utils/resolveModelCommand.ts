import type { ModelInfo } from '@bike4mind/common';
import { matchModel } from './matchModel';

export type ModelCommandResult =
  | { kind: 'no-models' }
  | { kind: 'open-picker' }
  | { kind: 'no-match'; query: string }
  | { kind: 'ambiguous'; models: ModelInfo[] }
  | { kind: 'already-current'; model: ModelInfo }
  | { kind: 'switch'; model: ModelInfo };

/**
 * Pure decision layer for the `/model` command: resolve the raw arg list plus
 * the live current-model id into exactly one outcome, so the side-effecting
 * dispatcher stays trivial and every argument/noop/ambiguity path is unit
 * testable without the Ink runtime.
 *
 * `currentModel` MUST be the live session model, not the config snapshot: they
 * legitimately diverge (fresh sessions and `--resume` set session.model
 * independently of config.defaultModel), and comparing against the stale config
 * is what let `/model X` report "Switched" while nothing actually changed.
 */
export function resolveModelCommand(
  models: ModelInfo[],
  args: string[],
  currentModel: string | undefined
): ModelCommandResult {
  if (models.length === 0) return { kind: 'no-models' };
  if (args.length === 0) return { kind: 'open-picker' };

  const query = args.join(' ');
  const match = matchModel(models, query);
  if (match.kind === 'none') return { kind: 'no-match', query };
  if (match.kind === 'multiple') return { kind: 'ambiguous', models: match.models };

  if (match.model.id === currentModel) return { kind: 'already-current', model: match.model };
  return { kind: 'switch', model: match.model };
}
