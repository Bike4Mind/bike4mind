import { app } from 'electron';
import { applyAppIdentity } from './appIdentity';

// A side-effect module so that index.ts can import it first: ES imports are evaluated in order,
// and a call in index.ts's own body would only run after every other import had loaded.
applyAppIdentity(app);
