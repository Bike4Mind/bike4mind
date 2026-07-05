import { researchAgentService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { researchAgentRepository } from '@bike4mind/database';
import { researchDataRepository } from '@bike4mind/database';
import { NotFoundError } from '@server/utils/errors';
import { FabFile } from '@bike4mind/database';

const handler = baseApi({ auth: true }).get(
  asyncHandler(async (req, res) => {
    const { id } = req.query as any;
    if (!id) throw new NotFoundError('Research agent not found');

    const files = await researchAgentService.listFiles(
      req.user,
      { id },
      {
        db: {
          researchDatas: researchDataRepository,
          researchAgents: researchAgentRepository,
          fabFiles: {
            findAllByIds: async (ids: string[]) => {
              const result = await FabFile.find({ _id: { $in: ids } });
              return result.map(d => d.toJSON());
            },
          },
        },
      }
    );
    return res.json(files);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
