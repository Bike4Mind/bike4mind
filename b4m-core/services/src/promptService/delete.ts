import { IPromptDocument } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const deletePromptSchema = z.object({
  id: z.string(),
});

type DeletePromptParameters = z.infer<typeof deletePromptSchema>;

interface DeletePromptAdapters {
  db: {
    prompts: {
      findById: (id: string) => Promise<IPromptDocument | null>;
      // Matches BaseRepository.delete, which resolves to the raw driver result.
      delete: (id: string) => Promise<unknown>;
    };
  };
}

export const deletePrompt = async (parameters: DeletePromptParameters, { db }: DeletePromptAdapters) => {
  const { id } = secureParameters(parameters, deletePromptSchema);

  const prompt = await db.prompts.findById(id);
  if (!prompt) throw new NotFoundError(`Prompt with ID ${id} not found`);

  await db.prompts.delete(id);

  return prompt;
};
