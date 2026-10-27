import { OllamaBackend } from '@bike4mind/llm-adapters';
import { defaultLlmBackendDeps, type BuildLlmBackendDeps } from '../bootstrap/buildLlmBackend.js';
import { sanitizeTerminalText } from '../utils/sanitizeTerminalText.js';

/** Ollama diagnostics must leave stdout available for the headless result protocol. */
export function createHeadlessLlmBackendDeps(
  verbose: boolean
): Pick<BuildLlmBackendDeps, 'createOllamaBackend' | 'createMultiBackend'> {
  const writeDiagnostic = (...args: unknown[]): void => {
    process.stderr.write(`${sanitizeTerminalText(args.map(String).join(' '))}\n`);
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
