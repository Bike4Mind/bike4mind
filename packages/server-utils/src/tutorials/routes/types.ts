import type { IUserDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { Request, RequestHandler, Response } from 'express';
import type { NextConnect } from 'next-connect';
import type { Ability } from '../../auth/ability';

/**
 * A request after `baseApi()` ran: the fields it attaches, which apps/client/global.d.ts declares on
 * Express.Request for the app. The package cannot see that augmentation; keep these in sync with it.
 */
export type TutorialRequest = Request & { user: IUserDocument; logger: Logger; ability?: Ability };

/**
 * A fresh router: `baseApi(...)` for a route anyone signed in may call, `adminApi(...)` for an admin one.
 * Typed as what apps/client/server/middlewares/baseApi.ts returns, which the package cannot import.
 */
export type ApiBuilder = () => NextConnect<TutorialRequest, Response>;

/** Whether this request's user may administer the owner's tutorials. Core passes the full-admin check. */
export type AdminCheck = (req: TutorialRequest) => boolean | Promise<boolean>;

export type Gate = RequestHandler;
