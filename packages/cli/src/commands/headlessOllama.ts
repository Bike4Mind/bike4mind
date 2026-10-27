import { OllamaBackend } from '@bike4mind/llm-adapters';
import { defaultLlmBackendDeps, type BuildLlmBackendDeps } from '../bootstrap/buildLlmBackend.js';
import { sanitizeTerminalText } from '../utils/sanitizeTerminalText.js';

// An Error, at any depth, keeps its String() form so request details attached to it are not dumped.
function renderDiagnostic(value: unknown): string {
  if (typeof value !== 'object' || value === null || value instanceof Error) return String(value);
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (_key, inner: unknown) => {
      if (inner instanceof Error) return String(inner);
      if (typeof inner === 'object' && inner !== null) {
        if (seen.has(inner)) return '[Circular]';
        seen.add(inner);
      }
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
    process.stderr.write(`${sanitizeTerminalText(args.map(renderDiagnostic).join(' '))}\n`);
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
