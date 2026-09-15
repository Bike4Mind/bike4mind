import { organizationRepository, userRepository } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20250321142457,
  name: 'add-user-details-to-org',

  up: async () => {
    const organizations = await organizationRepository.find({});

    for (const organization of organizations) {
      const userIds = organization.users.map(u => u.userId);
      userIds.push(organization.userId);

      organization.userDetails ||= [];
      for (const userId of userIds) {
        const userDetails = organization.userDetails?.find(u => u.id === userId);
        const userData = await userRepository.findById(userId);
        if (!userData) continue;

        if (!userDetails) {
          organization.userDetails.push({
            id: userData.id,
            email: userData.email ?? userData.username,
            name: userData.name,
            usedCredits: 0,
            lastCreditUsedAt: null,
          });
        } else {
          userDetails.email = userData.email ?? userData.username;
          userDetails.name = userData.name;
          userDetails.usedCredits = 0;
          userDetails.lastCreditUsedAt = null;
        }
      }

      await organizationRepository.update(organization);
    }
  },

  down: async () => {},
};

export default migration;
