import { fabFileRepository, projectRepository, Session, sessionRepository, User } from '@bike4mind/database';
import { type MigrationFile } from './index';
import { sessionService } from '@bike4mind/services';

const createSession = sessionService.createSession;

const migration: MigrationFile = {
  id: 20240723201224,
  name: 'create sessions for users with no sessions',

  up: async () => {
    const users = await User.find();

    let count = 0;
    let sessionCreated = 0;

    for (const user of users) {
      // A last notebook implies they already have a session, so skip.
      if (user.lastNotebookId) continue;

      const sessions = await Session.find({ userId: user.id });
      // If the user has sessions and has a last notebook, do nothing
      if (sessions.length > 0 && user.lastNotebookId) continue;

      count++;

      if (sessions.length <= 0) {
        // If the user has no sessions, create a default session for them
        const session = await createSession(
          user,
          {
            name: 'New Notebook',
            knowledgeIds: [],
          },
          {
            db: {
              sessions: sessionRepository,
              projects: projectRepository,
              fabFiles: fabFileRepository,
            },
          }
        );

        sessionCreated++;

        user.lastNotebookId = session.id;
        await user.save();
      } else if (!user.lastNotebookId) {
        // If the user has sessions but no last notebook, set the first session as the last notebook
        user.lastNotebookId = sessions[0].id;
        await user.save();
      }
    }

    console.log(`Updated ${count} users. Created ${sessionCreated} sessions.`);
  },

  down: async () => {
    // Do nothing; records were created, we can't really delete them.
  },
};

export default migration;
