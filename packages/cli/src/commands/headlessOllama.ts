import { OllamaBackend } from '@bike4mind/llm-adapters';
import { defaultLlmBackendDeps, type BuildLlmBackendDeps } from '../bootstrap/buildLlmBackend.js';
import { sanitizeTerminalText } from '../utils/sanitizeTerminalText.js';

/** Per argument, so one large object (a verbose models list) cannot flood stderr. */
export const MAX_DIAGNOSTIC_ARG_CHARS = 4096;

function capped(text: string): string {
  if (text.length <= MAX_DIAGNOSTIC_ARG_CHARS) return text;
  return `${text.slice(0, MAX_DIAGNOSTIC_ARG_CHARS)}... [${text.length - MAX_DIAGNOSTIC_ARG_CHARS} more chars]`;
}

// An Error, at any depth, keeps its String() form so request details attached to it are not dumped.
function renderDiagnostic(value: unknown): string {
  if (typeof value !== 'object' || value === null || value instanceof Error) return String(value);
  // Only the current path, so an object shared by two branches is not mistaken for a cycle.
  const ancestors: object[] = [];
  try {
    const json = JSON.stringify(value, function (this: unknown, _key, inner: unknown) {
      if (inner instanceof Error) return String(inner);
      if (typeof inner !== 'object' || inner === null) return inner;
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(inner)) return '[Circular]';
      ancestors.push(inner);
      return inner;
    });
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/** Ollama diagnostics must leave stdout available for the headless result protocol. */
export function createHeadlessLlmBackendDeps(
  verbose: boolean
): Pick<BuildLlmBackendDeps, 'createOllamaBackend' | 'createMultiBackend'> {
  const writeDiagnostic = (...args: unknown[]): void => {
    process.stderr.write(`${sanitizeTerminalText(args.map(arg => capped(renderDiagnostic(arg))).join(' '))}\n`);
  };
  return {
    createMultiBackend: defaultLlmBackendDeps.createMultiBackend,
    createOllamaBackend: host =>
      new OllamaBackend(host, {
        debug: (...args: unknown[]) => {
          if (verbose) writeDiagnostic(...args);
        },
        info: writeDiagnostic,
        warn: writeDiagnostic,
        error: writeDiagnostic,
      }),
  };
}
