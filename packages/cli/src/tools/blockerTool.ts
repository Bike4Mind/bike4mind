import { v4 as uuidv4 } from 'uuid';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { WorkflowBlocker } from '../storage/types.js';

/**
 * Store for managing blocker state.
 * Shared across tool invocations, persisted to session on save.
 */
export interface BlockerStore {
  blockers: WorkflowBlocker[];
  onUpdate?: (blockers: WorkflowBlocker[]) => void;
}

/**
 * Format blockers for display output
 */
export function formatBlockersOutput(blockers: WorkflowBlocker[]): string {
  if (blockers.length === 0) {
    return 'No blockers tracked in this session.';
  }

  const open = blockers.filter(b => b.status === 'open');
  const resolved = blockers.filter(b => b.status === 'resolved');

  const lines: string[] = [];

  if (open.length > 0) {
    lines.push(`**Open blockers (${open.length}):**`);
    for (const blocker of open) {
      lines.push(`  - [${blocker.id.slice(0, 8)}] ${blocker.description}`);
    }
  }

  if (resolved.length > 0) {
    if (open.length > 0) lines.push('');
    lines.push(`**Resolved blockers (${resolved.length}):**`);
    for (const blocker of resolved) {
      lines.push(`  - [${blocker.id.slice(0, 8)}] ${blocker.description}`);
      lines.push(`    Resolution: ${blocker.resolution ?? '(no resolution recorded)'}`);
    }
  }

  return lines.join('\n');
}

/**
 * Create the track_blocker and resolve_blocker tools.
 *
 * Allows the AI to track what's blocking progress and record resolutions.
 * Blockers are persisted in the session's workflow state for audit trail
 * and cross-session continuity.
 */
export function createBlockerTools(store: BlockerStore): ICompletionOptionTools[] {
  const trackBlocker: ICompletionOptionTools = {
    toolFn: async (args: unknown) => {
      const params = args as Record<string, unknown>;

      if (typeof params.description !== 'string' || params.description.trim() === '') {
        throw new Error('track_blocker: description must be a non-empty string');
      }

      const blocker: WorkflowBlocker = {
        id: uuidv4(),
        createdAt: new Date().toISOString(),
        description: params.description.trim(),
        status: 'open',
      };

      store.blockers.push(blocker);

      if (store.onUpdate) {
        store.onUpdate(store.blockers);
      }

      const openCount = store.blockers.filter(b => b.status === 'open').length;
      return `Blocker tracked [${blocker.id.slice(0, 8)}]: ${blocker.description}\n(${openCount} open blocker${openCount === 1 ? '' : 's'})`;
    },
    toolSchema: {
      name: 'track_blocker',
      description: `Track something that is blocking progress.

**When to use:**
- Missing information or unclear requirements
- External dependencies (waiting on API access, credentials, data)
- Technical constraints discovered during work
- Ambiguous requirements that need human clarification

**When NOT to use:**
- Normal challenges that are part of the work
- Things you can resolve immediately`,
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'What is blocking progress — be specific about what is needed to unblock',
          },
        },
        required: ['description'],
      },
    },
  };

  const resolveBlocker: ICompletionOptionTools = {
    toolFn: async (args: unknown) => {
      const params = args as Record<string, unknown>;

      if (typeof params.blocker_id !== 'string' || params.blocker_id.trim() === '') {
        throw new Error('resolve_blocker: blocker_id must be a non-empty string');
      }

      if (typeof params.resolution !== 'string' || params.resolution.trim() === '') {
        throw new Error('resolve_blocker: resolution must be a non-empty string');
      }

      const blockerId = params.blocker_id.trim();
      const blocker = store.blockers.find(b => b.id === blockerId || b.id.startsWith(blockerId));

      if (!blocker) {
        const openBlockers = store.blockers.filter(b => b.status === 'open');
        if (openBlockers.length === 0) {
          return 'No open blockers to resolve.';
        }
        return `Blocker not found. Open blockers:\n${openBlockers.map(b => `  [${b.id.slice(0, 8)}] ${b.description}`).join('\n')}`;
      }

      if (blocker.status === 'resolved') {
        return `Blocker [${blocker.id.slice(0, 8)}] is already resolved.`;
      }

      blocker.status = 'resolved';
      blocker.resolvedAt = new Date().toISOString();
      blocker.resolution = params.resolution.trim();

      if (store.onUpdate) {
        store.onUpdate(store.blockers);
      }

      const openCount = store.blockers.filter(b => b.status === 'open').length;
      return `Blocker resolved [${blocker.id.slice(0, 8)}]: ${blocker.resolution}\n(${openCount} open blocker${openCount === 1 ? '' : 's'} remaining)`;
    },
    toolSchema: {
      name: 'resolve_blocker',
      description: `Mark a blocker as resolved with a description of how it was resolved.

Use the blocker ID (or its first 8 characters) from the track_blocker output.`,
      parameters: {
        type: 'object',
        properties: {
          blocker_id: {
            type: 'string',
            description: 'The ID of the blocker to resolve (full ID or first 8 characters)',
          },
          resolution: {
            type: 'string',
            description: 'How the blocker was resolved',
          },
        },
        required: ['blocker_id', 'resolution'],
      },
    },
  };

  return [trackBlocker, resolveBlocker];
}

/**
 * Create a new empty BlockerStore
 */
export function createBlockerStore(onUpdate?: (blockers: WorkflowBlocker[]) => void): BlockerStore {
  return {
    blockers: [],
    onUpdate,
  };
}
