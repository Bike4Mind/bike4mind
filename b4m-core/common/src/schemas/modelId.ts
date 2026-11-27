import { z } from 'zod';

export const MAX_MODEL_ID_LENGTH = 256;

/** A model id on a request. Leaf module: it must import only zod so the OpenAPI job can load it unbuilt. */
export const ModelIdSchema = z.string().min(1).max(MAX_MODEL_ID_LENGTH);
