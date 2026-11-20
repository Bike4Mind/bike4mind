export interface SlackInteractiveActionContext {
  actionId: string;
  value?: string;
  user: { id: string; name?: string; username?: string };
  teamId?: string;
  channelId?: string;
  messageTs?: string;
  responseUrl?: string;
  triggerId?: string;
  workspaceId?: string;
  botToken?: string;
  appName?: string;
}

export interface SlackInteractiveActionResult {
  response: Record<string, unknown>;
  /** Work that outlives the HTTP response; the endpoint awaits it after responding. */
  deferred?: Promise<void>;
}

export interface SlackInteractiveActionHandler {
  actionIds?: readonly string[];
  actionIdPrefixes?: readonly string[];
  handle(context: SlackInteractiveActionContext): Promise<SlackInteractiveActionResult>;
}

export interface SlackInteractiveActionRegistry {
  find(actionId: string): SlackInteractiveActionHandler | undefined;
  /** Contributed entries that were left out, one message each. */
  problems: readonly string[];
}

export interface SlackInteractiveReservedActions {
  ids: readonly string[];
  prefixes: readonly string[];
}

const ACTION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const MIN_PREFIX_LENGTH = 4;

interface Claim {
  kind: 'id' | 'prefix';
  value: string;
}

function claimsOf(handler: SlackInteractiveActionHandler): Claim[] {
  return [
    ...(handler.actionIds ?? []).map((value): Claim => ({ kind: 'id', value })),
    ...(handler.actionIdPrefixes ?? []).map((value): Claim => ({ kind: 'prefix', value })),
  ];
}

function describeClaim(claim: Claim): string {
  return `${claim.kind === 'id' ? 'action id' : 'action id prefix'} "${claim.value}"`;
}

/** Two claims clash when some action id would be routed to both: equal ids, or one covering the other. */
function claimsClash(a: Claim, b: Claim): boolean {
  if (a.kind === 'id' && b.kind === 'id') return a.value === b.value;
  if (a.kind === 'prefix' && b.kind === 'prefix') return a.value.startsWith(b.value) || b.value.startsWith(a.value);
  const [id, prefix] = a.kind === 'id' ? [a, b] : [b, a];
  return id.value.startsWith(prefix.value);
}

function firstClash(claims: readonly Claim[], taken: readonly Claim[]): { claim: Claim; against: Claim } | undefined {
  for (const claim of claims) {
    for (const against of taken) {
      if (claimsClash(claim, against)) return { claim, against };
    }
  }
  return undefined;
}

function invalidKeyProblem(label: string, kind: 'id' | 'prefix', value: unknown): string | undefined {
  const noun = kind === 'id' ? 'action id' : 'action id prefix';
  if (typeof value !== 'string') return `${label} has an ${noun} of type ${typeof value}, expected a string`;
  if (!ACTION_KEY_PATTERN.test(value)) {
    return `${label} has an invalid ${noun} "${value}" (lowercase letters, digits and underscores, starting with a letter)`;
  }
  if (kind === 'prefix' && value.length < MIN_PREFIX_LENGTH) {
    return `${label} has the ${noun} "${value}", shorter than ${MIN_PREFIX_LENGTH} characters`;
  }
  return undefined;
}

/** The first problem with a contributed entry's shape, or undefined when it can be registered. */
function shapeProblem(entry: unknown, label: string): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return `${label} is not an object`;
  const { handle, actionIds, actionIdPrefixes } = entry as Record<string, unknown>;
  if (typeof handle !== 'function') return `${label} has no handle function`;

  const lists: Array<{ kind: 'id' | 'prefix'; field: string; value: unknown }> = [
    { kind: 'id', field: 'actionIds', value: actionIds },
    { kind: 'prefix', field: 'actionIdPrefixes', value: actionIdPrefixes },
  ];
  let total = 0;
  for (const { kind, field, value } of lists) {
    if (value === undefined) continue;
    if (!Array.isArray(value)) return `${label} has ${field} that is not an array`;
    for (const item of value) {
      const problem = invalidKeyProblem(label, kind, item);
      if (problem) return problem;
    }
    total += value.length;
  }
  return total === 0 ? `${label} declares no action ids or prefixes` : undefined;
}

/** Exact id match first, otherwise the handler whose matching prefix is longest. */
export function findSlackInteractiveActionHandler(
  handlers: readonly SlackInteractiveActionHandler[],
  actionId: string
): SlackInteractiveActionHandler | undefined {
  const exact = handlers.find(handler => handler.actionIds?.includes(actionId));
  if (exact) return exact;

  let best: SlackInteractiveActionHandler | undefined;
  let bestLength = -1;
  for (const handler of handlers) {
    for (const prefix of handler.actionIdPrefixes ?? []) {
      if (prefix.length > bestLength && actionId.startsWith(prefix)) {
        best = handler;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/**
 * Core handlers are trusted: a clash between them, or with the endpoint's own reserved actions, throws.
 * Contributed entries never throw: a malformed or clashing one is left out and reported in `problems`.
 */
export function buildSlackInteractiveActionRegistry(
  core: readonly SlackInteractiveActionHandler[],
  contributed: readonly unknown[],
  reserved: SlackInteractiveReservedActions
): SlackInteractiveActionRegistry {
  const taken: Claim[] = [
    ...reserved.ids.map((value): Claim => ({ kind: 'id', value })),
    ...reserved.prefixes.map((value): Claim => ({ kind: 'prefix', value })),
  ];
  const reservedCount = taken.length;
  const handlers: SlackInteractiveActionHandler[] = [];

  for (const handler of core) {
    const claims = claimsOf(handler);
    const clash = firstClash(claims, taken);
    if (clash) {
      const source = taken.indexOf(clash.against) < reservedCount ? 'a reserved action' : 'another core handler';
      throw new Error(
        `Core Slack interactive ${describeClaim(clash.claim)} clashes with ${source} (${describeClaim(clash.against)})`
      );
    }
    taken.push(...claims);
    handlers.push(handler);
  }

  const problems: string[] = [];
  if (!Array.isArray(contributed)) {
    problems.push('contributed Slack interactive actions are not an array, so none were registered');
    return { find: actionId => findSlackInteractiveActionHandler(handlers, actionId), problems };
  }

  const coreAndReservedCount = taken.length;
  contributed.forEach((entry: unknown, index) => {
    const label = `contributed entry ${index}`;
    try {
      const shape = shapeProblem(entry, label);
      if (shape) {
        problems.push(shape);
        return;
      }
      const handler = entry as SlackInteractiveActionHandler;
      const claims = claimsOf(handler);
      const clash = firstClash(claims, taken);
      if (clash) {
        const source =
          taken.indexOf(clash.against) < coreAndReservedCount
            ? 'a core or reserved action'
            : 'an earlier contributed entry';
        problems.push(
          `${label} was left out: its ${describeClaim(clash.claim)} clashes with ${source} (${describeClaim(clash.against)})`
        );
        return;
      }
      taken.push(...claims);
      handlers.push(handler);
    } catch (error) {
      problems.push(
        `${label} was left out: reading it threw ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  return { find: actionId => findSlackInteractiveActionHandler(handlers, actionId), problems };
}
