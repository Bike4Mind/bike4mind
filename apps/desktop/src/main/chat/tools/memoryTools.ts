import { readFile } from 'node:fs/promises';
import type { ChatDiff } from '@shared/chat';
import {
  MEMORY_INDEX_FILE,
  type MemoryPlan,
  type MemoryStore,
  applyMemoryPlan,
  planMemoryDelete,
  planMemoryWrite,
  resolveMemoryPath,
} from '../project/memory';
import { buildDiff, summarizeDiff } from './diff';
import { withPathLock } from './writeTools';
import { requireString, type ApprovalPrompt, type ToolContext, type ToolDefinition } from './types';

/**
 * The long-term memory of a project, as three tools.
 *
 * None of this can go through the file tools, and that is the reason these exist rather than a
 * convention over file_read and file_write. The store lives under the user's instructions
 * folder, which is deliberately outside every root they shared with a conversation, so
 * `resolveWithinRoots` denies it every time - a memory would be unreachable by design. These
 * tools reach it instead through one narrow door: a single folder, and a name that can only be
 * a kebab-case slug. See `resolveMemoryPath` for what that door is made of.
 */
function requireStore(context: ToolContext): MemoryStore {
  if (!context.memory) {
    throw new Error('This conversation has no memory store. It needs a project; memory is kept per project.');
  }
  return context.memory;
}

const NAME_ARGUMENT = {
  type: 'string',
  description: 'The memory name, as the index spells it: lowercase letters, digits and hyphens, with no ".md".',
} as const;

export const memoryRead: ToolDefinition = {
  schema: {
    name: 'memory_read',
    description: [
      'Read one memory in full, by the name its line in the index links to.',
      '',
      `The index (${MEMORY_INDEX_FILE}) is already in your context and lists every memory with a`,
      'one-line hook. Read a memory when its hook bears on what you are doing; do not read them',
      'all to see what is there. A memory records what was true when it was written, so treat a',
      'file, function or flag it names as a claim to check rather than a fact.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { name: NAME_ARGUMENT },
      required: ['name'],
      additionalProperties: false,
    },
  },

  async run(input, context) {
    const store = requireStore(context);
    const name = requireString(input, 'name');
    const path = await resolveMemoryPath(store, name);
    try {
      return await readFile(path, 'utf8');
    } catch {
      throw new Error(`There is no memory named "${name}". ${MEMORY_INDEX_FILE} lists the ones that exist.`);
    }
  },
};

/**
 * What the user is asked to allow: both files, as diffs.
 *
 * They are approving a change to a folder they never shared with this conversation, so the
 * prompt shows the bytes rather than describing them - and shows the index line too, because
 * the pointer is as much of the change as the memory is.
 */
function toPrompt(plan: MemoryPlan, verb: string): ApprovalPrompt {
  return {
    detail: `${verb} the memory ${plan.name} in ${plan.path}`,
    key: `${verb}\u0000${plan.path}\u0000${plan.after ?? ''}`,
    diffs: diffsFor(plan),
  };
}

function diffsFor(plan: MemoryPlan): ChatDiff[] {
  const operation = plan.after === null ? 'delete' : plan.before === null ? 'create' : 'overwrite';
  const diffs = [buildDiff(plan.path, operation, plan.before ?? '', plan.after ?? '')];
  if (plan.indexAfter !== plan.indexBefore) {
    diffs.push(buildDiff(plan.indexPath, plan.indexBefore ? 'edit' : 'create', plan.indexBefore, plan.indexAfter));
  }
  return diffs;
}

/**
 * Re-planned against the folder as it is now, and under a lock on the index.
 *
 * The lock is on the index rather than on each memory because the index is the file two
 * concurrent calls would both rewrite, each from the copy it read, so the second would drop the
 * first one's pointer. Re-planning inside it is the same discipline the write tools keep: what
 * was true when the prompt was raised is not what the write may assume.
 */
async function apply(plan: () => Promise<MemoryPlan>, context: ToolContext): Promise<MemoryPlan> {
  const store = requireStore(context);
  return withPathLock(`memory\u0000${store.directory}`, async () => {
    const fresh = await plan();
    if (context.signal.aborted) throw new Error('The turn was stopped before this memory was written.');
    await applyMemoryPlan(fresh);
    for (const diff of diffsFor(fresh)) context.report?.diff(diff);
    return fresh;
  });
}

export const memoryWrite: ToolDefinition = {
  schema: {
    name: 'memory_write',
    description: [
      'Save a memory, or replace one that already exists, and put its one-line pointer in',
      `${MEMORY_INDEX_FILE}. The user approves the change first and is shown both files.`,
      '',
      'Save a durable fact about the user, how they want you to work, or this project, that is',
      'NOT derivable from the code or the git history. Do not save what the repository already',
      'records - its structure, a fix you just made, anything in CLAUDE.md - and do not save what',
      'matters only to this conversation.',
      '',
      'One fact per memory. Check the index first: when a memory already covers the same ground,',
      'write to that name and update it rather than adding a second. Convert a relative date to',
      'an absolute one. Link related memories as [[their-name]]; a link to one that does not',
      'exist yet is fine.',
      '',
      'The content is the file in full, starting with frontmatter:',
      '---',
      'name: <the same kebab-case name>',
      'description: <one line, used later to decide whether this memory is relevant>',
      'metadata:',
      '  type: user | feedback | project | reference',
      '---',
      '',
      'then the fact itself. "user" is who they are, "feedback" is how they want you to work,',
      '"project" is ongoing work or a constraint, "reference" points at something external. A',
      'feedback or project memory follows the fact with a **Why:** line and a **How to apply:**',
      'line.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: NAME_ARGUMENT,
        content: { type: 'string', description: 'The whole file: frontmatter, then the fact.' },
        title: { type: 'string', description: 'Title for the index line. Defaults to the name in words.' },
        hook: {
          type: 'string',
          description: `One short phrase after the title in ${MEMORY_INDEX_FILE}. Defaults to the description.`,
        },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
  },

  approval: async (input, context) => toPrompt(await planWrite(input, context), 'Save'),

  async run(input, context) {
    const plan = await apply(() => planWrite(input, context), context);
    const verb = plan.before === null ? 'Saved' : 'Updated';
    return `${verb} the memory ${plan.name}.\n${diffsFor(plan).map(summarizeDiff).join('\n')}`;
  },
};

export const memoryDelete: ToolDefinition = {
  schema: {
    name: 'memory_delete',
    description: [
      'Remove a memory and its line in the index, for one that turned out to be wrong or no',
      'longer true. The user approves it first. To correct a memory, use memory_write on the',
      'same name instead; this is for the ones that should not exist at all.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { name: NAME_ARGUMENT },
      required: ['name'],
      additionalProperties: false,
    },
  },

  approval: async (input, context) => toPrompt(await planDelete(input, context), 'Delete'),

  async run(input, context) {
    const plan = await apply(() => planDelete(input, context), context);
    return `Deleted the memory ${plan.name} and its line in ${MEMORY_INDEX_FILE}.`;
  },
};

function planWrite(input: Record<string, unknown>, context: ToolContext): Promise<MemoryPlan> {
  const title = typeof input.title === 'string' ? input.title : undefined;
  const hook = typeof input.hook === 'string' ? input.hook : undefined;
  return planMemoryWrite(requireStore(context), {
    name: requireString(input, 'name'),
    content: requireString(input, 'content'),
    ...(title ? { title } : {}),
    ...(hook ? { hook } : {}),
  });
}

function planDelete(input: Record<string, unknown>, context: ToolContext): Promise<MemoryPlan> {
  return planMemoryDelete(requireStore(context), requireString(input, 'name'));
}
