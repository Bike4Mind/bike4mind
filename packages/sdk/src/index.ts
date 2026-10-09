export {
  buildUrl,
  createClient,
  type AudioResult,
  type B4mClient,
  type CallArgs,
  type ClientOptions,
  type CompletionStreamEvent,
  type JsonBody,
  type JsonResponse,
  type OperationId,
  type PathParams,
  type PollOptions,
  type Quest,
  type QuestHandle,
  type QueryParams,
  type RawInlineAudio,
  type Schemas,
  type TtsResult,
} from './client';
export { B4mApiError, B4mQuestError, parseRetryAfterSeconds } from './errors';
export type { components, operations as Operations, paths } from './generated/openapi';
export { operations } from './generated/operations';
export { parseSse } from './sse';
