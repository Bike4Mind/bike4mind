import * as z from 'zod';
import { passthroughShape } from './responseShape';

// IUserShare.user is a lazy-loaded virtual that some reads can populate with a full user document.
// It is deliberately not listed, so it can never reach a client through a share row.
export const userShareResponseSchema = z.object(
  passthroughShape({ userId: true, permissions: true, projectId: true, sessionId: true, extraData: true })
);

export const groupShareResponseSchema = z.object(passthroughShape({ groupId: true, permissions: true }));
