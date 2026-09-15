import { IPromptDocument } from '@bike4mind/common';
import { createPromptSchema } from './create';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

// Partial update: only `id` is required; every other field is optional.
const updatePromptSchema = createPromptSchema.partial().extend({
  id: z.string(),
});

type UpdatePromptParameters = z.infer<typeof updatePromptSchema>;

interface UpdatePromptAdapters {
  db: {
    prompts: {
      update: (data: Partial<IPromptDocument>) => Promise<IPromptDocument | null>;
    };
  };
}

export const updatePrompt = async (parameters: UpdatePromptParameters, { db }: UpdatePromptAdapters) => {
  const params = secureParameters(parameters, updatePromptSchema);

  // update (findOneAndUpdate by id) $sets only the validated partial fields and
  // resolves null when no prompt matches the id (missing or deleted concurrently).
  const updated = await db.prompts.update(params);
  if (!updated) throw new NotFoundError('Prompt not found');

  return updated;
};
