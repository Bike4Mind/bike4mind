import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { IMessage, ModelInfo } from '@bike4mind/common';
import type { CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { BackgroundAgentManager } from '../agents/BackgroundAgentManager.js';

/**
 * LLM backend wrapper that injects background agent notifications
 * into the message array before each completion call.
 *
 * When a background agent completes (or fails), the notification
 * appears as a system message so the main agent naturally sees it
 * in context - no polling required.
 */
export class NotifyingLlmBackend implements ICompletionBackend {
  private inner: ICompletionBackend;
  private backgroundManager: BackgroundAgentManager;

  constructor(inner: ICompletionBackend, backgroundManager: BackgroundAgentManager) {
    this.inner = inner;
    this.backgroundManager = backgroundManager;
  }

  get currentModel(): string {
    return this.inner.currentModel;
  }

  set currentModel(model: string) {
    this.inner.currentModel = model;
  }

  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    // Drain any pending notifications from completed background agents
    const notifications = this.backgroundManager.drainNotifications();
    let effectiveMessages = messages;

    if (notifications.length > 0) {
      const notificationText = notifications.join('\n\n---\n\n');
      const notificationMessage: IMessage = {
        role: 'user',
        content: `[System Notification]\n\n${notificationText}\n\nPlease acknowledge these background agent results and incorporate them into your current work.`,
      };

      // Inject notification so the LLM sees it in context
      effectiveMessages = [...messages, notificationMessage];
    }

    return this.inner.complete(model, effectiveMessages, options, callback);
  }

  pushToolMessages(messages: IMessage[], tool: { name: string; id: string; parameters: string }, result: string) {
    return this.inner.pushToolMessages(messages, tool, result);
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return this.inner.getModelInfo();
  }
}
