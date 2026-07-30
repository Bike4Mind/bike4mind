import { z } from 'zod';

import { hearthEventKindSchema, hearthMachineBodySchema, hearthEventRefsSchema } from '@bike4mind/hearth';
import { FallbackInfoSchema } from './llm';
import { supportedChatModels } from '../models';
import { shareableDocumentSchema, QUEST_ERROR_CODES } from '../types';
import { AGENT_EXECUTION_STATUSES, type AgentExecutionStatus } from '../constants/agentExecutionStatus';

// Schemas for actions sent over the WebSocket connection.

// Client to Server Actions

export const DataSubscribeRequestAction = z.object({
  action: z.literal('subscribe_query'),
  accessToken: z.string().optional(),
  subscriptionId: z.string(),
  collectionName: z.string(),
  query: z.looseObject({}),
  fields: z.looseObject({}),
  fetchInitialData: z.boolean().prefault(true).optional(),
  clientId: z.string().optional(),
});
export type IDataSubscribeRequestAction = z.infer<typeof DataSubscribeRequestAction>;

export const DataUnsubscribeRequestAction = z.object({
  action: z.literal('unsubscribe_query'),
  accessToken: z.string().optional(),
  subscriptionId: z.string(),
});
export type IDataUnsubscribeRequestAction = z.infer<typeof DataUnsubscribeRequestAction>;

export const HeartbeatAction = z.object({
  action: z.literal('heartbeat'),
});
export type IHeartbeatAction = z.infer<typeof HeartbeatAction>;

export const VoiceSessionSendTranscriptAction = z.object({
  action: z.literal('voice_session_send_transcript'),
  userId: z.string(),
  sessionId: z.string(),
  transcript: z.string(),
  type: z.enum(['input', 'response']),
  conversationItemId: z.string(),
  timestamp: z.coerce.date().optional(),
});
export type IVoiceSessionSendTranscriptAction = z.infer<typeof VoiceSessionSendTranscriptAction>;

/**
 * CLI Completion request over WebSocket (bypasses CloudFront 20s timeout)
 */
export const CliCompletionRequestAction = z.object({
  action: z.literal('cli_completion_request'),
  accessToken: z.string(),
  requestId: z.uuid(),
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.union([z.string(), z.array(z.unknown())]),
      // per-message cache flag (Anthropic only - silently ignored elsewhere)
      cache: z.boolean().optional(),
    })
  ),
  options: z
    .object({
      temperature: z.number().optional(),
      maxTokens: z.number().optional(),
      stream: z.boolean().optional(),
      tools: z.array(z.unknown()).optional(),
      // structured-output contract. Mirrors ResponseFormatSchema in
      // schemas/cliCompletions.ts. Defined inline here to avoid an import cycle
      // between actions.ts and cliCompletions.ts.
      response_format: z
        .discriminatedUnion('type', [
          z.object({ type: z.literal('text') }),
          z.object({
            type: z.literal('json_schema'),
            json_schema: z.object({
              name: z.string(),
              description: z.string().optional(),
              schema: z.record(z.string(), z.any()),
              strict: z.boolean().optional().default(true),
            }),
          }),
        ])
        .optional(),
    })
    .optional(),
});
export type ICliCompletionRequestAction = z.infer<typeof CliCompletionRequestAction>;

/**
 * CLI Tool execution request over WebSocket
 */
export const CliToolRequestAction = z.object({
  action: z.literal('cli_tool_request'),
  accessToken: z.string(),
  requestId: z.uuid(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
});
export type ICliToolRequestAction = z.infer<typeof CliToolRequestAction>;

export const VoiceSessionEndedAction = z.object({
  action: z.literal('voice_session_ended'),
  userId: z.string(),
  model: z.string(),
  sessionId: z.string(),
  usage: z.object({
    audioInputTokens: z.number().min(0),
    audioCachedInputTokens: z.number().min(0),
    audioOutputTokens: z.number().min(0),
    textInputTokens: z.number().min(0),
    textCachedInputTokens: z.number().min(0),
    textOutputTokens: z.number().min(0),
  }),
});
export type IVoiceSessionEndedAction = z.infer<typeof VoiceSessionEndedAction>;

// Server to Client Actions

export const DataSubscriptionUpdateAction = z.object({
  action: z.literal('data_update'),
  subscriptionId: z.string(),
  collectionName: z.string(),
  operationType: z.string(),
  clientId: z.string().optional(),
  data: z.looseObject({
    _id: z.string(),
    id: z.string(),
  }),
});
export type IDataSubscriptionUpdateAction = z.infer<typeof DataSubscriptionUpdateAction>;

export const LLMStatusUpdateAction = z.object({
  action: z.literal('llm_status_update'),
  status: z.string().nullable(),
  clientId: z.string().optional(),
});

export const InboxRefetchAction = z.object({
  action: z.literal('inbox_refetch'),
  status: z.string(),
  clientId: z.string().optional(),
});

export const InvitesRefetchAction = z.object({
  action: z.literal('invites_refetch'),
  status: z.string(),
  clientId: z.string().optional(),
});

export const UpdateCurrentUserAction = z.object({
  action: z.literal('update_current_user'),
  clientId: z.string().optional(),
  user: z
    .object({
      id: z.string(),
      username: z.string(),
      name: z.string(),
      email: z.string(),
      groups: z.array(z.string()),
      isAdmin: z.boolean(),
      storageLimit: z.number(),
      currentStorageSize: z.number(),
    })
    .partial(),
});

export const ResearchTaskStatusUpdateAction = z.object({
  action: z.literal('research_task_status_update'),
  taskId: z.string(),
  status: z.string(),
  currentStep: z.string(),
  progress: z.number(),
});

export const NotebookCurationProgressUpdateAction = z.object({
  action: z.literal('notebook_curation_progress'),
  curationJobId: z.string(),
  sessionId: z.string(),
  status: z.enum(['pending', 'loading', 'extracting', 'generating', 'storing', 'completed', 'failed']),
  stage: z.enum(['loading', 'extracting', 'generating', 'storing']).optional(),
  percentage: z.number(),
  message: z.string().optional(),
  messagesProcessed: z.number().optional(),
  totalMessages: z.number().optional(),
  artifactsFound: z.number().optional(),
  curatedFileId: z.string().optional(),
  errorMessage: z.string().optional(),
  tokensDeducted: z.number().optional(),
  clientId: z.string().optional(),
});
export type INotebookCurationProgressUpdateAction = z.infer<typeof NotebookCurationProgressUpdateAction>;

export const QuestExportProgressAction = z.object({
  action: z.literal('quest_export_progress'),
  exportJobId: z.string(),
  planId: z.string(),
  status: z.enum(['assembling', 'downloading_images', 'summarizing', 'zipping', 'completed', 'failed']),
  progress: z.number(),
  detail: z.string().optional(),
  downloadUrl: z.string().optional(),
  filename: z.string().optional(),
  errorMessage: z.string().optional(),
  clientId: z.string().optional(),
});
export type IQuestExportProgressAction = z.infer<typeof QuestExportProgressAction>;

export const SpiderProgressUpdateAction = z.object({
  action: z.literal('spider_progress'),
  spiderJobId: z.string(),
  notebooksProcessed: z.number(),
  totalNotebooks: z.number(),
  currentOperation: z.string(),
  currentNotebookId: z.string().optional(),
  currentNotebookName: z.string().optional(),
  dryRun: z.boolean().optional(),
  clientId: z.string().optional(),
});
export type ISpiderProgressUpdateAction = z.infer<typeof SpiderProgressUpdateAction>;

export const SpiderCompleteAction = z.object({
  action: z.literal('spider_complete'),
  spiderJobId: z.string(),
  totalNotebooks: z.number(),
  stats: z.object({
    messageCountsUpdated: z.number(),
    notebooksCurated: z.number(),
    notebooksSummarized: z.number(),
    notebooksTagged: z.number(),
    messagesEmbedded: z.number().optional(),
    errors: z.number().optional(),
    skipped: z.number().optional(),
  }),
  dryRun: z.boolean().optional(),
  clientId: z.string().optional(),
});
export type ISpiderCompleteAction = z.infer<typeof SpiderCompleteAction>;

export const SpiderErrorAction = z.object({
  action: z.literal('spider_error'),
  spiderJobId: z.string(),
  error: z.string(),
  notebooksProcessed: z.number().optional(),
  totalNotebooks: z.number(),
  dryRun: z.boolean().optional(),
  clientId: z.string().optional(),
});
export type ISpiderErrorAction = z.infer<typeof SpiderErrorAction>;

// Pi History Analysis Actions
export const PiHistoryProgressAction = z.object({
  action: z.literal('pi_history_progress'),
  analysisJobId: z.string(),
  repoFullName: z.string(),
  phase: z.enum([
    'fetching_issues',
    'fetching_prs',
    'calculating_stats',
    'building_profiles',
    'extracting_keywords',
    'saving',
  ]),
  percentage: z.number(),
  message: z.string(),
  itemsProcessed: z.number().optional(),
  totalItems: z.number().optional(),
  clientId: z.string().optional(),
});
export type IPiHistoryProgressAction = z.infer<typeof PiHistoryProgressAction>;

export const PiHistoryCompleteAction = z.object({
  action: z.literal('pi_history_complete'),
  analysisJobId: z.string(),
  repoFullName: z.string(),
  stats: z.object({
    closedIssues: z.number(),
    mergedPRs: z.number(),
    contributors: z.number(),
  }),
  clientId: z.string().optional(),
});
export type IPiHistoryCompleteAction = z.infer<typeof PiHistoryCompleteAction>;

export const PiHistoryErrorAction = z.object({
  action: z.literal('pi_history_error'),
  analysisJobId: z.string(),
  repoFullName: z.string(),
  error: z.string(),
  phase: z.string(),
  clientId: z.string().optional(),
});
export type IPiHistoryErrorAction = z.infer<typeof PiHistoryErrorAction>;

export const StreamedChatCompletionAction = z.object({
  action: z.literal('streamed_chat_completion'),
  clientId: z.string().optional(),
  statusMessage: z.string().nullable().optional(),
  quest: z
    .object({
      id: z.string(),
      sessionId: z.string(),
      reply: z.string().nullable().optional(),
      replies: z.array(z.string()).optional(),
      images: z.array(z.string()).optional(),
      videos: z.array(z.string()).optional(),
      type: z.enum(['message', 'oob', 'error', 'system', 'voice_transcript']),
      status: z.enum(['stopped', 'running', 'done']).optional(),
      // Machine-readable classifier for `type: 'error'` quests so the client can render a
      // targeted error state (e.g. the inline "Add Credits" CTA) rather than raw `reply` text.
      // Values derive from QUEST_ERROR_CODES so this enum can't drift from the TS union.
      errorCode: z.enum(QUEST_ERROR_CODES).optional(),
      questMasterReply: z.string().nullable().optional(),
      questMasterPlanId: z.string().optional(),
      creditsUsed: z.number().optional(),
      updatedAt: z.date().optional(),
      prompt: z.string().optional(),
      researchModeResults: z
        .array(
          z.object({
            configurationId: z.string(),
            success: z.boolean(),
            response: z.string().optional(),
            error: z.string().optional(),
            completionInfo: z
              .object({
                inputTokens: z.number(),
                outputTokens: z.number(),
              })
              .optional(),
          })
        )
        .optional(),
      deepResearchState: z
        .object({
          findings: z.array(
            z.object({
              text: z.string(),
              source: z.string(),
            })
          ),
          activities: z.array(
            z.object({
              type: z.enum(['search', 'extract', 'analyze', 'reasoning', 'synthesis', 'thought']),
              status: z.enum(['pending', 'complete', 'error']),
              message: z.string(),
              timestamp: z.string(),
              depth: z.number(),
            })
          ),
          sources: z.array(
            z.object({
              url: z.string(),
              title: z.string(),
              description: z.string(),
              status: z.enum(['found', 'analyzing', 'complete', 'error']),
              timestamp: z.string(),
            })
          ),
          depth: z.number(),
          completed: z.boolean(),
          nextSearchQueries: z.array(z.string()),
          completedSteps: z.number(),
          totalExpectedSteps: z.number(),
          topic: z.string().optional(),
          startTime: z.number().optional(),
          endTime: z.number().optional(),
        })
        .optional(),
      // Add fallback info to support backend fallback mechanism
      fallbackInfo: FallbackInfoSchema.optional(),
      // MCP confirmation action awaiting user approval (confirm/cancel buttons)
      pendingAction: z
        .object({
          tool: z.string(),
          params: z.record(z.string(), z.unknown()),
          ts: z.number(),
        })
        .optional(),
      // UI side-effects dispatched on the client when streaming completes
      uiSideEffects: z
        .array(
          z.object({
            type: z.string(),
            payload: z.unknown(),
          })
        )
        .optional(),
    })
    .partial()
    .nullable(),
});

export const StreamedRapidReplyAction = z.object({
  action: z.literal('streamed_rapid_reply'),
  clientId: z.string().optional(),
  questId: z.string(),
  sessionId: z.string(),
  rapidReply: z.object({
    content: z.string(),
    status: z.enum(['streaming', 'completed', 'replaced']),
    ttfvt: z.number().optional(), // Time to first visible token
    modelId: z.string(),
    mappingId: z.string(),
  }),
  statusMessage: z.string().nullable().optional(),
});
export type IStreamedRapidReplyAction = z.infer<typeof StreamedRapidReplyAction>;

export const HeartbeatPongAction = z.object({
  action: z.literal('pong'),
  clientId: z.string().optional(),
});

/**
 * Invalidates the @tanstack/react-query cache on the client to trigger a
 * re-fetch when server data changes.
 */
export const InvalidateQueryAction = z.object({
  action: z.literal('invalidate_query'),
  queryKey: z.array(z.unknown()),
});

/**
 * Temporary ws action until the collection/document subscription feature lands.
 */
export const UpdateFabFileChunkVectorStatusAction = z.object({
  action: z.literal('update_file_chunk_vector_status'),
  clientId: z.string().optional(),
  fabFileId: z.string(),
  chunkStatus: z.enum(['ongoing', 'complete', 'failed']).optional(),
  vectorizeStatus: z.enum(['ongoing', 'complete', 'failed']).optional(),
  failedMessage: z.string().optional(),
});

export const DataLakeBatchProgressAction = z.object({
  action: z.literal('data_lake_batch_progress'),
  clientId: z.string().optional(),
  batchId: z.string(),
  uploadedFiles: z.number().optional(),
  chunkedFiles: z.number().optional(),
  vectorizedFiles: z.number().optional(),
  failedFiles: z.number().optional(),
  totalFiles: z.number().optional(),
  status: z
    .enum(['preparing', 'uploading', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled'])
    .optional(),
});

/** Verdict for a freshly-uploaded FabFile after the S3-event moderation scan. */
export const ImageModerationStatusAction = z.object({
  action: z.literal('image_moderation_status'),
  clientId: z.string().optional(),
  fabFileId: z.string(),
  moderationStatus: z.enum(['pending', 'clean', 'blocked']),
});

export const UpdateResearchTaskStatusAction = z.object({
  action: z.literal('update_research_task_status'),
  clientId: z.string().optional(),
  researchTaskId: z.string(),
  status: z.enum(['ongoing', 'complete', 'failed']).optional(),
  failedMessage: z.string().optional(),
});

export const ImportHistoryJobProgressUpdateAction = z.object({
  action: z.literal('import_history_job_progress'),
  importHistoryJobId: z.string(),
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled']),
  progress: z.number(),
  currentStep: z.string(),
  processedItems: z.number().optional(),
  totalItems: z.number().optional(),
  errorMessage: z.string().optional(),
  clientId: z.string().optional(),
});
export type IImportHistoryJobProgressUpdateAction = z.infer<typeof ImportHistoryJobProgressUpdateAction>;

/**
 * Research Mode streaming action for parallel model processing
 */
export const ResearchModeStreamAction = z.object({
  action: z.literal('research_mode_stream'),
  quest: z
    .object({
      id: z.string(),
      sessionId: z.string(),
    })
    .optional(),
  researchMode: z
    .object({
      configurationId: z.string(),
      streamedTexts: z.array(z.string().nullable()),
      completionInfo: z.any().optional(),
    })
    .optional(),
});
export type IResearchModeStreamAction = z.infer<typeof ResearchModeStreamAction>;

export const VoiceCreditsExhaustedAction = z.object({
  action: z.literal('voice_credits_exhausted'),
  creditsUsed: z.number(),
  clientId: z.string().optional(),
});
export type IVoiceCreditsExhaustedAction = z.infer<typeof VoiceCreditsExhaustedAction>;

/**
 * CLI Completion chunk sent from server over WebSocket
 * Mirrors SSEContentEvent shape for minimal server-side changes
 */
export const CliCompletionChunkAction = z.object({
  action: z.literal('cli_completion_chunk'),
  requestId: z.string(),
  chunk: z.object({
    type: z.enum(['content', 'tool_use']),
    text: z.string(),
    tools: z.array(z.unknown()).optional(),
    usage: z
      .object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
      })
      .optional(),
    thinking: z.array(z.unknown()).optional(),
  }),
});
export type ICliCompletionChunkAction = z.infer<typeof CliCompletionChunkAction>;

/**
 * CLI Completion stream finished successfully
 */
export const CliCompletionDoneAction = z.object({
  action: z.literal('cli_completion_done'),
  requestId: z.string(),
});
export type ICliCompletionDoneAction = z.infer<typeof CliCompletionDoneAction>;

/**
 * CLI Completion stream error
 */
export const CliCompletionErrorAction = z.object({
  action: z.literal('cli_completion_error'),
  requestId: z.string(),
  error: z.string(),
});
export type ICliCompletionErrorAction = z.infer<typeof CliCompletionErrorAction>;

/**
 * CLI Tool execution response over WebSocket
 */
export const CliToolResponseAction = z.object({
  action: z.literal('cli_tool_response'),
  requestId: z.string(),
  success: z.boolean(),
  content: z.unknown().optional(),
  error: z.string().optional(),
});
export type ICliToolResponseAction = z.infer<typeof CliToolResponseAction>;

// Keep Command Actions (Web HUD <-> CLI relay)

/** Keep command types enum - shared between request and action */
export const KeepCommandType = z.enum([
  'read_file',
  'list_directory',
  'run_tool',
  // Jupyter kernel commands
  'jupyter_start_kernel',
  'jupyter_execute_cell',
  'jupyter_stop_kernel',
  'jupyter_get_kernelspecs',
  // Full notebook execution (CLI orchestrates cell-by-cell execution)
  'jupyter_execute_notebook',
]);
export type IKeepCommandType = z.infer<typeof KeepCommandType>;

/** Web HUD -> Server: request a command be sent to the Keep (CLI) */
export const KeepCommandRequestAction = z.object({
  action: z.literal('keep_command_request'),
  accessToken: z.string().optional(),
  commandType: KeepCommandType,
  params: z.record(z.string(), z.unknown()),
  requestId: z.string(),
});
export type IKeepCommandRequestAction = z.infer<typeof KeepCommandRequestAction>;

/** Server -> CLI: forwarding the command to the Keep */
export const KeepCommandAction = z.object({
  action: z.literal('keep_command'),
  commandType: KeepCommandType,
  params: z.record(z.string(), z.unknown()),
  requestId: z.string(),
  originConnectionId: z.string(),
});
export type IKeepCommandAction = z.infer<typeof KeepCommandAction>;

/** CLI -> Server: Keep sending result back */
export const KeepCommandResponseAction = z.object({
  action: z.literal('keep_command_response'),
  requestId: z.string(),
  originConnectionId: z.string(),
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type IKeepCommandResponseAction = z.infer<typeof KeepCommandResponseAction>;

/** Server -> Web HUD: forwarding result to the requesting client */
export const KeepCommandResultAction = z.object({
  action: z.literal('keep_command_result'),
  requestId: z.string(),
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type IKeepCommandResultAction = z.infer<typeof KeepCommandResultAction>;

// Jupyter Notebook Execution Actions

/** CLI -> Server: Jupyter cell output chunk (streaming) */
export const JupyterCellOutputAction = z.object({
  action: z.literal('jupyter_cell_output'),
  requestId: z.string(),
  sessionId: z.string(),
  jupyterSessionId: z.string(),
  cellIndex: z.number(),
  outputType: z.enum(['stream', 'execute_result', 'display_data', 'error']),
  content: z.object({
    text: z.string().optional(),
    name: z.string().optional(), // stdout, stderr for stream outputs
    data: z.record(z.string(), z.unknown()).optional(), // MIME type -> data for rich outputs
    ename: z.string().optional(), // Error name
    evalue: z.string().optional(), // Error value
    traceback: z.array(z.string()).optional(),
  }),
  executionCount: z.number().nullable().optional(),
  isComplete: z.boolean(),
});
export type IJupyterCellOutputAction = z.infer<typeof JupyterCellOutputAction>;

/** Server -> Client: Jupyter notebook execution progress */
export const JupyterNotebookProgressAction = z.object({
  action: z.literal('jupyter_notebook_progress'),
  questId: z.string(),
  sessionId: z.string(),
  status: z.enum([
    'generating', // LLM generating notebook
    'kernel_starting', // Starting Jupyter kernel
    'executing', // Executing cells
    'cell_complete', // A cell finished executing
    'error', // Cell execution error
    'retrying', // Retrying failed cell with LLM fix
    'completed', // All cells executed successfully
    'failed', // Notebook execution failed after retries
  ]),
  cellIndex: z.number().optional(),
  totalCells: z.number().optional(),
  currentCellCode: z.string().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  notebookPath: z.string().optional(),
  fabFileId: z.string().optional(), // Set when notebook is saved
});
export type IJupyterNotebookProgressAction = z.infer<typeof JupyterNotebookProgressAction>;

// Tavern Scene Command Actions (Game Engine over WebSocket)

/** Zod schema for a single scene command (discriminated by 'type') */
const TilePositionSchema = z.object({ x: z.number(), y: z.number() });

const SceneCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add_entity'),
    params: z.object({
      id: z.string(),
      spriteSheetId: z.string(),
      position: TilePositionSchema,
      facing: z.enum(['left', 'right']).optional(),
      animation: z.string().optional(),
      visible: z.boolean().optional(),
      zIndex: z.number().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  z.object({ type: z.literal('remove_entity'), id: z.string() }),
  z.object({
    type: z.literal('walk_to'),
    id: z.string(),
    target: TilePositionSchema,
    options: z.object({ speed: z.number().optional() }).optional(),
  }),
  z.object({ type: z.literal('teleport'), id: z.string(), position: TilePositionSchema }),
  z.object({ type: z.literal('play_animation'), id: z.string(), animation: z.string(), loop: z.boolean().optional() }),
  z.object({
    type: z.literal('show_speech'),
    id: z.string(),
    text: z.string(),
    options: z
      .object({
        duration: z.number().optional(),
        style: z.enum(['speech', 'thought', 'shout']).optional(),
      })
      .optional(),
  }),
  z.object({ type: z.literal('clear_speech'), id: z.string() }),
  z.object({ type: z.literal('set_visible'), id: z.string(), visible: z.boolean() }),
  z.object({ type: z.literal('set_facing'), id: z.string(), facing: z.enum(['left', 'right']) }),
  z.object({
    type: z.literal('modify_tiles'),
    edits: z.array(
      z.object({
        layer: z.enum(['ground', 'walls', 'structures', 'furniture', 'decoration']),
        col: z.number(),
        row: z.number(),
        gid: z.number(),
      })
    ),
    worldVersion: z.number().optional(),
    floorId: z.string().optional(),
  }),
  z.object({
    type: z.literal('change_floor'),
    id: z.string(),
    floorId: z.string(),
    position: TilePositionSchema,
  }),
  z.object({
    type: z.literal('update_metadata'),
    id: z.string(),
    patch: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal('dungeon_expired'), dungeonId: z.string() }),
]);

/** Client -> Server: send scene commands to broadcast to all HUD clients */
export const TavernSceneCommandRequestAction = z.object({
  action: z.literal('tavern_scene_command'),
  accessToken: z.string().optional(),
  commands: z.array(SceneCommandSchema),
  requestId: z.string().optional(),
});
export type ITavernSceneCommandRequestAction = z.infer<typeof TavernSceneCommandRequestAction>;

/** Server -> Client: broadcast scene commands to all HUD clients */
export const TavernSceneBroadcastAction = z.object({
  action: z.literal('tavern_scene_broadcast'),
  commands: z.array(SceneCommandSchema),
  clientId: z.string().optional(),
});
export type ITavernSceneBroadcastAction = z.infer<typeof TavernSceneBroadcastAction>;

/** Server -> Client: heartbeat log event for the activity log UI */
export const TavernHeartbeatLogAction = z.object({
  action: z.literal('tavern_heartbeat_log'),
  entry: z.object({
    id: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    action: z.enum([
      'idle',
      'speech',
      'thought',
      'memory',
      'move',
      'reply',
      'post_quest',
      'claim_quest',
      'complete_quest',
      'tool_use',
      'email',
      'move_decoration',
      'place_tile',
      'remove_tile',
      'clear_area',
      'build_room',
      'gate_paused',
      'gate_timed',
      'gate_proceed',
      'yolo_override',
      'intent',
      'report',
      'credits',
    ]),
    text: z.string().optional(),
    toolOutput: z.string().optional(),
    targetAgentName: z.string().optional(),
    threadId: z.string().optional(),
    timestamp: z.string(),
    burstId: z.string().optional(),
    stepIndex: z.number().optional(),
    totalSteps: z.number().optional(),
    confidence: z.number().optional(),
    confidenceSource: z.string().optional(),
    creditsUsed: z.number().optional(),
    energy: z.number().optional(),
    curiosity: z.number().optional(),
    artifact: z
      .object({
        type: z.enum(['mermaid', 'recharts', 'image']),
        data: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
      })
      .optional(),
  }),
});
export type ITavernHeartbeatLogAction = z.infer<typeof TavernHeartbeatLogAction>;

/**
 * Server -> Client: a Hearth event appended to a channel the user participates
 * in. Payload mirrors the wire shape consumed by the CLI HearthEventStream and
 * the SPA channel view; keep in sync with b4m-core/hearth/src/types.ts.
 */
export const HearthEventAction = z.object({
  action: z.literal('hearth_event'),
  // kind/machine/refs come from the @bike4mind/hearth boundary schemas so the
  // enum lists have a single source of truth across model, route, and action.
  event: z.object({
    id: z.string(),
    channelId: z.string(),
    seq: z.number(),
    actorId: z.string(),
    actorName: z.string().optional(),
    kind: hearthEventKindSchema,
    human: z.object({
      text: z.string(),
      format: z.enum(['md', 'text']),
    }),
    machine: hearthMachineBodySchema.optional(),
    refs: hearthEventRefsSchema.prefault({}),
    createdAt: z.string(),
  }),
});
export type IHearthEventAction = z.infer<typeof HearthEventAction>;

/** Server -> Client: real-time quest board update (replaces polling) */
export const TavernQuestUpdateAction = z.object({
  action: z.literal('tavern_quest_update'),
  /** The full refreshed quest list (top-level only, no sub-quests) */
  quests: z.array(
    z.object({
      _id: z.string(),
      title: z.string(),
      description: z.string(),
      postedByAgentId: z.string(),
      postedByAgentName: z.string(),
      claimedByAgentId: z.string().optional(),
      claimedByAgentName: z.string().optional(),
      status: z.enum(['open', 'claimed', 'completed', 'expired']),
      difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
      reward: z.string().optional(),
      completionNote: z.string().optional(),
      createdAt: z.string(),
      claimedAt: z.string().optional(),
      completedAt: z.string().optional(),
      expiresAt: z.string().optional(),
    })
  ),
});
export type ITavernQuestUpdateAction = z.infer<typeof TavernQuestUpdateAction>;

/** Server -> Client: real-time stock portfolio update for the Stock Corner */
export const TavernStockUpdateAction = z.object({
  action: z.literal('tavern_stock_update'),
  portfolios: z.array(
    z.object({
      agentId: z.string(),
      agentName: z.string(),
      cashBalance: z.number(),
      holdings: z.array(
        z.object({
          symbol: z.string(),
          shares: z.number(),
          avgCostBasis: z.number(),
          currentPrice: z.number(),
          currentValue: z.number(),
          unrealizedPnL: z.number(),
        })
      ),
      totalValue: z.number(),
    })
  ),
});
export type ITavernStockUpdateAction = z.infer<typeof TavernStockUpdateAction>;

/**
 * Claude Code Bridge Actions
 *
 * Bridge (`@bike4mind/cc-bridge`) runs on the user's machine, hosts Claude
 * Code sessions, and forwards events up so each session appears as a sprite
 * in the Tavern. See CLAUDE_CODE_TAVERN_PLAN.md.
 */

/** Lifecycle status of a Claude Code session, as seen by the Tavern. */
export const CcAgentStatus = z.enum([
  'running', // Claude is actively working
  'idle', // session is open but awaiting the next user prompt
  'awaiting_input', // Claude asked the user a question
  'awaiting_permission', // Claude is blocked on a permission request
  'disconnected', // bridge lost contact or session ended
]);
export type ICcAgentStatus = z.infer<typeof CcAgentStatus>;

/**
 * Engine behind a code agent. Drives chip color in the Tavern and gates which
 * command shapes the server will dispatch to the bridge.
 *  - `claude`: the official Claude Code CLI, surfaced via hooks + transcript
 *    tail (observer+). Read-only - no interactive commands.
 *  - `sdk-embedded`: Claude Agent SDK hosted in-process inside cc-bridge.
 *    Interactive - prompt composer + permission resolver + abort.
 *  - `b4m-cli`: the in-house `@bike4mind/cli` announcing over cc-bridge
 *    loopback. Interactive.
 */
export const CcAgentSource = z.enum(['claude', 'sdk-embedded', 'b4m-cli']);
export type ICcAgentSource = z.infer<typeof CcAgentSource>;

/**
 * Capabilities an agent exposes. Gates interactive UI in `CodeAgentModal`.
 * Open-ended for forward-compat; v1 recognises `interactive` only.
 */
export const CcAgentCapability = z.enum(['interactive']);
export type ICcAgentCapability = z.infer<typeof CcAgentCapability>;

/**
 * Bridge -> Server: announce a new Claude Code session.
 *
 * The server persists an ActiveCodeAgent record keyed by instanceId, picks a
 * sprite, and broadcasts an `add_entity` scene command so every connected tab
 * of the user's account sees the new agent appear in the Tavern.
 */
/** Access-token field shared by all cc-bridge-originated actions so the cap
 *  stays in sync - a token accepted by one endpoint should never be rejected
 *  by another purely because of a schema mismatch. */
const CcBridgeAccessTokenSchema = z.string().max(512).optional();

export const CcAgentRegisterAction = z.object({
  action: z.literal('cc_agent_register'),
  accessToken: CcBridgeAccessTokenSchema,
  /** Stable ID the bridge generates per CC session (uuid). */
  instanceId: z.string().min(1).max(128),
  /** ID of the paired device (from `CcBridgeDevice`). */
  deviceId: z.string().min(1).max(128),
  /** Display name - typically the basename of workspacePath. */
  workspaceName: z.string().min(1).max(200),
  /** Absolute cwd of the CC session on the user's machine. Bound below
   *  Linux PATH_MAX (4096) to keep broadcasts and Mongo docs small. */
  workspacePath: z.string().max(1024),
  /** Claude Code CLI version if the bridge can detect it. */
  claudeVersion: z.string().max(32).optional(),
  /** ISO timestamp the CC session started. */
  startedAt: z.string().max(40),
  /** Engine behind this session. Drives chip color + command dispatch. Older
   *  bridges that predate the interactive path don't send this; server defaults
   *  to `'claude'` (observer+) to preserve their current behavior. */
  source: CcAgentSource.optional(),
  /** Capabilities this session supports. Gates interactive UI affordances in
   *  the modal. Absent == read-only (observer+). `max(8)` is a belt-and-braces
   *  bound; we only recognise `'interactive'` today. */
  capabilities: z.array(CcAgentCapability).max(8).optional(),
});
export type ICcAgentRegisterAction = z.infer<typeof CcAgentRegisterAction>;

/**
 * Bridge -> Server: stream an event for an already-registered session.
 *
 * The bridge populates these events from two sources that can coexist:
 *  1. Claude Code hooks (SessionStart/Stop/Notification/SessionEnd) -> `status`.
 *  2. Tailing the session's transcript.jsonl in `~/.claude/projects/`
 *     (observer+ mode) -> `message`, `tool_use`, `tool_result`.
 *
 * The interactive SDK-embed path (inside cc-bridge, per D13) and B4M CLI
 * announces emit the same shapes plus the `permission_request` /
 * `permission_resolved` variants below for the prompt-the-user flow.
 */
export const CcAgentEventPayload = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
    status: CcAgentStatus,
    /** Optional human-readable reason for the status change. Bounded here
     *  to defend against oversized broadcasts; the server also truncates to
     *  MAX_SUMMARY_LEN before persisting. */
    text: z.string().max(4000).optional(),
  }),
  z.object({
    type: z.literal('message'),
    role: z.enum(['user', 'assistant']),
    /** Full message text (bridge clamps to this cap before sending). */
    text: z.string().max(4000),
  }),
  z.object({
    type: z.literal('tool_use'),
    /** Tool name as emitted by Claude (e.g. `Bash`, `Read`, `Edit`). */
    tool: z.string().min(1).max(128),
    /** Stable ID so a later `tool_result` can be matched back. */
    toolUseId: z.string().min(1).max(128),
    /** Human-readable summary of the tool input (e.g. command, file path).
     *  Bridge pre-summarizes rich inputs; we don't store raw JSON blobs. */
    text: z.string().max(4000).optional(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool: z.string().min(1).max(128).optional(),
    toolUseId: z.string().min(1).max(128),
    /** Result body (truncated by the bridge to this cap). */
    text: z.string().max(4000).optional(),
    isError: z.boolean().optional(),
  }),
  /**
   * Interactive engine -> user: an agent is blocked on a permission question.
   * The modal renders an Allow/Deny resolver; the user's answer round-trips
   * back as `CcAgentCommandAction { type: 'resolve_permission' }`. A later
   * `permission_resolved` event then closes the prompt in the transcript.
   */
  z.object({
    type: z.literal('permission_request'),
    /** Opaque id the agent generated. The resolve command must echo it. */
    requestId: z.string().min(1).max(128),
    /** Tool (or broader capability) the agent wants to use, e.g. `Bash`. */
    toolName: z.string().min(1).max(128),
    /** Human-readable summary of what the agent wants to do. Bridge/CLI
     *  pre-summarizes rich input blobs; this is display-safe. */
    input: z.string().max(4000).optional(),
  }),
  /**
   * Interactive engine -> user: a permission prompt has been resolved (either
   * by the user via the modal, or by a local auto-approve rule). Lets the
   * modal close the resolver UI and render "allowed" / "denied" in-line.
   */
  z.object({
    type: z.literal('permission_resolved'),
    requestId: z.string().min(1).max(128),
    allow: z.boolean(),
    /** Who resolved it; `'auto'` covers SDK/CLI local rules. */
    resolvedBy: z.enum(['user', 'auto']).optional(),
  }),
]);
export type ICcAgentEventPayload = z.infer<typeof CcAgentEventPayload>;

export const CcAgentEventAction = z.object({
  action: z.literal('cc_agent_event'),
  accessToken: CcBridgeAccessTokenSchema,
  instanceId: z.string().min(1).max(128),
  /** ISO timestamp when the event occurred on the user's machine. `.datetime()`
   *  gives an explicit first-line validator; the handler still defends with a
   *  `new Date()` fallback for older bridges. */
  timestamp: z.string().datetime().max(40),
  event: CcAgentEventPayload,
});
export type ICcAgentEventAction = z.infer<typeof CcAgentEventAction>;

/**
 * Bridge -> Server: the CC session ended cleanly.
 *
 * The server also sweeps `ActiveCodeAgent` records on `$disconnect`, so this
 * message is an optimization (immediate despawn) rather than a requirement.
 */
export const CcAgentDisconnectAction = z.object({
  action: z.literal('cc_agent_disconnect'),
  accessToken: CcBridgeAccessTokenSchema,
  instanceId: z.string().min(1).max(128),
  reason: z.string().max(200).optional(),
});
export type ICcAgentDisconnectAction = z.infer<typeof CcAgentDisconnectAction>;

/**
 * Server -> Bridge: a user-driven command the bridge should apply to one of
 * its active sessions. Dispatched by `POST /api/cc-bridge/command` after the
 * server validates ownership + rate-limits, pushed over the bridge's WS via
 * the existing `sendToConnection` mechanism.
 *
 * The bridge is responsible for routing to the right local session and (for
 * external engines like the B4M CLI) forwarding over its loopback back-channel.
 */
export const CcAgentCommandPayload = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('send_prompt'),
    /** Full prompt text. Same cap as user-turn messages; UI will enforce. */
    text: z.string().min(1).max(4000),
  }),
  z.object({
    type: z.literal('resolve_permission'),
    /** Must match the `requestId` from a prior `permission_request` event. */
    requestId: z.string().min(1).max(128),
    allow: z.boolean(),
  }),
  z.object({
    type: z.literal('abort'),
  }),
]);
export type ICcAgentCommandPayload = z.infer<typeof CcAgentCommandPayload>;

export const CcAgentCommandAction = z.object({
  action: z.literal('cc_agent_command'),
  /** Target session on the bridge; bridge looks it up in its session map. */
  instanceId: z.string().min(1).max(128),
  /** Server-minted correlation id so the client can follow up on failures
   *  without racing against the eventual event echo. */
  requestId: z.string().min(1).max(128),
  command: CcAgentCommandPayload,
});
export type ICcAgentCommandAction = z.infer<typeof CcAgentCommandAction>;

export const SessionCreatedAction = shareableDocumentSchema.extend({
  action: z.literal('session.created'),
  id: z.string(),
  name: z.string(),
  userId: z.string(),
  lastUpdated: z.date(),
  firstCreated: z.date(),
  language: z.string().optional(),
  knowledgeIds: z.array(z.string()).optional(),
  artifactIds: z.array(z.string()).optional(),
  toolIds: z.array(z.string()).optional(),
  agentIds: z.array(z.string()).optional(),
  openaiConversationId: z.string().optional(),
  claudeConversationId: z.string().optional(),
  summary: z.string().optional(),
  summaryAt: z.date().optional(),
  summaryTrigger: z.enum(['manual', 'project', 'earlyMilestone', 'contentGrowth', 'throttling']).optional(),
  deletedAt: z.date().optional(),
  tags: z.array(z.object({ name: z.string(), strength: z.number() })).optional(),
  clonedSourceId: z.string().nullable().optional(),
  forkedSourceId: z.string().nullable().optional(),
  isAutoNamed: z.boolean().optional(),
  lastUsedModel: z.string().nullable().optional(),
  summaryModelId: supportedChatModels.optional(),
  curatedNotebookFileId: z.string().optional(),
  curatedAt: z.date().optional(),
  curationContentHash: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/**
 * Agent Execution (Phase 3)
 *
 * Server->client events streamed during a ReAct agent execution. The
 * matching server emitters live in `apps/client/server/queueHandlers/
 * agentExecutor.ts` and `apps/client/server/websocket/agentExecute.ts`.
 *
 * Client->server `agent_execute` commands are validated server-side by
 * the Zod schemas in `agentExecute.ts`; this file only models the
 * inbound (client-bound) side so `subscribeToAction` can be typed.
 */

const AgentStepSchema = z.object({
  type: z.enum(['thought', 'action', 'observation', 'final_answer']),
  content: z.string(),
  metadata: z
    .object({
      toolName: z.string().optional(),
      toolInput: z.unknown().optional(),
      timestamp: z.number(),
      // 0-indexed iteration this step belongs to. Stamped at emit time in
      // ReActAgent.runIteration so persisted checkpoint steps (and replay-
      // from-reconnect) can be grouped back into iteration accordions.
      // Optional for backward compatibility with checkpoints written before
      // this field existed - readers fall back to sequential index.
      iteration: z.number().optional(),
      tokenUsage: z
        .object({
          prompt: z.number(),
          completion: z.number(),
          total: z.number(),
        })
        .optional(),
      confidence: z.number().optional(),
      confidenceSource: z.enum(['deterministic', 'llm_self_report', 'heuristic', 'default']).optional(),
    })
    .optional(),
});
export type IAgentStep = z.infer<typeof AgentStepSchema>;

export const ExecutionStartedAction = z.object({
  action: z.literal('execution_started'),
  executionId: z.string(),
  // The persisted Quest id for the user's originating prompt. Present when
  // `handleStart` wrote a Quest doc at dispatch time; the client uses it to
  // swap its optimistic prompt bubble for a stable id so the bubble survives
  // a reload mid-run instead of vanishing with the React Query cache. See
  // `swapOptimisticPromptBubbleId` on the client.
  questId: z.string().optional(),
});

export const IterationStepAction = z.object({
  action: z.literal('iteration_step'),
  executionId: z.string(),
  iteration: z.number(),
  step: AgentStepSchema,
  isComplete: z.boolean(),
  // UI side-effects a tool emitted during this iteration (same envelope the chat
  // path collects on quest.uiSideEffects). Carried here - NOT on AgentStepSchema,
  // which is persisted into the checkpoint - so they stream live to the console
  // without bloating checkpoints. Optional => backward-compatible with in-flight
  // frames. Client dispatches them through the shared uiSideEffectDispatcher.
  uiSideEffects: z
    .array(
      z.object({
        type: z.string(),
        payload: z.unknown(),
      })
    )
    .optional(),
});

/**
 * Incremental token delta emitted while the TOP-LEVEL agent's LLM call is streaming
 * mid-iteration - the top-level analogue of `subagent_text_delta`. Lets the UI render the
 * agent's reasoning/narration and final answer live instead of waiting for the whole step
 * (a decompose turn can be ~40s). The client appends `delta` to a per-iteration buffer and
 * clears it when the iteration's terminal step arrives via `iteration_step`.
 */
export const AgentTextDeltaAction = z.object({
  action: z.literal('agent_text_delta'),
  executionId: z.string(),
  iteration: z.number(),
  delta: z.string(),
});

/**
 * `progress` is emitted both for status transitions (`status` set) and for
 * per-iteration credit deduction (`creditsUsed` + `iteration` set). One
 * permissive shape; consumers branch on which fields are present.
 */
export const AgentProgressAction = z.object({
  action: z.literal('progress'),
  executionId: z.string(),
  status: z.string().optional(),
  creditsUsed: z.number().optional(),
  iteration: z.number().optional(),
});

export const AgentCompletedAction = z.object({
  action: z.literal('completed'),
  executionId: z.string(),
  answer: z.string().optional(),
  totalIterations: z.number(),
  totalCreditsUsed: z.number(),
  mementoIds: z.array(z.string()).optional(),
});

export const AgentFailedAction = z.object({
  action: z.literal('failed'),
  executionId: z.string(),
  reason: z.string(),
  message: z.string().optional(),
  toolName: z.string().optional(),
});

export const AgentResumedAction = z.object({
  action: z.literal('resumed'),
  executionId: z.string(),
  invocationCount: z.number().optional(),
  reason: z.string().optional(),
});

export const AgentErrorAction = z.object({
  action: z.literal('agent_error'),
  message: z.string(),
  executionId: z.string().optional(),
});

export const AbortAcknowledgedAction = z.object({
  action: z.literal('abort_acknowledged'),
  executionId: z.string(),
});

export const SubagentStartedAction = z.object({
  action: z.literal('subagent_started'),
  executionId: z.string(),
  childExecutionId: z.string(),
  agentName: z.string(),
  model: z.string().optional(),
  thoroughness: z.string().optional(),
  maxIterations: z.number().optional(),
  // Server-side flag set when the orchestrator dispatches the subagent via
  // `delegate_to_agent({ background: true })` - the parent does not wait for
  // the child to finish, and the client surfaces it as a header badge +
  // completion toast rather than nesting it under the triggering iteration
  // step. Optional for backward compatibility with old payloads.
  isBackground: z.boolean().optional(),
  // The execution id of the direct parent that spawned this child.
  // Equals executionId for direct children of the top-level execution, but
  // differs for grandchildren (where executionId is still the top-level for
  // WS routing and parentExecutionId is the intermediate child). Optional for
  // backward compatibility with existing payloads.
  parentExecutionId: z.string().optional(),
});

export const SubagentIterationStepAction = z.object({
  action: z.literal('subagent_iteration_step'),
  executionId: z.string(),
  childExecutionId: z.string(),
  agentName: z.string(),
  iteration: z.number(),
  step: AgentStepSchema,
});

/**
 * Incremental token delta emitted while the subagent's LLM call is streaming
 * mid-iteration. Lets the parent UI render partial responses live
 * instead of waiting 3-5s for the full step to land. The client appends
 * `delta` to a per-(childExecutionId, iteration) buffer and clears it when
 * the iteration's terminal step arrives via `subagent_iteration_step`.
 */
export const SubagentTextDeltaAction = z.object({
  action: z.literal('subagent_text_delta'),
  executionId: z.string(),
  childExecutionId: z.string(),
  agentName: z.string(),
  iteration: z.number(),
  delta: z.string(),
});

export const SubagentCompletedAction = z.object({
  action: z.literal('subagent_completed'),
  executionId: z.string(),
  childExecutionId: z.string(),
  agentName: z.string(),
  totalCredits: z.number(),
  iterations: z.number(),
  finalAnswer: z.string().optional(),
});

export const SubagentFailedAction = z.object({
  action: z.literal('subagent_failed'),
  executionId: z.string(),
  childExecutionId: z.string(),
  error: z.string(),
  isTimeout: z.boolean().optional(),
  partialAnswer: z.string().optional(),
});

/**
 * Humanized in-flight status for a subagent. Emitted by
 * `ServerSubagentOrchestrator` for each `action` step the child agent emits
 * (e.g. "Searching...", "Reading file..."). Lets `SubagentStepNest` show what
 * the child is doing right now instead of a static iteration-count label. The
 * previous wiring routed this string to the parent's `progress` event, which
 * dropped the child correlation - hence a dedicated event.
 */
export const SubagentProgressAction = z.object({
  action: z.literal('subagent_progress'),
  executionId: z.string(),
  childExecutionId: z.string(),
  // Bounded so a misbehaving tool or future change in the emit path can't ship
  // a multi-kilobyte string straight into `SubagentStepNest`'s label. The
  // orchestrator emits `${humanizeToolName(...)}...` or 'Working...' today -
  // 120 chars covers that with headroom and matches the user-facing label width.
  status: z.string().max(120),
});

export const PermissionRequestAction = z.object({
  action: z.literal('permission_request'),
  executionId: z.string(),
  toolName: z.string(),
  toolInput: z.unknown(),
  iteration: z.number(),
});

/**
 * Persisted snapshot of a non-background child subagent execution. Replayed on
 * reconnect so `SubagentStepNest` can re-render the nested iteration
 * trace under the parent's `delegate_to_agent` action step after a hard refresh
 * or once the parent run has terminated. Background children are excluded -
 * they surface via the header badge + completion toast, not inline
 * nesting.
 *
 * `agentName` is sourced from the child doc's `subagentConfig` (now persisted
 * at creation time for every subagent - see `agentExecutor.ts` `onStart`). A
 * generic fallback ("Subagent") is used for legacy docs without it. Empty
 * `steps` is valid for an in-flight in-process child whose terminal write
 * hasn't landed yet - the nest renders the agent header alone in that case.
 */
// Explicit interface required because z.infer can't resolve a recursive type
// through z.lazy() - TypeScript sees the cycle and gives up. Annotating the
// schema as z.ZodType<ChildExecutionSnapshotShape> threads the self-reference
// through the type system so z.infer<typeof ChildExecutionSnapshotSchema>
// resolves to the full shape including the optional nested children.
interface ChildExecutionSnapshotShape {
  executionId: string;
  agentName: string;
  model?: string;
  status: AgentExecutionStatus;
  steps: IAgentStep[];
  totalCredits?: number;
  finalAnswer?: string;
  error?: string;
  isTimeout?: boolean;
  children?: ChildExecutionSnapshotShape[];
}
export const ChildExecutionSnapshotSchema: z.ZodType<ChildExecutionSnapshotShape> = z.lazy(() =>
  z.object({
    executionId: z.string(),
    agentName: z.string(),
    model: z.string().optional(),
    // Why z.enum (not z.string()): the schema is the wire-shape source of
    // truth. Typing `status` as a free string forces every consumer to re-narrow
    // (with a fallback that can lie about state if a new status is added). The
    // enum makes the contract real and lets `z.infer` give consumers the exact
    // `AgentExecutionStatus` union - see `apps/client/.../ReasoningDisclosure`
    // and `useAgentExecution` for the casts this removes.
    status: z.enum(AGENT_EXECUTION_STATUSES),
    steps: z.array(AgentStepSchema),
    totalCredits: z.number().optional(),
    finalAnswer: z.string().optional(),
    error: z.string().optional(),
    isTimeout: z.boolean().optional(),
    // Grandchildren - populated when the server recurses into each child's own
    // child executions. The z.lazy() wrapper is what makes this
    // self-reference valid at runtime; the interface above makes it valid at
    // compile time.
    children: z.array(ChildExecutionSnapshotSchema).optional(),
  })
);

export const ReconnectResultAction = z.object({
  action: z.literal('reconnect_result'),
  found: z.boolean(),
  executionId: z.string().optional(),
  // Same enum reasoning as `ChildExecutionSnapshotSchema.status` - a free
  // string forced the client to re-narrow on every read. `.optional()` because
  // a `found: false` frame omits it.
  status: z.enum(AGENT_EXECUTION_STATUSES).optional(),
  pendingPermission: z
    .object({
      toolName: z.string(),
      toolInput: z.unknown(),
      requestedAt: z.union([z.string(), z.date()]),
    })
    .optional(),
  totalCreditsUsed: z.number().optional(),
  iterationCount: z.number().optional(),
  // Past iteration steps for replay. Server includes inline
  // when the JSON payload stays under the API Gateway WS frame budget
  // (~100KB allowance below the 128KB hard cap). When omitted with
  // `stepsTruncated: true`, the client falls back to fetching the full
  // trace via GET /api/agent-executions/[id].
  steps: z.array(AgentStepSchema).optional(),
  stepsTruncated: z.boolean().optional(),
  // Child subagent snapshots for nested-step replay. Same
  // inline-vs-truncate contract as `steps`: omitted with `childrenTruncated:
  // true` when the combined payload would exceed the frame budget, and the
  // client falls back to fetching them via GET /api/agent-executions/[id].
  children: z.array(ChildExecutionSnapshotSchema).optional(),
  childrenTruncated: z.boolean().optional(),
});

// Union

export const MessageDataToServer = z.discriminatedUnion('action', [
  DataSubscribeRequestAction,
  DataUnsubscribeRequestAction,
  HeartbeatAction,
  VoiceSessionSendTranscriptAction,
  VoiceSessionEndedAction,
  CliCompletionRequestAction,
  CliToolRequestAction,
  KeepCommandRequestAction,
  KeepCommandResponseAction,
  TavernSceneCommandRequestAction,
  JupyterCellOutputAction,
  CcAgentRegisterAction,
  CcAgentEventAction,
  CcAgentDisconnectAction,
]);
export type IMessageDataToServer = z.infer<typeof MessageDataToServer>;

/** Server -> Client: OptiHashi run status update (completion/failure/cancellation) */
export const OptiHashiRunUpdatedAction = z.object({
  action: z.literal('optihashi_run_updated'),
  runId: z.string(),
  status: z.string(),
});
export type IOptiHashiRunUpdatedAction = z.infer<typeof OptiHashiRunUpdatedAction>;

export const MessageDataToClient = z.discriminatedUnion('action', [
  DataSubscriptionUpdateAction,
  InboxRefetchAction,
  LLMStatusUpdateAction,
  InvitesRefetchAction,
  UpdateCurrentUserAction,
  HeartbeatPongAction,
  UpdateFabFileChunkVectorStatusAction,
  StreamedChatCompletionAction,
  StreamedRapidReplyAction,
  InvalidateQueryAction,
  UpdateResearchTaskStatusAction,
  ImportHistoryJobProgressUpdateAction,
  ResearchModeStreamAction,
  ResearchTaskStatusUpdateAction,
  NotebookCurationProgressUpdateAction,
  QuestExportProgressAction,
  SpiderProgressUpdateAction,
  SpiderCompleteAction,
  SpiderErrorAction,
  PiHistoryProgressAction,
  PiHistoryCompleteAction,
  PiHistoryErrorAction,
  SessionCreatedAction,
  VoiceCreditsExhaustedAction,
  CliCompletionChunkAction,
  CliCompletionDoneAction,
  CliCompletionErrorAction,
  CliToolResponseAction,
  KeepCommandAction,
  KeepCommandResultAction,
  TavernSceneBroadcastAction,
  TavernHeartbeatLogAction,
  HearthEventAction,
  TavernQuestUpdateAction,
  TavernStockUpdateAction,
  JupyterNotebookProgressAction,
  DataLakeBatchProgressAction,
  ImageModerationStatusAction,
  CcAgentCommandAction,
  OptiHashiRunUpdatedAction,
  // Agent execution (Phase 3)
  ExecutionStartedAction,
  IterationStepAction,
  AgentProgressAction,
  AgentCompletedAction,
  AgentFailedAction,
  AgentResumedAction,
  AgentErrorAction,
  AbortAcknowledgedAction,
  SubagentStartedAction,
  AgentTextDeltaAction,
  SubagentIterationStepAction,
  SubagentTextDeltaAction,
  SubagentCompletedAction,
  SubagentFailedAction,
  SubagentProgressAction,
  PermissionRequestAction,
  ReconnectResultAction,
]);
export type IMessageDataToClient = z.infer<typeof MessageDataToClient>;
