import { MigrationFile } from '.';
import { Project } from '@bike4mind/database';

const up = async () => {
  // Update all projects to include systemPrompts array if it doesn't exist
  await Project.updateMany({ systemPrompts: { $exists: false } }, { $set: { systemPrompts: [] } });
};

const down = async () => {
  // Remove systemPrompts field from all projects
  await Project.updateMany({}, { $unset: { systemPrompts: '' } });
};

export default {
  id: 20250108123000,
  name: 'add_system_prompts_to_projects',
  up,
  down,
} as MigrationFile;
