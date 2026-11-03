import type { LoadedModel } from '@bike4mind/local-models';
import { parseLocalModelId } from '@shared/chat';
import { LOCAL_SERVER_ID, serverIdOfRuntime } from '@shared/modelServers';
import type { LoadedModelState } from '@shared/models';
import { OLLAMA_RUNTIME_ID } from '../chat/OllamaLocal';

/** The server a `local:` chat model id runs on and its name there; null for an id naming neither. */
export function loadedStateTarget(modelId: string): { serverId: string; model: string } | null {
  const parsed = parseLocalModelId(modelId);
  if (!parsed) return null;
  if (parsed.runtimeId === OLLAMA_RUNTIME_ID) return { serverId: LOCAL_SERVER_ID, model: parsed.model };
  const serverId = serverIdOfRuntime(parsed.runtimeId);
  return serverId ? { serverId, model: parsed.model } : null;
}

/** Ollama answers to `name` and `name:latest` alike. */
function withTag(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1).includes(':') ? name : `${name}:latest`;
}

export function loadedStateOf(loaded: readonly LoadedModel[], model: string): LoadedModelState {
  const wanted = withTag(model);
  const entry = loaded.find(candidate => withTag(candidate.name) === wanted);
  if (!entry) return { kind: 'unloaded' };
  const expiresAt = entry.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
  return { kind: 'loaded', expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
}
