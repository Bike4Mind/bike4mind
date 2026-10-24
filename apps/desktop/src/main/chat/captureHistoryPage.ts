import type { BrowserPageModel } from '@shared/browserPage';
import type { LocalHistory } from './LocalHistory';
import type { SessionStore } from './SessionStore';

export async function captureHistoryPage(
  sessionId: string,
  model: BrowserPageModel,
  dependencies: {
    history: Pick<LocalHistory, 'capturePage'> | undefined;
    store: Pick<SessionStore, 'get'>;
    scopeKey: () => string | null;
  }
): Promise<void> {
  if (!dependencies.history) return;
  const scope = dependencies.scopeKey();
  if (!scope) return;
  const session = await dependencies.store.get(sessionId);
  if (session?.historyEnabled && dependencies.scopeKey() === scope) {
    dependencies.history.capturePage(sessionId, model);
  }
}
