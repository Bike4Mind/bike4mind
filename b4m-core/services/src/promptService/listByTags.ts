import { IPromptDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const listPromptByTagsSchema = z.object({
  tags: z.array(z.string()),
});

type ListPromptByTagsParameters = z.infer<typeof listPromptByTagsSchema>;

interface ListPromptByTagsAdapters {
  db: {
    prompts: {
      findAllWithTags: (tags: string[]) => Promise<IPromptDocument[]>;
    };
  };
}

export const listPromptByTags = async (parameters: ListPromptByTagsParameters, { db }: ListPromptByTagsAdapters) => {
  const { tags } = secureParameters(parameters, listPromptByTagsSchema);

  const prompts = await db.prompts.findAllWithTags(tags);

  return prompts;
};
