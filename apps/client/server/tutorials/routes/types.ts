import type { Request, RequestHandler } from 'express';
import type { baseApi } from '@server/middlewares/baseApi';

/** A fresh router: `baseApi(...)` for a route anyone signed in may call, `adminApi(...)` for an admin one. */
export type ApiBuilder = () => ReturnType<typeof baseApi>;

/** Whether this request's user may administer the owner's tutorials. Core passes the full-admin check. */
export type AdminCheck = (req: Request) => boolean | Promise<boolean>;

export type Gate = RequestHandler;
