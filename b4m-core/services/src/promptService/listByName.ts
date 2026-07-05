import { IPromptDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const listPromptByNameSchema = z.object({
  name: z.string(),
});

export type ListPromptByNameParameters = z.infer<typeof listPromptByNameSchema>;

interface ListPromptByNameAdapters {
  db: {
    prompts: {
      findAllByName: (name: string) => Promise<IPromptDocument[]>;
    };
  };
}

export const listPromptByName = async (parameters: ListPromptByNameParameters, { db }: ListPromptByNameAdapters) => {
  const { name } = secureParameters(parameters, listPromptByNameSchema);

  const prompts = await db.prompts.findAllByName(name);

  return prompts;
};
