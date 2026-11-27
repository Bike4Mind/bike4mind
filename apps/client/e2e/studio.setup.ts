import { setupSpecUser } from './helpers/spec-setup';

// Studio is ungated for a regular user: the sidenav entry and each tab's form appear once the
// account has a usable model/provider, which a stage's system keys supply. A dedicated non-admin
// user keeps the galleries empty at the start of a run, so the generated clips are the only cards.
setupSpecUser({ key: 'studio', authFile: 'studio-user.json' });
