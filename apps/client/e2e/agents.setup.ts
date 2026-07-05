import { setupSpecUser } from './helpers/spec-setup';

setupSpecUser({
  key: 'agents',
  authFile: 'agents-user.json',
  prefs: { experimentalFeatures: { enableAgents: true } },
});
