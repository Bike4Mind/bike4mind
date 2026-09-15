import { IPromptDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

export const createPromptSchema = z.object({
  type: z.string(),
  name: z.string(),
  promptText: z.string(),
  tags: z.array(z.string()),
});

export type CreatePromptParameters = z.infer<typeof createPromptSchema>;

interface CreatePromptAdapters {
  db: {
    prompts: {
      create: (data: Omit<IPromptDocument, 'id'>) => Promise<IPromptDocument>;
    };
  };
}

export const createPrompt = async (parameters: CreatePromptParameters, { db }: CreatePromptAdapters) => {
  const params = secureParameters(parameters, createPromptSchema);

  const build = {
    ...params,

    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const prompt = await db.prompts.create(build);

  return prompt;
};
