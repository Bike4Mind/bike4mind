import { IPromptDocument } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const getPromptSchema = z.object({
  id: z.string(),
});

type GetPromptParameters = z.infer<typeof getPromptSchema>;

interface GetPromptAdapters {
  db: {
    prompts: {
      findById: (id: string) => Promise<IPromptDocument | null>;
    };
  };
}

export const getPrompt = async (parameters: GetPromptParameters, { db }: GetPromptAdapters) => {
  const { id } = secureParameters(parameters, getPromptSchema);

  const prompt = await db.prompts.findById(id);

  if (!prompt) throw new NotFoundError(`Prompt with ID ${id} not found`);

  return prompt;
};
