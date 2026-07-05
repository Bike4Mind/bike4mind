import { Logger } from '@bike4mind/observability';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { ReplToolMap } from './ReplContext';
import type { ReplToolDescriptor } from './prompts';

/**
 * Bridge an existing array of `ICompletionOptionTools` (the contract the
 * ReActAgent / OpenAI / Anthropic backends consume) into the in-REPL
 * shape: a `ReplToolMap` where each tool is callable as an async JS
 * function from inside `code_execute`, plus matching descriptors for
 * the system prompt.
 *
 * This is the bridge between two worlds:
 * - Outside the REPL: tools are tool-call API objects with toolFn
 *   returning Promise<string> observation
 * - Inside the REPL: tools are async functions returning whatever shape
 *   JSON.parse produces when the result parses, or the raw string when
 *   it doesn't
 *
 * The wrapper tries to JSON-parse each result. If parsing succeeds, the
 * parsed value is returned - including objects, arrays, AND primitives
 * (numbers, booleans, the parsed-string form of JSON-quoted strings).
 * Primitives are useful for computation inside JS (e.g. tools returning
 * a count). Anything that doesn't parse as JSON (prose, markdown, a
 * bare unquoted word) is returned as the original string.
 */

export interface WrapOpts {
  /** Optional filter: keep only tools matching this predicate. */
  filter?: (tool: ICompletionOptionTools) => boolean;
  /** Optional rename: map original tool name to a different in-REPL identifier. */
  rename?: (originalName: string) => string;
}

export interface WrapResult {
  /** The map to pass to ReplContext.setTools() / ReplSession.setTools(). */
  replTools: ReplToolMap;
  /** Descriptors to pass to buildReplToolSystemPrompt({ tools }). */
  descriptors: ReplToolDescriptor[];
}

/**
 * Wrap a set of agent tools for in-REPL exposure.
 *
 * @example
 *   const allTavernTools = await buildAllTavernTools(ctx);
 *   const { replTools, descriptors } = wrapAgentToolsForRepl(allTavernTools, {
 *     filter: t => isTavernReadOnlyTool(t.toolSchema.name),
 *   });
 *   session.setTools(replTools);
 *   const prompt = buildReplToolSystemPrompt({ tools: descriptors });
 */
export function wrapAgentToolsForRepl(tools: ICompletionOptionTools[], opts: WrapOpts = {}): WrapResult {
  const filtered = opts.filter ? tools.filter(opts.filter) : tools;
  const replTools: ReplToolMap = {};
  const descriptors: ReplToolDescriptor[] = [];

  for (const tool of filtered) {
    const originalName = tool.toolSchema.name;
    const inReplName = opts.rename ? opts.rename(originalName) : originalName;
    if (!isValidIdentifier(inReplName)) {
      // Skip: the JS engine can't bind a function whose name isn't a valid
      // identifier. Warn so operators see missing tools instead of debugging
      // a silent omission.
      Logger.globalInstance.warn(
        `[wrapAgentToolsForRepl] skipping tool "${originalName}" — in-REPL name ` +
          `"${inReplName}" is not a valid JS identifier (must match /^[a-zA-Z_$][a-zA-Z0-9_$]*$/).`
      );
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(replTools, inReplName)) {
      // Two tools mapped to the same in-REPL name. Keep the first (so the
      // descriptor + function stay aligned) and warn - silent overwrite
      // would leave the prompt referencing the first tool while the
      // function dispatches to the second.
      Logger.globalInstance.warn(
        `[wrapAgentToolsForRepl] duplicate in-REPL name "${inReplName}" ` +
          `(from tool "${originalName}") — skipping. ` +
          `Resolve by renaming via opts.rename or filtering one of the tools out.`
      );
      continue;
    }

    replTools[inReplName] = async (...args: unknown[]) => {
      const params = args[0];
      const raw = await tool.toolFn(params);
      return tryParseJson(raw);
    };

    descriptors.push({
      name: inReplName,
      signature: deriveSignature(tool.toolSchema),
      description: shortenDescription(tool.toolSchema.description),
    });
  }

  return { replTools, descriptors };
}

// -- helpers --

const IDENTIFIER_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

function isValidIdentifier(name: string): boolean {
  return IDENTIFIER_RE.test(name);
}

function tryParseJson(raw: string): unknown {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  // Quick reject: only attempt parse on strings starting with { [ " or digits/-/null/true/false
  const first = trimmed[0];
  const looksJson =
    first === '{' ||
    first === '[' ||
    first === '"' ||
    first === '-' ||
    (first >= '0' && first <= '9') ||
    trimmed.startsWith('null') ||
    trimmed.startsWith('true') ||
    trimmed.startsWith('false');
  if (!looksJson) return raw;
  try {
    const parsed = JSON.parse(trimmed);
    // Only "upgrade" to parsed when we get a structured value. A bare
    // string like '"hello"' technically parses to "hello" - return that
    // (loses quotes; matches what the agent expected). A primitive like
    // '42' parses to 42 (useful for computation).
    return parsed;
  } catch {
    return raw;
  }
}

function deriveSignature(schema: ICompletionOptionTools['toolSchema']): string {
  const props = Object.keys(schema.parameters?.properties ?? {});
  if (props.length === 0) return '()';
  if (props.length === 1) return `({ ${props[0]} })`;
  return `({ ${props.join(', ')} })`;
}

function shortenDescription(desc: string | undefined): string {
  if (!desc) return '';
  // Take the first sentence (or first 200 chars) for the in-REPL listing.
  // Keeps the prompt tight; full descriptions are in the original tool schema.
  const firstSentence = desc.match(/^[^.!?]+[.!?]/)?.[0]?.trim();
  return firstSentence || desc.slice(0, 200).trim();
}
