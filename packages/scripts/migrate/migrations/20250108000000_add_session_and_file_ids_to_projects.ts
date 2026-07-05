import { Project } from '@bike4mind/database';
import { MigrationFile } from '.';

const AddSessionAndFileIdsToProjects: MigrationFile = {
  id: 20250108000000,
  name: 'add_session_and_file_ids_to_projects',
  up: async () => {
    // Add sessionIds and fileIds arrays to all existing projects
    await Project.updateMany({ sessionIds: { $exists: false } }, { $set: { sessionIds: [] } });

    await Project.updateMany({ fileIds: { $exists: false } }, { $set: { fileIds: [] } });
  },
  down: async () => {
    // Remove sessionIds and fileIds arrays from all projects
    await Project.updateMany(
      {},
      {
        $unset: {
          sessionIds: '',
          fileIds: '',
        },
      }
    );
  },
};

export default AddSessionAndFileIdsToProjects;
