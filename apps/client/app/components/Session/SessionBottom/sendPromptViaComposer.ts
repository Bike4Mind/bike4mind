import type { TFunction } from 'i18next';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
import { getSendBlockedLabel, type SendBlockedReason } from './sendBlockedReason';

interface SendPromptViaComposerParams {
  prompt?: string;
  sendBlockedReason: SendBlockedReason | null;
  shouldToastBlockedSend: (reason: SendBlockedReason) => boolean;
  toastInfo: (message: string) => void;
  t: TFunction;
  handleSendClick: (
    prompt?: string,
    options?: { onRefused?: () => void }
  ) => Promise<IChatHistoryItemDocument | undefined>;
}

/**
 * Sends a prompt through the composer's normal path, optionally applying the same
 * `sendBlockedReason` gate the Send button and Enter use - so a reply-choice click during e.g.
 * reconnecting/uploading/loadingModels is refused rather than sent and recorded. Pass `null` for
 * `sendBlockedReason` to skip the gate entirely (programmatic callers like chess, which must
 * send exactly as they did before the gate existed). The single call site for the gate itself
 * (see `getSendBlockedReason`), reused by `handleEditorSubmit` and `sendPromptCallback` so every
 * gated path agrees on whether a send is allowed.
 *
 * Resolves false without calling `handleSendClick` when blocked, and false (without throwing)
 * when the send is refused once in flight; true once it actually went out. Callers that don't
 * need the result (plain Enter-to-send) can ignore it.
 */
export async function sendPromptViaComposer({
  prompt,
  sendBlockedReason,
  shouldToastBlockedSend,
  toastInfo,
  t,
  handleSendClick,
}: SendPromptViaComposerParams): Promise<boolean> {
  if (sendBlockedReason) {
    if (shouldToastBlockedSend(sendBlockedReason)) toastInfo(getSendBlockedLabel(sendBlockedReason, t));
    return false;
  }
  let sent = true;
  await handleSendClick(prompt, {
    onRefused: () => {
      sent = false;
    },
  });
  return sent;
}
