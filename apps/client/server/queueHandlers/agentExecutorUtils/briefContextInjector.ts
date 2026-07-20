import type { ToolDefinition } from '@bike4mind/services';

type ToolFn = (parameters?: unknown, apiKey?: string) => Promise<string>;

/**
 * Tools whose result loads or updates the active brief that the NEXT tool call must reference
 * (optihashi_solve / optihashi_schedule take the problem as `problem`; optihashi_edit_problem
 * takes it as `currentProblem`).
 */
const BRIEF_SETTING_TOOLS = ['optihashi_formulate', 'optihashi_decompose', 'optihashi_edit_problem'] as const;

/** Pull the loaded problem out of a `populate*` side-effect payload. Null if there isn't one. */
export function extractLoadedProblem(type: unknown, payload: unknown): unknown {
  if (type === 'populateProblem') return payload ?? null; // scheduling problem IS the payload
  if (type === 'populateFamilyProblem') return (payload as { problem?: unknown } | null)?.problem ?? null;
  if (type === 'populateDecomposition') {
    // Decompose loads step 1 as the active brief; its instance is instances[0] (null if plan-only).
    const inst = (payload as { instances?: Array<{ problem?: unknown } | null> } | null)?.instances?.[0];
    return inst?.problem ?? null;
  }
  return null;
}

function familyOf(problem: unknown): string | undefined {
  const f = (problem as { family?: unknown } | null)?.family;
  return typeof f === 'string' ? f : undefined;
}

/**
 * Append the loaded brief's exact JSON to a tool observation, so the agent passes the real problem
 * verbatim to the next solve/edit call instead of reconstructing it from a summary (the drain that
 * produced wrong field names, e.g. `capacity` vs `budget`). The side-effect envelope's `payload` is
 * left untouched (the client still gets the correct UI update); only `displayMessage` -- what the
 * agent reads as the observation -- is augmented. Non-envelope results (e.g. `Error: ...` or a
 * guard redirect) are returned unchanged.
 */
export function appendBriefToObservation(result: string): string {
  let env: { __uiSideEffect?: unknown; type?: unknown; payload?: unknown; displayMessage?: unknown };
  try {
    env = JSON.parse(result);
  } catch {
    return result;
  }
  if (!env || env.__uiSideEffect !== true) return result;

  const problem = extractLoadedProblem(env.type, env.payload);
  if (problem == null || typeof problem !== 'object') return result;

  const fam = familyOf(problem);
  const passHint = fam
    ? `Pass this EXACT object as \`problem\` to optihashi_solve (its "family" is already "${fam}").`
    : 'Pass this EXACT object as `problem` to optihashi_schedule (this is a scheduling problem).';
  const brief = [
    '',
    '---',
    'ACTIVE BRIEF (now loaded). Do NOT retype or reconstruct it -- copy it verbatim from here:',
    '```json',
    JSON.stringify(problem),
    '```',
    `${passHint} To adjust it, pass the same object as \`currentProblem\` to optihashi_edit_problem.`,
  ].join('\n');

  const displayMessage = typeof env.displayMessage === 'string' ? env.displayMessage : '';
  return JSON.stringify({ ...env, displayMessage: displayMessage + brief });
}

function wrap(tool: ToolDefinition, makeFn: (run: ToolFn) => ToolFn): ToolDefinition {
  return {
    ...tool,
    implementation: (context, config) => {
      const inner = tool.implementation(context, config);
      return { ...inner, toolFn: makeFn(inner.toolFn as ToolFn) };
    },
  };
}

/**
 * Give the autonomous opti loop the real active brief in-context (#57).
 *
 * In agent mode the opti tools populate the CLIENT-side brief via UI side-effects, but the side-
 * effect extractor replaces the agent's observation with just the human-readable summary -- the
 * full problem JSON is stripped. So when the agent then calls optihashi_solve/edit (which require
 * the problem as an argument), it reconstructs it from the summary and gets fields wrong, forcing a
 * retry. This wraps the brief-setting tools so their observation also carries the exact problem JSON
 * for the agent to copy verbatim.
 *
 * Host-side and applied only in the agent-executor tool path, so the guided chat flow (which reaches
 * the overlay tools directly) is unaffected -- no JSON blob in normal chat. Returns a NEW map;
 * inert for non-opti runs.
 */
export function injectBriefContext(tools: Record<string, ToolDefinition>): Record<string, ToolDefinition> {
  if (!tools['optihashi_formulate'] && !tools['optihashi_decompose']) return tools;
  const guarded = { ...tools };
  for (const name of BRIEF_SETTING_TOOLS) {
    const tool = tools[name];
    if (!tool) continue;
    guarded[name] = wrap(
      tool,
      run => async (parameters, apiKey) => appendBriefToObservation(await run(parameters, apiKey))
    );
  }
  return guarded;
}
