import { FabFile, FabFileChunk, Quest, isDocumentDBConnection } from '@bike4mind/database';
import { type MigrationFile } from './index';
import { Types } from 'mongoose';
import { Config } from '../../utils/config';

function useDocumentDBCompatibleApproach(): boolean {
  const mongoUri = Config.MONGODB_URI;
  return isDocumentDBConnection(mongoUri);
}

const migration: MigrationFile = {
  id: 20250210183952,
  name: 'change ids to strings in quests',

  up: async () => {
    if (useDocumentDBCompatibleApproach()) {
      console.log('Using DocumentDB-compatible approach (find/update loop)');

      let questModified = 0,
        questMatched = 0;
      let fabFileModified = 0,
        fabFileMatched = 0;
      let fabFileChunkModified = 0,
        fabFileChunkMatched = 0;

      // Quest documents: Convert ObjectId sessionId to string
      const questDocs = await Quest.find({ sessionId: { $type: 'objectId' } });
      questMatched = questDocs.length;
      for (const doc of questDocs) {
        const stringId = doc.sessionId.toString();
        const result = await Quest.updateOne({ _id: doc._id }, { $set: { sessionId: stringId } });
        if (result.modifiedCount > 0) questModified++;
      }

      // FabFile documents: Convert ObjectId userId to string
      const fabFileDocs = await FabFile.find({ userId: { $type: 'objectId' } });
      fabFileMatched = fabFileDocs.length;
      for (const doc of fabFileDocs) {
        const stringId = doc.userId.toString();
        const result = await FabFile.updateOne({ _id: doc._id }, { $set: { userId: stringId } });
        if (result.modifiedCount > 0) fabFileModified++;
      }

      // FabFileChunk documents: Convert ObjectId fabFileId to string
      const fabFileChunkDocs = await FabFileChunk.find({ fabFileId: { $type: 'objectId' } });
      fabFileChunkMatched = fabFileChunkDocs.length;
      for (const doc of fabFileChunkDocs) {
        const stringId = doc.fabFileId.toString();
        const result = await FabFileChunk.updateOne({ _id: doc._id }, { $set: { fabFileId: stringId } });
        if (result.modifiedCount > 0) fabFileChunkModified++;
      }

      console.log(`Quests: matched ${questMatched}, modified ${questModified}`);
      console.log(`FabFiles: matched ${fabFileMatched}, modified ${fabFileModified}`);
      console.log(`FabFileChunks: matched ${fabFileChunkMatched}, modified ${fabFileChunkModified}`);
    } else {
      console.log('Using MongoDB-native approach (aggregation pipeline)');

      const [questUpdateResult, fabFileUpdateResult, fabFileChunkUpdateResult] = await Promise.all([
        Quest.updateMany({ sessionId: { $type: 'objectId' } }, [
          {
            $set: {
              sessionId: { $toString: '$sessionId' }, // Convert ObjectIds to strings
            },
          },
        ]),
        FabFile.updateMany({ userId: { $type: 'objectId' } }, [
          {
            $set: {
              userId: { $toString: '$userId' }, // Convert ObjectIds to strings
            },
          },
        ]),
        FabFileChunk.updateMany({ fabFileId: { $type: 'objectId' } }, [
          {
            $set: {
              fabFileId: { $toString: '$fabFileId' }, // Convert ObjectIds to strings
            },
          },
        ]),
      ]);

      console.log(`Quests: matched ${questUpdateResult.matchedCount}, modified ${questUpdateResult.modifiedCount}`);
      console.log(
        `FabFiles: matched ${fabFileUpdateResult.matchedCount}, modified ${fabFileUpdateResult.modifiedCount}`
      );
      console.log(
        `FabFileChunks: matched ${fabFileChunkUpdateResult.matchedCount}, modified ${fabFileChunkUpdateResult.modifiedCount}`
      );
    }
  },

  down: async () => {
    if (useDocumentDBCompatibleApproach()) {
      console.log('Using DocumentDB-compatible approach (find/update loop)');

      let questModified = 0,
        questMatched = 0;
      let fabFileModified = 0,
        fabFileMatched = 0;
      let fabFileChunkModified = 0,
        fabFileChunkMatched = 0;

      // Quest documents: Convert string sessionId back to ObjectId
      const questDocs = await Quest.find({ sessionId: { $type: 'string' } });
      questMatched = questDocs.length;
      for (const doc of questDocs) {
        // Only convert if it's a valid ObjectId string
        if (doc.sessionId && doc.sessionId.match(/^[0-9a-fA-F]{24}$/)) {
          const objectId = new Types.ObjectId(doc.sessionId);
          const result = await Quest.updateOne({ _id: doc._id }, { $set: { sessionId: objectId } });
          if (result.modifiedCount > 0) questModified++;
        }
      }

      // FabFile documents: Convert string userId back to ObjectId
      const fabFileDocs = await FabFile.find({ userId: { $type: 'string' } });
      fabFileMatched = fabFileDocs.length;
      for (const doc of fabFileDocs) {
        // Only convert if it's a valid ObjectId string
        if (doc.userId && doc.userId.match(/^[0-9a-fA-F]{24}$/)) {
          const objectId = new Types.ObjectId(doc.userId);
          const result = await FabFile.updateOne({ _id: doc._id }, { $set: { userId: objectId } });
          if (result.modifiedCount > 0) fabFileModified++;
        }
      }

      // FabFileChunk documents: Convert string fabFileId back to ObjectId
      const fabFileChunkDocs = await FabFileChunk.find({ fabFileId: { $type: 'string' } });
      fabFileChunkMatched = fabFileChunkDocs.length;
      for (const doc of fabFileChunkDocs) {
        // Only convert if it's a valid ObjectId string
        if (doc.fabFileId && doc.fabFileId.match(/^[0-9a-fA-F]{24}$/)) {
          const objectId = new Types.ObjectId(doc.fabFileId);
          const result = await FabFileChunk.updateOne({ _id: doc._id }, { $set: { fabFileId: objectId } });
          if (result.modifiedCount > 0) fabFileChunkModified++;
        }
      }

      console.log(`Quests: matched ${questMatched}, modified ${questModified}`);
      console.log(`FabFiles: matched ${fabFileMatched}, modified ${fabFileModified}`);
      console.log(`FabFileChunks: matched ${fabFileChunkMatched}, modified ${fabFileChunkModified}`);
    } else {
      console.log('Using MongoDB-native approach (aggregation pipeline)');

      const [questUpdateResult, fabFileUpdateResult, fabFileChunkUpdateResult] = await Promise.all([
        Quest.updateMany({ sessionId: { $type: 'string' } }, [
          {
            $set: {
              sessionId: { $toObjectId: '$sessionId' }, // Convert strings back to ObjectIds
            },
          },
        ]),
        FabFile.updateMany({ userId: { $type: 'string' } }, [
          {
            $set: {
              userId: { $toObjectId: '$userId' }, // Convert strings back to ObjectIds
            },
          },
        ]),
        FabFileChunk.updateMany({ fabFileId: { $type: 'string' } }, [
          {
            $set: {
              fabFileId: { $toObjectId: '$fabFileId' }, // Convert strings back to ObjectIds
            },
          },
        ]),
      ]);

      console.log(`Quests: matched ${questUpdateResult.matchedCount}, modified ${questUpdateResult.modifiedCount}`);
      console.log(
        `FabFiles: matched ${fabFileUpdateResult.matchedCount}, modified ${fabFileUpdateResult.modifiedCount}`
      );
      console.log(
        `FabFileChunks: matched ${fabFileChunkUpdateResult.matchedCount}, modified ${fabFileChunkUpdateResult.modifiedCount}`
      );
    }
  },
};

export default migration;
