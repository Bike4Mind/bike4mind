import { app } from 'electron';
import { applyAppIdentity } from './appIdentity';

// A side-effect module so that index.ts can import it first: bundled imports are evaluated in
// order, and a call in index.ts's own body would only run after every other import had loaded.
// Externalized deps (see electron.vite.config.ts) still load before this, so they must not read
// userData or touch safeStorage at import time.
applyAppIdentity(app);
