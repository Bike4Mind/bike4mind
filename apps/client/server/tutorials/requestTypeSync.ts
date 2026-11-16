import type { TutorialRequest } from '@bike4mind/server-utils/tutorials/routes/types';
import type { Request } from 'express';

// Guards the TutorialRequest copy in packages/server-utils/src/tutorials/routes/types.ts.
// `user` is re-required here because passport's optional declaration merges into Request's view of it.
export const tutorialRequestMatchesApp: Request & { user: Express.Request['user'] } extends TutorialRequest
  ? true
  : never = true;
