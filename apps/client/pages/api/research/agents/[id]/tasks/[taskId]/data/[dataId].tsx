import {
  // dataLakeService,
  researchDataService,
} from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  FabFile,
  FabFileChunk,
  fabFileRepository,
  Organization,
  researchAgentRepository,
  researchDataRepository,
  Session,
  sessionRepository,
  User,
  userRepository,
} from '@bike4mind/database';
import { getFilesStorage } from '@server/utils/storage';
// import { createIndexName } from '@server/searchIndexes/opensearch';

const handler = baseApi({ auth: true }).delete(
  asyncHandler(async (req, res) => {
    const { id, dataId } = req.query as any;

    await researchDataService.remove(
      req.user.id,
      { id: dataId, researchAgentId: id },
      {
        db: {
          researchAgents: researchAgentRepository,
          researchDatas: researchDataRepository,
          fabFiles: {
            findByIdAndUserId: async (id, userId) => {
              const result = await FabFile.findOne({ _id: id, userId });
              return result?.toJSON() || null;
            },
            findById: async id => {
              const result = await FabFile.findById(id);
              return result?.toJSON() || null;
            },
            findAllInIds: async (ids: string[]) => {
              const result = await FabFile.find({ _id: { $in: ids } });
              return result.map(fabFile => fabFile.toJSON());
            },
            update: async fabFile => {
              return await fabFileRepository.update(fabFile);
            },
            deleteManyInIds: async ids => {
              await fabFileRepository.deleteManyInIds(ids);
            },
          },
          users: {
            findById: (userId: string) => User.findById(userId),
            update: async user => {
              return userRepository.update(user);
            },
            incrementCurrentStorage: async (userId: string, count: number) => {
              // Atomic $inc via the repository - never round-trips the whole (secret-less) user
              // doc, which would wipe the select:false MFA secrets. See UserModel's MFA update guard.
              await userRepository.incrementCurrentStorage(userId, count);
            },
          },
          organizations: {
            incrementCurrentStorage: async (organizationId, count) => {
              const organization = await Organization.findById(organizationId);
              if (!organization) {
                return;
              }
              organization.currentStorageSize = (organization.currentStorageSize || 0) + count;
              await Organization.updateOne({ _id: organization.id }, organization);
            },
          },
          sessions: {
            update: async session => {
              return await sessionRepository.update(session);
            },
            findAllWithKnowledgeId: async knowledgeId => {
              const result = await Session.find({ knowledgeIds: { $in: [knowledgeId] } });
              return result.map(session => session.toJSON());
            },
          },
          fabFileChunks: {
            deleteManyByFabFileId: async fabFileId => {
              await FabFileChunk.deleteMany({ fabFileId });
            },
          },
        },
        storage: {
          delete: async path => {
            try {
              await getFilesStorage().delete(path);
            } catch (e) {
              req.logger.error(e);
              throw e;
            }
          },
        },
        // onDeleteComplete: async (fabFile, sizeToDeduct) => {
        //   const settings = await getSettings(['opensearchDomainEndpoint']);
        //   const endpoint = getSettingsValue('opensearchDomainEndpoint', settings) || '';
        //   const opensearchClient = new dataLakeService.OpenSearchClient(endpoint);
        //   const indexName = createIndexName('vector-chunks');
        //
        //   await opensearchClient.deleteDocumentByQuery(indexName, {
        //     query: {
        //       bool: {
        //         must: [{ match: { parentId: fabFile.id } }, { match: { parentType: 'fabFile' } }],
        //       },
        //     },
        //   });
        // },
      }
    );

    return res.json({});
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
