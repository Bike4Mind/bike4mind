import {
  B4MLLMTools,
  GenerateImageToolCall,
  AudioGenerationToolCall,
  IChatHistoryItemDocument,
  IFabFileDocument,
  IMAGE_MODELS,
  VIDEO_MODELS,
  ISessionDocument,
  ImageModelName,
  VideoModelName,
  LLMApiRequestBody,
  LLMModelConfig,
} from '@bike4mind/common';
import { WebsocketContextValue } from '../contexts/WebsocketContext';
import { ImageEditCommandArgs, ImageGenerationCommandArgs } from '../components/commands/ImageGenerationCommand';
import { LLMSettings } from '../components/commands/LLMCommand';
import { QueryClient } from '@tanstack/react-query';
import { terminalQuests } from '../hooks/chatCompletionState';

type CommandArgs = CommandArgExtra & ImageGenerationCommandArgs & ImageEditCommandArgs & LLMSettings;

export type CommandArgExtra = {
  userId: string;
  username?: string;
  userEmail?: string;
  command: string;
  params: string;
  currentSession: ISessionDocument | null;
  model: string;
  workBenchFiles: IFabFileDocument[];
  sendJsonMessage?: WebsocketContextValue['sendJsonMessage'];
  dashboardParams?: LLMApiRequestBody['dashboardParams'];
  promptFileIds?: string[];
  questId?: string; // If we want to retry a quest response we pass the questId
  // Correct-and-retry target. Distinct from `questId`: that re-runs a quest in place, this
  // sends a new turn carrying the user's correction and links it to the answer it corrects.
  correctsQuestId?: string;
  enableQuestMaster?: boolean;
  enableMementos?: boolean;
  enableArtifacts?: boolean;
  enableAgents?: boolean;
  enableLattice?: boolean;
  queryClient: QueryClient;
  tools: B4MLLMTools[];
  projectId?: string;
  organizationId?: string | null;
  researchMode?: LLMApiRequestBody['researchMode'];
  /** Suppresses the server-side tool auto-offers for this turn. See LLMContext.skipAutoOffers. */
  skipAutoOffers?: LLMApiRequestBody['skipAutoOffers'];
  deepResearchConfig?: {
    maxDepth?: number;
    duration?: number;
  };
  imageConfig?: GenerateImageToolCall;
  audioConfig?: AudioGenerationToolCall;
  modelConfigurations?: LLMModelConfig[];
  setChatCompletion?: (updater: (prev: any) => any) => void;
  userTags?: string[];
  mcpServers?: string[];
  addMessageToSession?: (message: IChatHistoryItemDocument) => void;
  // Client-generated tmpId set by useSendMessage during /new pre-navigation.
  // Command handlers MUST use this when keying optimistic placeholders so the
  // session.created cache migration finds them. Generating a fresh tmp id here
  // breaks the migration -> replace chain and leaves the assistant turn blank.
  optimisticSessionId?: string;
};

export type CommandKey =
  '/llm' | '/roll' | '/key' | '/models' | '/gen_image' | '/gen_video' | '/edit_image' | '/create_agent' | '/feedback';

export type CommandHandlers = {
  [key in CommandKey]?: (args: any) => Promise<void | { session: ISessionDocument; quest: IChatHistoryItemDocument }>;
};

export const handleCommand = async (commandHandlers: CommandHandlers, args: CommandArgs) => {
  const { userId, command, params, ...rest } = args;
  const handler = commandHandlers[command as CommandKey];
  if (handler) {
    // A re-run restarts an existing quest in place; its earlier terminal frame must not mark
    // the new run's chunks stale. Image/video payloads carry no updatedAt to prove recency.
    if (rest.questId) terminalQuests.forget(rest.questId);
    return await handler({ userId, params, ...rest });
  } else {
    throw new Error(`Unknown command ${command}`);
  }
};

export function isImageModel(model: string): model is ImageModelName {
  const imageModel = IMAGE_MODELS.includes(model as ImageModelName);
  return imageModel;
}

export function isVideoModel(model: string): model is VideoModelName {
  const videoModel = VIDEO_MODELS.includes(model as VideoModelName);
  return videoModel;
}

export const extractCommandAndParams = (
  liveAI: boolean,
  model: string,
  lines: number,
  input: string,
  enabledFiles: string[],
  imageEdit?: boolean
): [string, string] => {
  let modifiedChatInputValue = input;

  // Check if input starts with a known command - if so, don't modify it
  const knownCommands = [
    '/create_agent',
    '/feedback',
    '/llm',
    '/roll',
    '/key',
    '/models',
    '/gen_image',
    '/gen_video',
    '/edit_image',
    '/admin',
    '/more',
  ];
  const startsWithCommand = knownCommands.some(cmd => input.startsWith(cmd));

  if (liveAI && !startsWithCommand) {
    modifiedChatInputValue = `[History:${lines}] ${modifiedChatInputValue}`;
    if (enabledFiles.length > 0) {
      enabledFiles.forEach(fileName => {
        modifiedChatInputValue = `[Context:${fileName}] ${modifiedChatInputValue}`;
      });
    }

    if (isImageModel(model)) {
      modifiedChatInputValue = `/gen_image ${input}`;
    } else if (isVideoModel(model)) {
      modifiedChatInputValue = `/gen_video ${input}`;
    } else {
      modifiedChatInputValue = `/llm ${modifiedChatInputValue}`;
    }
    if (imageEdit) {
      modifiedChatInputValue = `/edit_image ${input}`;
    }
  }

  const firstSpaceIndex = modifiedChatInputValue.indexOf(' ');
  const command = firstSpaceIndex === -1 ? modifiedChatInputValue : modifiedChatInputValue.slice(0, firstSpaceIndex);
  const params = firstSpaceIndex === -1 ? '' : modifiedChatInputValue.slice(firstSpaceIndex + 1);
  return [command, params];
};
