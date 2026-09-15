import z from 'zod';

export const supportedImageGenerationVendor = z.enum(['openai', 'test', 'bfl', 'xai', 'gemini']);

export type ImageGenerationVendor = z.infer<typeof supportedImageGenerationVendor>;
