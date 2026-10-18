import { setupSpecUser } from './helpers/spec-setup';

// Skills is ungated (no feature flag), so no extra prefs are needed - just a
// dedicated user so the spec's create/edit/delete/share never collide with
// another spec's data on a shared preview.
// Admin: the share dialog's global read/write toggles are super-admin only
// (SkillShareDialog.tsx), and skills.spec.ts exercises that flow.
setupSpecUser({ key: 'skills', authFile: 'skills-user.json', isAdmin: true });
