import { Logger } from '@bike4mind/observability';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { addAbortSignal, Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  LanguageCode,
  MediaFormat,
} from '@aws-sdk/client-transcribe';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { BadRequestError } from '@bike4mind/utils';
import { v4 as uuidv4 } from 'uuid';
import { AllowedAudioMimeType } from './constants';

export interface TranscriptionResult {
  text: string;
}

export interface SpeechModelInfo {
  id: string;
  backend: string;
}

export type TranscriptionOptions = { abortSignal?: AbortSignal };

// Typed against AllowedAudioMimeType so adding a mime to the allowlist
// becomes a compile error here until the AWS mapping is filled in.
const MIME_TO_AWS_MEDIA_FORMAT: Record<AllowedAudioMimeType, MediaFormat> = {
  'audio/mpeg': MediaFormat.MP3,
  'audio/mp4': MediaFormat.MP4,
  'audio/wav': MediaFormat.WAV,
  'audio/webm': MediaFormat.WEBM,
  'audio/ogg': MediaFormat.OGG,
  'audio/flac': MediaFormat.FLAC,
};

const AWS_POLL_INTERVAL_MS = 5000;
const AWS_POLL_MAX_ATTEMPTS = 60; // ~5 minutes total

export class speechService {
  private s3: S3Client;

  constructor(
    private bucketName: string,
    private region = process.env.AWS_REGION || 'us-east-2'
  ) {
    this.s3 = new S3Client({ region: this.region });
  }

  /**
   * Transcribe an audio object already uploaded to S3 by streaming it to the
   * OpenAI Whisper API. The caller is responsible for deleting the S3 object.
   */
  async transcribeOpenAIFromS3(
    s3Key: string,
    mimetype: string,
    speechModelInfo: SpeechModelInfo,
    apiKey: string,
    { abortSignal }: TranscriptionOptions = {}
  ): Promise<TranscriptionResult> {
    abortSignal?.throwIfAborted();
    const openai = new OpenAI({ apiKey: apiKey || undefined, maxRetries: 0 });

    const getResponse = await this.s3.send(new GetObjectCommand({ Bucket: this.bucketName, Key: s3Key }), {
      abortSignal,
    });
    if (!getResponse.Body) throw new BadRequestError('Audio object not found in S3');

    // Derive the filename from the S3 key. Whisper uses the extension as a
    // format hint, and the upload endpoint already encoded the correct
    // extension in the key, so no separate mime-to-ext mapping is needed.
    const filename = s3Key.split('/').pop() || 'audio';
    const body = getResponse.Body as Readable;
    const file = await toFile(abortSignal ? addAbortSignal(abortSignal, body) : body, filename, { type: mimetype });
    abortSignal?.throwIfAborted();

    const transcription = await openai.audio.transcriptions.create(
      {
        file,
        model: speechModelInfo.id,
        response_format: 'json',
        language: 'en',
      },
      { signal: abortSignal }
    );

    return { text: transcription.text || '' };
  }

  /**
   * Start an AWS Transcribe job that reads directly from S3 (no re-upload),
   * poll for completion, and return the transcript text. The caller is
   * responsible for deleting the input audio object; this method cleans up
   * its own transcript output.
   */
  async transcribeAWSFromS3(
    s3Key: string,
    mimetype: string,
    { abortSignal }: TranscriptionOptions = {}
  ): Promise<TranscriptionResult> {
    abortSignal?.throwIfAborted();
    const mediaFormat = MIME_TO_AWS_MEDIA_FORMAT[mimetype as AllowedAudioMimeType];
    if (!mediaFormat) throw new BadRequestError(`Unsupported audio mime type for AWS Transcribe: ${mimetype}`);

    const transcribeClient = new TranscribeClient({ region: this.region });
    const jobName = `transcribe-${uuidv4()}`;
    const transcriptKey = `transcripts/${jobName}.json`;

    try {
      await transcribeClient.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: jobName,
          LanguageCode: LanguageCode.EN_US,
          MediaFormat: mediaFormat,
          Media: { MediaFileUri: `s3://${this.bucketName}/${s3Key}` },
          OutputBucketName: this.bucketName,
          OutputKey: transcriptKey,
        }),
        { abortSignal }
      );

      for (let attempt = 0; attempt < AWS_POLL_MAX_ATTEMPTS; attempt++) {
        await delay(AWS_POLL_INTERVAL_MS, undefined, { signal: abortSignal });

        const getJobResult = await transcribeClient.send(
          new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
          { abortSignal }
        );
        const status = getJobResult.TranscriptionJob?.TranscriptionJobStatus;

        if (status === 'COMPLETED') {
          const getObjectResponse = await this.s3.send(
            new GetObjectCommand({ Bucket: this.bucketName, Key: transcriptKey }),
            { abortSignal }
          );
          if (!getObjectResponse.Body) throw new BadRequestError('Failed to retrieve transcription result');

          if (abortSignal && getObjectResponse.Body instanceof Readable) {
            addAbortSignal(abortSignal, getObjectResponse.Body);
          }
          const transcriptText = await getObjectResponse.Body.transformToString();
          const transcriptData = JSON.parse(transcriptText);
          const text = transcriptData.results?.transcripts?.[0]?.transcript ?? '';

          // Await the delete before returning: in Lambda the container can be
          // frozen as soon as the handler promise resolves, so a fire-and-forget
          // here can leave transcript JSON (which contains the user's verbatim
          // speech) in S3 indefinitely. The bucket lifecycle rule on transcripts/
          // is a backstop, not a substitute.
          try {
            await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: transcriptKey }), {
              abortSignal: AbortSignal.timeout(2_000),
            });
          } catch (err) {
            Logger.globalInstance.warn('Failed to delete AWS Transcribe output:', err);
          }

          return { text };
        }

        if (status === 'FAILED') {
          throw new BadRequestError('Transcription job failed');
        }
      }

      throw new BadRequestError('Transcription job timed out');
    } catch (error) {
      if (abortSignal?.aborted) {
        // AWS cannot cancel an IN_PROGRESS batch job. Stop local I/O and polling; the caller refunds
        // the failed request. Bucket lifecycle rules expire any late transcripts/ output.
        Logger.globalInstance.warn('AWS transcription request aborted; remote job may still finish', {
          jobName,
          transcriptKey,
        });
      }
      throw error;
    }
  }
}
