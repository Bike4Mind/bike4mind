import { api } from '@client/app/contexts/ApiContext';
import { createOptimisticQuest, updateOptimisticQuest } from '@client/app/utils/llm';
import {
  IChatHistoryItemDocument,
  VideoModelName,
  IFabFileDocument,
  B4MLLMTools,
  SoraVideoSize,
  SoraDuration,
  VIDEO_SIZE_CONSTRAINTS,
} from '@bike4mind/common';
import { ISessionDocument } from '@bike4mind/common';
import { QueryClient } from '@tanstack/react-query';
import { createOptimisticSessionId } from '@client/app/utils/llm';

export type VideoGenerationCommandArgs = {
  /** Prompt */
  params: string;
  currentSession: ISessionDocument | null;
  workBenchFiles: IFabFileDocument[];
  questId?: string;
  queryClient: QueryClient;
  model: VideoModelName;
  tools: B4MLLMTools[];
  organizationId?: string | null;
  setChatCompletion?: (updater: (prev: any) => any) => void;
  /** tmpId set by useSendMessage during /new pre-navigation. Must be used to key
   * the optimistic placeholder so the session.created cache migration finds it. */
  optimisticSessionId?: string;
  // Video-specific options (optional - will use defaults)
  videoSize?: SoraVideoSize;
  videoSeconds?: SoraDuration;
};

export async function handleVideoGenerationCommand(args: VideoGenerationCommandArgs): Promise<void> {
  const {
    params,
    currentSession,
    questId,
    queryClient,
    model,
    workBenchFiles,
    tools,
    organizationId,
    videoSize,
    videoSeconds,
    optimisticSessionId,
  } = args;

  const tmpSessionId = optimisticSessionId ?? createOptimisticSessionId();

  const optimisticOperation = questId
    ? (cb: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>) =>
        updateOptimisticQuest(
          queryClient,
          questId,
          currentSession?.id,
          { replies: [], reply: undefined, prompt: params, timestamp: new Date(), status: undefined },
          cb
        )
    : currentSession?.id || tmpSessionId
      ? (cb: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>) =>
          createOptimisticQuest(
            queryClient,
            currentSession?.id || tmpSessionId,
            `${params}\n\n_Generating video..._ 🎬`,
            cb
          )
      : async (cb: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>) => {
          // For new sessions: call API first, then optimistically update cache with response
          const result = await cb();
          return result;
        };

  const fabFileIds = workBenchFiles.map(file => file.id);

  // Use video-specific defaults, not image settings
  const requestBody = {
    prompt: params,
    sessionId: currentSession?.id,
    questId,
    model,
    fabFileIds,
    tools,
    organizationId,
    // Video-specific parameters with defaults
    size: videoSize ?? VIDEO_SIZE_CONSTRAINTS.SORA.defaultSize,
    seconds: videoSeconds ?? VIDEO_SIZE_CONSTRAINTS.SORA.defaultDuration,
  };

  try {
    await optimisticOperation(async () => {
      const { data } = await api.post<{ session: ISessionDocument; quest: IChatHistoryItemDocument }>(
        `/api/ai/generate-video`,
        requestBody
      );
      return data;
    });
  } catch (e) {
    console.error(e);
  }
}
