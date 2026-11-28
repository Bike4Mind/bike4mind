import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { PartAskKind } from './types';

/**
 * What "Allow in this chat" gave one conversation, as kept on disk beside it (SessionStore's
 * `.chat-allowances` folder) so it survives a restart. Written and read only by ApprovalGate;
 * deleted with the conversation. A record that does not parse is ignored whole: no allowance.
 */
export const storedChatAllowancesSchema = z.object({
  version: z.literal(1),
  /** Exact standing answers, under the gate's standing key (the call's key, plus `#optionId`). */
  answers: z.array(
    z.object({
      key: z.string().min(1),
      optionId: z.string().min(1).optional(),
      value: z.string().optional(),
    })
  ),
  /** What each shell card's "always" allowed, by that card's exact key. */
  shell: z.array(
    z.object({
      key: z.string().min(1),
      patterns: z.array(
        z.object({
          namespace: z.string().min(1),
          pattern: z.string().min(1),
          askedOver: z.array(z.enum(['env'] as const satisfies readonly PartAskKind[])),
        })
      ),
      directories: z.array(z.string().refine(isAbsolute, 'directory must be absolute')),
      /** See commandShape. */
      shapes: z.array(z.object({ namespace: z.string().min(1), shape: z.string().min(1) })),
    })
  ),
});

export type StoredChatAllowances = z.infer<typeof storedChatAllowancesSchema>;

/** Where ApprovalGate keeps each conversation's allowances. See SessionStore. */
export interface ChatAllowanceStore {
  loadChatAllowances(sessionId: string): Promise<unknown>;
  saveChatAllowances(sessionId: string, allowances: StoredChatAllowances): Promise<void>;
  deleteChatAllowances(sessionId: string): Promise<void>;
}
