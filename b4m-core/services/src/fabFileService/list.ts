import { IFabFileDocument, IFabFileRepository, IUserDocument } from '@bike4mind/common';
import { generateSignedUrl, GetFabFileAdapter } from './get';
import { z } from 'zod';

type ListFabFilesAdapters = GetFabFileAdapter & {
  db: GetFabFileAdapter['db'] & {
    fabFiles: Pick<IFabFileRepository, 'shareable'>;
  };
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- consumed via z.infer<typeof listFabFilesSchema> as ListFabFilesParameters; schema name is API contract
const listFabFilesSchema = z.object({
  ids: z.array(z.string()).optional(),
});

export type ListFabFilesParameters = z.infer<typeof listFabFilesSchema>;

export const listFabFiles = async (
  user: IUserDocument,
  params: ListFabFilesParameters,
  { db, storage }: ListFabFilesAdapters
) => {
  let fabFiles: IFabFileDocument[] = [];
  if (params.ids) {
    fabFiles = await db.fabFiles.shareable.findAllAccessibleByIds(user, params.ids);
  } else {
    fabFiles = await db.fabFiles.shareable.findAllAccessible(user);
  }

  const result = await Promise.all(
    fabFiles.map(async fabFile => {
      const res = await generateSignedUrl(fabFile, { db, storage });
      return res;
    })
  );

  return result;
};
