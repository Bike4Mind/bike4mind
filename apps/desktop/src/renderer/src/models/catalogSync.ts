import { isLocalBackend, type ChatModelOption } from '@shared/chat';
import { LOCAL_SERVER_ID, type ModelServerKind } from '@shared/modelServers';
import type { LocalModelEntry } from '@shared/models';

/**
 * Mirrors the catalog's own chat filter per server kind: OllamaLocal.ts (needs `completion`) and
 * OpenAICompatibleChat.ts (`!embeddings || completion`), both under apps/desktop/src/main.
 */
function chatCapable(model: LocalModelEntry, kind: ModelServerKind): boolean {
  const { embeddings, completion } = model.capabilities;
  return kind === 'ollama' ? completion : !embeddings || completion;
}

/**
 * Installed chat models the catalog cannot start a chat on, sorted by name: no entry, or one marked
 * unavailable (as `chatWith` in ChatShell.tsx treats it). Models the catalog excludes from chat by
 * design, such as embedding-only ones, are left out.
 */
export function missingFromCatalog(
  installed: readonly LocalModelEntry[],
  serverId: string,
  catalog: readonly ChatModelOption[],
  kind: ModelServerKind = 'ollama'
): string[] {
  const listed = new Set(
    catalog
      .filter(
        option => isLocalBackend(option) && !option.unavailable && (option.server?.id ?? LOCAL_SERVER_ID) === serverId
      )
      .map(option => option.name.toLowerCase())
  );
  return installed
    .filter(model => chatCapable(model, kind) && !listed.has(model.name.toLowerCase()))
    .map(model => model.name)
    .sort();
}
