import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

/**
 * Shape of the `command` body accepted by `POST /api/cc-bridge/command`.
 * Mirrors `CcAgentCommandPayload` in `@bike4mind/common`; kept as a local
 * type so the hook doesn't pull server zod schemas into the bundle.
 */
export type CcAgentCommand =
  | { type: 'send_prompt'; text: string }
  | { type: 'resolve_permission'; requestId: string; allow: boolean }
  | { type: 'abort' };

export interface CcAgentCommandResult {
  ok: boolean;
  requestId: string;
  error?: string;
}

/**
 * Mutation that dispatches a user command to a live Claude Code agent via
 * the bridge. On success we invalidate the transcript query for the target
 * instance so any echo events show up without waiting for the next
 * metadata-patch-driven refresh.
 */
export function useDispatchCcAgentCommand(instanceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<CcAgentCommandResult, Error, CcAgentCommand>({
    mutationFn: async command => {
      if (!instanceId) throw new Error('instanceId required');
      const response = await api.post<CcAgentCommandResult>('/api/cc-bridge/command', {
        instanceId,
        command,
      });
      return response.data;
    },
    onSuccess: () => {
      if (!instanceId) return;
      // Quick invalidate so the prompt / resolution renders in the transcript
      // as soon as the bridge echoes the event back via WS. Harmless if the
      // echo arrives faster than the refetch.
      void queryClient.invalidateQueries({ queryKey: ['cc-bridge', 'events', instanceId] });
    },
  });
}
