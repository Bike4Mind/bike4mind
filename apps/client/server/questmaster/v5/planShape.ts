import { z } from 'zod';

/**
 * The plan a model returns for a goal, and the deterministic expansion of it
 * into graph nodes.
 *
 * The model is asked for STRUCTURE ONLY - phases and their tasks. It is never
 * asked to author dependency edges. Those are derived here, which means a plan
 * cannot come back with a cycle, a dangling edge, or a self-reference no matter
 * what the model emits; the failure modes that would need validating simply do
 * not exist. It also guarantees the shape F3 asks for - a legible chain you feel
 * yourself progressing along - rather than whatever topology the model felt like.
 */

/** Ceilings on generated structure, well inside the graph's own node budget. */
export const MAX_PHASES = 6;
export const MAX_TASKS_PER_PHASE = 5;

export const PlanTaskSchema = z.object({
  title: z.string().min(1).max(120),
  task: z.string().min(1).max(2000),
  acceptanceCriteria: z.string().max(1000).optional(),
});

export const PlanPhaseSchema = z.object({
  title: z.string().min(1).max(120),
  objective: z.string().min(1).max(1000),
  tasks: z.array(PlanTaskSchema).min(1).max(MAX_TASKS_PER_PHASE),
});

export const GeneratedPlanSchema = z.object({
  phases: z.array(PlanPhaseSchema).min(1).max(MAX_PHASES),
});

export type GeneratedPlan = z.infer<typeof GeneratedPlanSchema>;

/** One node to create, with dependencies expressed as indices into this same list. */
export interface PlannedNode {
  title: string;
  task: string;
  acceptanceCriteria?: string;
  kind: 'spine' | 'task';
  /** Index of the parent in this list, or null for a root (spine) node. */
  parentIndex: number | null;
  /** Indices in this list this node must wait for. */
  dependsOnIndices: number[];
}

/**
 * Flatten a plan into nodes, deriving the dependency graph.
 *
 * Shape: each phase becomes a `spine` root; its tasks become `task` children of
 * that spine. Tasks within a phase are INDEPENDENT of each other (they can run
 * in parallel), and every task in a phase depends on every task of the phase
 * before it. So the graph reads as a chain of phases with a fan of work inside
 * each - legible top to bottom, still parallel where parallelism is real.
 *
 * Spine nodes carry no dependencies and are never executed; they exist to make
 * the plan readable. The runnable leaves are the tasks.
 *
 * Acyclic by construction: every edge points strictly backwards to an earlier
 * phase, so no cycle is expressible.
 */
export function planToNodes(plan: GeneratedPlan): PlannedNode[] {
  const nodes: PlannedNode[] = [];
  let previousPhaseTaskIndices: number[] = [];

  for (const phase of plan.phases) {
    const spineIndex = nodes.length;
    nodes.push({
      title: phase.title,
      task: phase.objective,
      kind: 'spine',
      parentIndex: null,
      dependsOnIndices: [],
    });

    const thisPhaseTaskIndices: number[] = [];
    for (const task of phase.tasks) {
      thisPhaseTaskIndices.push(nodes.length);
      nodes.push({
        title: task.title,
        task: task.task,
        acceptanceCriteria: task.acceptanceCriteria,
        kind: 'task',
        parentIndex: spineIndex,
        // Depends on the WHOLE previous phase, not one task in it: a phase is
        // only meaningfully done when all of its work is.
        dependsOnIndices: [...previousPhaseTaskIndices],
      });
    }

    previousPhaseTaskIndices = thisPhaseTaskIndices;
  }

  return nodes;
}

/**
 * Pull a plan object out of a model's reply.
 *
 * Models wrap JSON in prose or fences even when told not to, so this takes the
 * outermost braces rather than trusting the whole response to parse. Returns
 * null rather than throwing - an unusable plan is a normal outcome to report,
 * not an exception.
 */
export function extractPlan(replyText: string): GeneratedPlan | null {
  const start = replyText.indexOf('{');
  const end = replyText.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = GeneratedPlanSchema.safeParse(JSON.parse(replyText.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The instruction sent to the model. Kept beside the schema so the two cannot drift. */
export function buildPlanPrompt(goal: string): string {
  return [
    'You are planning a quest: a small, legible chain of phases that gets a goal done.',
    '',
    `GOAL: ${goal}`,
    '',
    `Return between 1 and ${MAX_PHASES} phases, each with 1 to ${MAX_TASKS_PER_PHASE} tasks.`,
    'A phase is a high-level objective a person can recognise as progress.',
    'A task is ONE concrete unit of work an AI agent can carry out on its own and',
    'that has an observable result. Tasks inside a phase should be independent of',
    'each other so they can run at the same time; order dependencies between',
    'phases, not within one.',
    '',
    'Write acceptanceCriteria for a task whenever "done" could be judged - state',
    'what must be true, not how to do it.',
    '',
    'Reply with JSON and nothing else, in exactly this shape:',
    '{"phases":[{"title":"...","objective":"...","tasks":[{"title":"...","task":"...","acceptanceCriteria":"..."}]}]}',
  ].join('\n');
}
