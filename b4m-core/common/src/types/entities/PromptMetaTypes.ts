import { z } from 'zod';
import { PromptMetaZodSchema } from '../../schemas';

export type PromptMeta = z.TypeOf<typeof PromptMetaZodSchema>;

export interface IPromptMetaDocument extends PromptMeta, Document {}
