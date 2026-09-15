import { v4 as uuidv4 } from 'uuid';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { WorkflowDecision } from '../storage/types.js';

/**
 * Parameters for the log_decision tool
 */
interface LogDecisionParams {
  /** What was decided */
  summary: string;
  /** Why this decision was made */
  rationale: string;
  /** What alternatives were considered */
  alternatives?: string[];
  /** What triggered this decision */
  context?: string;
}

/**
 * Store for managing decision log state.
 * Shared across tool invocations, persisted to session on save.
 */
export interface DecisionStore {
  decisions: WorkflowDecision[];
  onUpdate?: (decisions: WorkflowDecision[]) => void;
}

/**
 * Validate log_decision parameters
 * @throws Error if validation fails
 */
function validateParams(args: unknown): LogDecisionParams {
  const params = args as Record<string, unknown>;

  if (typeof params.summary !== 'string' || params.summary.trim() === '') {
    throw new Error('log_decision: summary must be a non-empty string');
  }

  if (typeof params.rationale !== 'string' || params.rationale.trim() === '') {
    throw new Error('log_decision: rationale must be a non-empty string');
  }

  if (params.alternatives !== undefined) {
    if (!Array.isArray(params.alternatives)) {
      throw new Error('log_decision: alternatives must be an array of strings');
    }
    for (const alt of params.alternatives) {
      if (typeof alt !== 'string') {
        throw new Error('log_decision: each alternative must be a string');
      }
    }
  }

  if (params.context !== undefined && typeof params.context !== 'string') {
    throw new Error('log_decision: context must be a string');
  }

  return {
    summary: params.summary.trim(),
    rationale: params.rationale.trim(),
    alternatives: params.alternatives as string[] | undefined,
    context: typeof params.context === 'string' ? params.context.trim() : undefined,
  };
}

/**
 * Format decisions for display output
 */
export function formatDecisionsOutput(decisions: WorkflowDecision[]): string {
  if (decisions.length === 0) {
    return 'No decisions logged in this session.';
  }

  return decisions
    .map((decision, index) => {
      const lines = [`${index + 1}. **${decision.summary}**`, `   Rationale: ${decision.rationale}`];

      if (decision.alternatives && decision.alternatives.length > 0) {
        lines.push(`   Alternatives considered: ${decision.alternatives.join(', ')}`);
      }

      if (decision.context) {
        lines.push(`   Context: ${decision.context}`);
      }

      const timestamp = new Date(decision.timestamp).toLocaleTimeString();
      lines.push(`   Logged at: ${timestamp}`);

      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Create the log_decision tool.
 *
 * Allows the AI to record significant decisions with rationale during a session.
 * Decisions are persisted in the session's workflow state for audit trail
 * and cross-session continuity.
 */
export function createDecisionLogTool(store: DecisionStore): ICompletionOptionTools {
  return {
    toolFn: async (args: unknown) => {
      const params = validateParams(args);

      const decision: WorkflowDecision = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        summary: params.summary,
        rationale: params.rationale,
        alternatives: params.alternatives,
        context: params.context,
      };

      store.decisions.push(decision);

      if (store.onUpdate) {
        store.onUpdate(store.decisions);
      }

      return `Decision logged (#${store.decisions.length}): ${decision.summary}`;
    },
    toolSchema: {
      name: 'log_decision',
      description: `Record a significant decision with its rationale for audit trail and session continuity.

**When to use:**
- Architecture or design choices (e.g., "chose Zustand over Redux because...")
- Scope narrowing or direction changes in research
- Trade-off decisions between viable alternatives
- Interpretation of ambiguous requirements

**When NOT to use:**
- Routine operations (reading files, running tests)
- Trivial choices that wouldn't matter to someone resuming this work
- Implementation details that are obvious from the code

Log decisions that would matter if someone needed to understand WHY you did something.`,
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'What was decided — a clear, concise statement',
          },
          rationale: {
            type: 'string',
            description: 'Why this decision was made — the reasoning behind it',
          },
          alternatives: {
            type: 'array',
            items: { type: 'string' },
            description: 'What alternatives were considered (optional)',
          },
          context: {
            type: 'string',
            description: 'What triggered this decision — the situation or constraint (optional)',
          },
        },
        required: ['summary', 'rationale'],
      },
    },
  };
}

/**
 * Create a new empty DecisionStore
 */
export function createDecisionStore(onUpdate?: (decisions: WorkflowDecision[]) => void): DecisionStore {
  return {
    decisions: [],
    onUpdate,
  };
}
