import z from 'zod';

/**
 * Supported video generation vendors. Currently only OpenAI (Sora).
 */
export const supportedVideoGenerationVendor = z.enum(['openai']);

export type VideoGenerationVendor = z.infer<typeof supportedVideoGenerationVendor>;
