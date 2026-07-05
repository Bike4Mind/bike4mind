import { Artifact, ArtifactContent, ArtifactVersion, QuestMasterArtifact } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20250202100000,
  name: 'create artifact collections',

  up: async () => {
    console.log('Creating artifact collections and indexes...');

    console.log('Creating Artifact indexes...');
    await Artifact.createIndexes();

    console.log('Creating ArtifactContent indexes...');
    await ArtifactContent.createIndexes();

    console.log('Creating ArtifactVersion indexes...');
    await ArtifactVersion.createIndexes();

    console.log('Creating QuestMasterArtifact indexes...');
    await QuestMasterArtifact.createIndexes();

    console.log('Artifact collections and indexes created successfully!');
  },

  down: async () => {
    console.log('Dropping artifact collections...');

    // Drop collections in reverse order to handle dependencies
    console.log('Dropping QuestMasterArtifact collection...');
    await QuestMasterArtifact.collection
      .drop()
      .catch(e => console.log('QuestMasterArtifact collection does not exist or already dropped:', e.message));

    console.log('Dropping ArtifactVersion collection...');
    await ArtifactVersion.collection
      .drop()
      .catch(e => console.log('ArtifactVersion collection does not exist or already dropped:', e.message));

    console.log('Dropping ArtifactContent collection...');
    await ArtifactContent.collection
      .drop()
      .catch(e => console.log('ArtifactContent collection does not exist or already dropped:', e.message));

    console.log('Dropping Artifact collection...');
    await Artifact.collection
      .drop()
      .catch(e => console.log('Artifact collection does not exist or already dropped:', e.message));

    console.log('Artifact collections dropped successfully!');
  },
};

export default migration;
