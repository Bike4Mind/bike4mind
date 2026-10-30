export const DEFAULT_OLLAMA_PORT = 11434;

/**
 * Gives a scheme-less host Ollama's default port and `http://`, so `gpu-box` means `http://gpu-box:11434`.
 * Hosts with a scheme pass through unchanged.
 */
export function withDefaultOllamaPort(host: string): string {
  const trimmed = host.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  const slash = trimmed.indexOf('/');
  const authority = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const path = slash === -1 ? '' : trimmed.slice(slash);
  const hasPort = /^\[[^\]]*\]:\d+$/.test(authority) || /^[^[\]:]+:\d+$/.test(authority);
  return `http://${authority}${hasPort ? '' : `:${DEFAULT_OLLAMA_PORT}`}${path}`;
}
