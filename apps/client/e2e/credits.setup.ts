import { setupSpecUser } from './helpers/spec-setup';

// 1, not 0: a zero balance disables send client-side, so the request never reaches the server's
// pre-flight credit gate this spec exercises (see credits.spec.ts).
setupSpecUser({ key: 'credits', authFile: 'credits-user.json', initialCredits: 1 });
