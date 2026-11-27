import { z } from 'zod';
import { ReleaseNotesJobPayloadSchema } from '@bike4mind/common';
import { WhatsNewHighlightsJobSchema } from './whatsNewHighlights.types';

/** Every message on the What's New queue; `kind` selects the handler in `whatsNewJob.ts`. */
export const WhatsNewQueueMessageSchema = z.discriminatedUnion('kind', [
  ReleaseNotesJobPayloadSchema,
  WhatsNewHighlightsJobSchema,
]);

export type WhatsNewQueueMessage = z.infer<typeof WhatsNewQueueMessageSchema>;
