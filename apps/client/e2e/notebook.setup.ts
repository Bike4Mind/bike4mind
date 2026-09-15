import { setupSpecUser } from './helpers/spec-setup';
import { apiUpdateUser } from './helpers/api';

setupSpecUser({
  key: 'notebook',
  authFile: 'notebook-user.json',
  afterCreate: async ({ request, accessToken, userId }) => {
    await apiUpdateUser(request, accessToken, userId, { showCreditsUsed: true });
  },
});
