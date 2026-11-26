import { setupSpecUser } from './helpers/spec-setup';

// A brand-new account with no notebooks, so the welcome card offers the tour. Credits keep the composer up:
// at zero it is replaced by the out-of-credits banner, although the tour itself never calls a model.
setupSpecUser({
  key: 'tutorial-basics',
  authFile: 'tutorial-basics-user.json',
  initialCredits: 5000,
});
