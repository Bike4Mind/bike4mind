import { setupSpecUser } from './helpers/spec-setup';

// Skills is ungated (no feature flag), so no extra prefs are needed - just a
// dedicated user so the spec's create/edit/delete/share never collide with
// another spec's data on a shared preview.
setupSpecUser({ key: 'skills', authFile: 'skills-user.json' });
