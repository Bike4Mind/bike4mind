import { z } from 'zod';

/**
 * Per-node failure policy.
 *
 * `cascade`: if this node fails, all transitive dependents are marked
 * `cascade_failed` and skipped. (Default.)
 *
 * `isolate`: if this node fails, dependents proceed; their dependency
 * context for this node is null/missing. Used for fan-out research nodes
 * where one branch failing shouldn't poison the synthesis.
 */
export const FailurePolicySchema = z.enum(['cascade', 'isolate']);
export type FailurePolicy = z.infer<typeof FailurePolicySchema>;

export const DecomposedTaskSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  agentType: z.enum(['explore', 'plan', 'general-purpose', 'review', 'test']),
  dependsOn: z.array(z.string()).default([]),
  onFailure: FailurePolicySchema.default('cascade'),
});

/**
 * Explicit shape rather than `z.infer<typeof DecomposedTaskSchema>` so the
 * inferred type is stable across zod versions and structurally compatible
 * with `interface PipelineTask extends DecomposedTask`. zod's inference for
 * `.default(...)` fields drifted between v3 and v4 and broke that extension
 * in downstream packages.
 */
export type DecomposedTask = {
  id: string;
  description: string;
  agentType: 'explore' | 'plan' | 'general-purpose' | 'review' | 'test';
  dependsOn: string[];
  onFailure: FailurePolicy;
};

export const DecomposeTaskInputSchema = z.object({
  tasks: z.array(DecomposedTaskSchema).min(1, 'At least one task is required'),
});

export type DecomposeTaskInput = {
  tasks: DecomposedTask[];
};

export type PipelineTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cascade_failed';

export interface PipelineTask extends DecomposedTask {
  status: PipelineTaskStatus;
  result?: string;
  error?: string;
}

export interface PipelineTaskResult {
  id: string;
  description: string;
  agentType: string;
  status: PipelineTaskStatus;
  result?: string;
  error?: string;
}

export interface PipelineExecutionResult {
  success: boolean;
  taskResults: ReadonlyArray<PipelineTaskResult>;
  summary: string;
}
