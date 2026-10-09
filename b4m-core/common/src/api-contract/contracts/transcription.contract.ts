import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import {
  CreateTranscriptionRequestSchema,
  CreateTranscriptionUploadRequestSchema,
  TranscriptionResponseSchema,
  TranscriptionUploadResponseSchema,
} from '../../schemas/transcriptionPublic';
import {
  ApiErrorSchema,
  InsufficientCreditsErrorSchema,
  ProviderNotConfiguredErrorSchema,
  ScopeForbiddenErrorSchema,
} from '../../schemas/chat';

/**
 * Speech-to-text for integrators, in two steps: mint an upload, POST the audio straight to storage,
 * then transcribe it. The public twins of the SPA-internal /api/ai/transcribe/init and
 * /api/ai/transcribe; both doors share apps/client/server/transcribe/transcribe.ts.
 */
const FORBIDDEN = { description: 'The API key lacks `ai:generate`.', schema: ScopeForbiddenErrorSchema };
const RATE_LIMITED = { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema };
const NO_CREDITS =
  'Request body failed validation, or the balance cannot cover the estimated cost of transcribing `file_size` ' +
  'bytes (`errorCode: "insufficient_credits"`).';

const UPLOAD_EXAMPLE = { mime_type: 'audio/mpeg', file_size: 482133 };

export const createTranscriptionUploadContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/transcriptions/uploads',
  operationId: 'createTranscriptionUpload',
  summary: 'Start a transcription upload',
  description:
    'Returns a presigned upload for one audio file of at most 25 MiB. POST the audio to `upload_url` as ' +
    '`multipart/form-data`, with every `upload_fields` entry as a form field and the audio last as the ' +
    '`file` field, before `expires_at`. Send no `Authorization` header: the signature is the credential. ' +
    'Storage refuses a type other than `mime_type` or a size outside 1 byte to 25 MiB. Then call ' +
    '`POST /api/v1/transcriptions` with `file_key`.',
  tags: ['Transcriptions'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: CreateTranscriptionUploadRequestSchema,
  requestExample: UPLOAD_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    201: {
      description: 'The upload is ready; POST the audio to `upload_url`.',
      schema: TranscriptionUploadResponseSchema,
      example: {
        upload_url: 'https://<bucket>.s3.amazonaws.com/',
        upload_fields: { key: 'transcribe-uploads/<userId>/<uuid>.mp3', 'Content-Type': 'audio/mpeg', Policy: '...' },
        file_key: 'transcribe-uploads/<userId>/<uuid>.mp3',
        expires_at: '2026-10-09T12:05:00.000Z',
      },
    },
    403: FORBIDDEN,
    422: { description: NO_CREDITS, schema: InsufficientCreditsErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: UPLOAD_EXAMPLE },
});

const TRANSCRIBE_EXAMPLE = { file_key: 'transcribe-uploads/<userId>/<uuid>.mp3' };

export const createTranscriptionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/transcriptions',
  operationId: 'createTranscription',
  summary: 'Transcribe audio',
  description:
    'Transcribes an upload minted by `POST /api/v1/transcriptions/uploads` and returns the text. Call it ' +
    'within 5 minutes of minting the upload. Credits are charged by file size. The uploaded audio is ' +
    'deleted when the call ends, whether it succeeds or fails, so each upload can be transcribed once.\n\n' +
    '**Limit:** this call is synchronous. The request times out after about 60 seconds, while the AWS ' +
    'speech backend can take up to about 5 minutes on long audio, so a long recording can fail with a ' +
    'gateway timeout (`504`) instead of returning text. The upload is deleted either way; mint a new one ' +
    'to retry, or send shorter audio.',
  tags: ['Transcriptions'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: CreateTranscriptionRequestSchema,
  requestExample: TRANSCRIBE_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'The transcript.',
      schema: TranscriptionResponseSchema,
      example: { text: 'Thanks for calling. How can I help?' },
    },
    403: FORBIDDEN,
    404: {
      description: '`file_key` is not one of your uploads, or the upload is missing or expired.',
      schema: ApiErrorSchema,
    },
    422: {
      description:
        'Request body failed validation, the stored audio has an unsupported type or size, or the balance ' +
        'cannot cover its estimated cost (`errorCode: "insufficient_credits"`).',
      schema: InsufficientCreditsErrorSchema,
    },
    429: RATE_LIMITED,
    502: { description: 'The speech provider failed to transcribe the audio.', schema: ApiErrorSchema },
    503: {
      description:
        'This deployment has no speech model, or no credential for its provider, configured ' +
        '(`errorCode: "provider_not_configured"`).',
      schema: ProviderNotConfiguredErrorSchema,
    },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: TRANSCRIBE_EXAMPLE },
});
