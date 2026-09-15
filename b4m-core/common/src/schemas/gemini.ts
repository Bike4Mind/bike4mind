import { ImageModels } from '../models';
import { z } from 'zod';

/**
 * Gemini Image Models (Nano Banana)
 * Based on https://ai.google.dev/gemini-api/docs/image-generation
 */
export const GEMINI_IMAGE_MODELS = [
  ImageModels.GEMINI_2_5_FLASH_IMAGE,
  ImageModels.GEMINI_3_PRO_IMAGE_PREVIEW,
  ImageModels.GEMINI_3_PRO_IMAGE, // Nano Banana Pro
  ImageModels.GEMINI_3_1_FLASH_IMAGE, // Nano Banana 2
] as const;

export type GeminiImageModel = (typeof GEMINI_IMAGE_MODELS)[number];

/**
 * Gemini image generation parameters
 */
export const GeminiImageGenerationInputSchema = z.object({
  prompt: z.string().min(1),
  n: z.number().min(1).max(8).prefault(1).optional(), // Generate up to 8 images
  aspect_ratio: z.string().optional(), // e.g., "16:9", "1:1", "9:16"
  output_format: z.enum(['jpeg', 'png']).prefault('png').optional(),
  safety_tolerance: z.number().min(0).max(1).prefault(0.5).optional(), // 0 = strict, 1 = permissive
});

export type GeminiImageGenerationInput = z.infer<typeof GeminiImageGenerationInputSchema>;

/**
 * Gemini image editing parameters (image + text to image)
 */
export const GeminiImageEditingInputSchema = z.object({
  image: z.string().min(1), // Base64 encoded image or data URL
  prompt: z.string().min(1),
  aspect_ratio: z.string().optional(),
  output_format: z.enum(['jpeg', 'png']).prefault('png').optional(),
  safety_tolerance: z.number().min(0).max(1).prefault(0.5).optional(),
});

export type GeminiImageEditingInput = z.infer<typeof GeminiImageEditingInputSchema>;
