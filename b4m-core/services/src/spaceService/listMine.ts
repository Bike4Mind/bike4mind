import { ISpaceDocument, ISpaceRepository, IUserDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const listMineSchema = z.object({});

interface ListMineAdapters {
  db: { spaces: Pick<ISpaceRepository, 'listForUser'> };
}

export async function listMine(
  user: IUserDocument,
  parameters: z.infer<typeof listMineSchema>,
  adapters: ListMineAdapters
): Promise<ISpaceDocument[]> {
  secureParameters(parameters, listMineSchema);
  return adapters.db.spaces.listForUser(user.id);
}
