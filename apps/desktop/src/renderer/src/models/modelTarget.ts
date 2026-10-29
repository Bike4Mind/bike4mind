import type { ModelServerManagement } from '@shared/models';

/** The server the Models screen is acting on. */
export interface ModelTarget {
  id: string;
  name: string;
  local: boolean;
  management: ModelServerManagement;
}

/** Why the screen offers no downloads or removals for the target; null when it does. */
export function manageNote(target: ModelTarget): string | null {
  if (target.management === 'chat-only')
    return `${target.name} is set to Chat only, so models cannot be downloaded to it or removed from it here. Change that under Settings, Model servers.`;
  if (target.management === 'unsupported')
    return `${target.name} is an OpenAI-compatible server. Desktop lists its models, but downloads and removals need Ollama.`;
  return null;
}
