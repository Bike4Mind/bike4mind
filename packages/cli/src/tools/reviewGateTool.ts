import { v4 as uuidv4 } from 'uuid';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { ReviewGateEntry } from '../storage/types.js';

/**
 * Parameters for the request_review_gate tool
 */
interface RequestReviewGateParams {
  description: string;
  options?: string[];
  recommendation?: string;
}

/**
 * Response from the user when resolving a review gate
 */
export interface ReviewGateResponse {
  decision: 'approved' | 'rejected';
  note?: string;
}

/**
 * Function that pauses execution and prompts the user to resolve a review gate.
 * Implementations are expected to surface UI to collect the user's response.
 */
export type RequestReviewGateFn = (params: {
  id: string;
  description: string;
  options?: string[];
  recommendation?: string;
}) => Promise<ReviewGateResponse>;

/**
 * Store for managing review gate state.
 * Shared across tool invocations, persisted to session on save.
 */
export interface ReviewGateStore {
  reviewGates: ReviewGateEntry[];
  onUpdate?: (gates: ReviewGateEntry[]) => void;
}

// Caps on LLM-supplied inputs. Prevent a misbehaving model from flooding the
// terminal UI or bloating the persisted session JSON with unbounded payloads.
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_RECOMMENDATION_LENGTH = 1000;
const MAX_OPTION_LENGTH = 500;
const MAX_OPTIONS_COUNT = 10;

/**
 * Validate request_review_gate parameters
 * @throws Error if validation fails
 */
function validateParams(args: unknown): RequestReviewGateParams {
  const params = args as Record<string, unknown>;

  if (typeof params.description !== 'string' || params.description.trim() === '') {
    throw new Error('request_review_gate: description must be a non-empty string');
  }
  if (params.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`request_review_gate: description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`);
  }

  if (params.options !== undefined) {
    if (!Array.isArray(params.options)) {
      throw new Error('request_review_gate: options must be an array of strings');
    }
    if (params.options.length > MAX_OPTIONS_COUNT) {
      throw new Error(`request_review_gate: options must contain ${MAX_OPTIONS_COUNT} entries or fewer`);
    }
    for (const opt of params.options) {
      if (typeof opt !== 'string') {
        throw new Error('request_review_gate: each option must be a string');
      }
      if (opt.length > MAX_OPTION_LENGTH) {
        throw new Error(`request_review_gate: each option must be ${MAX_OPTION_LENGTH} characters or fewer`);
      }
    }
  }

  if (params.recommendation !== undefined) {
    if (typeof params.recommendation !== 'string') {
      throw new Error('request_review_gate: recommendation must be a string');
    }
    if (params.recommendation.length > MAX_RECOMMENDATION_LENGTH) {
      throw new Error(`request_review_gate: recommendation must be ${MAX_RECOMMENDATION_LENGTH} characters or fewer`);
    }
  }

  const options = (params.options as string[] | undefined)?.map(o => o.trim()).filter(o => o.length > 0);

  return {
    description: params.description.trim(),
    options: options && options.length > 0 ? options : undefined,
    recommendation: typeof params.recommendation === 'string' ? params.recommendation.trim() : undefined,
  };
}

/**
 * Format review gates for display output
 */
export function formatReviewGatesOutput(gates: ReviewGateEntry[]): string {
  if (gates.length === 0) {
    return 'No review gates recorded in this session.';
  }

  return gates
    .map((gate, index) => {
      const lines = [`${index + 1}. **${gate.description}**`, `   Status: ${gate.status}`];

      if (gate.recommendation) {
        lines.push(`   Recommendation: ${gate.recommendation}`);
      }

      if (gate.options && gate.options.length > 0) {
        lines.push('   Options:');
        for (const opt of gate.options) {
          lines.push(`     • ${opt}`);
        }
      }

      if (gate.userNote) {
        lines.push(`   Note: ${gate.userNote}`);
      }

      const requested = new Date(gate.timestamp).toLocaleTimeString();
      lines.push(`   Requested at: ${requested}`);

      if (gate.resolvedAt) {
        const resolved = new Date(gate.resolvedAt).toLocaleTimeString();
        lines.push(`   Resolved at: ${resolved}`);
      }

      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Create the request_review_gate tool.
 *
 * Pauses agent execution and prompts the user for explicit approval at a
 * significant decision point. The agent halts until the user responds.
 *
 * Decisions are persisted in the session's workflow state (`reviewGates`)
 * for audit trail and cross-session continuity.
 */
export function createReviewGateTool(
  store: ReviewGateStore,
  requestReviewFn: RequestReviewGateFn
): ICompletionOptionTools {
  return {
    toolFn: async (args: unknown) => {
      const params = validateParams(args);

      const id = uuidv4();
      const requestedAt = new Date().toISOString();

      const response = await requestReviewFn({
        id,
        description: params.description,
        options: params.options,
        recommendation: params.recommendation,
      });

      // Defense-in-depth: callers should already trim the note, but the tool
      // is the source of truth for storage shape so normalize here too.
      const trimmedNote = response.note?.trim();
      const entry: ReviewGateEntry = {
        id,
        timestamp: requestedAt,
        description: params.description,
        status: response.decision,
        resolvedAt: new Date().toISOString(),
        userNote: trimmedNote && trimmedNote.length > 0 ? trimmedNote : undefined,
        options: params.options,
        recommendation: params.recommendation,
      };

      store.reviewGates.push(entry);

      if (store.onUpdate) {
        store.onUpdate(store.reviewGates);
      }

      const verdict = response.decision === 'approved' ? 'APPROVED' : 'REJECTED';
      const noteText = entry.userNote ? `\nUser note: ${entry.userNote}` : '';
      return `Review gate ${verdict} [${id.slice(0, 8)}]: ${params.description}${noteText}`;
    },
    toolSchema: {
      name: 'request_review_gate',
      description: `Pause execution and request explicit human approval at a significant decision point.

Review gates protect meaning. Stop before crossing decisions that affect interpretation, evidence, cost, credentials, platform, or public commitment.

**When to use:**
- Synthesizing findings before narrowing research scope
- Hard-to-reverse decisions (refactors, architectural pivots, dependency swaps)
- Decisions affecting cost, credentials, or external commitments
- Major direction changes after exploration

**When NOT to use:**
- Routine operations (reading files, running tests, listing directories)
- Operations already covered by the standard permission system (file edits, bash commands)
- Trivial choices that wouldn't matter to someone resuming this work

The agent will pause until the user explicitly approves or rejects. The user may attach an optional note to their decision (e.g., to redirect or clarify scope). Treat a rejection as a hard stop — re-plan rather than retry.`,
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Clear explanation of what the user is being asked to approve, including relevant context',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of alternatives the user can choose between',
          },
          recommendation: {
            type: 'string',
            description: 'Optional recommendation from the AI on the preferred path and why',
          },
        },
        required: ['description'],
      },
    },
  };
}

/**
 * Create a new empty ReviewGateStore
 */
export function createReviewGateStore(onUpdate?: (gates: ReviewGateEntry[]) => void): ReviewGateStore {
  return {
    reviewGates: [],
    onUpdate,
  };
}
