import { IPromptDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const listPromptsByTypesSchema = z.object({
  type: z.string(),
});

export type ListPromptsByTypesParameters = z.infer<typeof listPromptsByTypesSchema>;

interface ListPromptsByTypesAdapters {
  db: {
    prompts: {
      findAllByType: (type: string) => Promise<IPromptDocument[]>;
    };
  };
}

export const listPromptsByTypes = async (
  parameters: ListPromptsByTypesParameters,
  { db }: ListPromptsByTypesAdapters
) => {
  const { type } = secureParameters(parameters, listPromptsByTypesSchema);

  const prompts = await db.prompts.findAllByType(type);

  return prompts;
};
