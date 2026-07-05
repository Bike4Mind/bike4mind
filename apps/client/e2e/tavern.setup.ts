import { setupSpecUser } from './helpers/spec-setup';

// The Tavern HUD is access-gated (admin or 'tavern' tag) via `canAccessTavern`.
// Grant the spec user the 'tavern' tag so the tab renders - otherwise
// `?tab=tavern` coerces to the Keep and `tavern-actionbar` never mounts.
setupSpecUser({ key: 'tavern', authFile: 'tavern-user.json', tags: ['tavern'] });
