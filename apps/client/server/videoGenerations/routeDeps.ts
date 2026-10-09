import { signOutputUrl } from './signOutputUrl';

export const mapperDeps = { sign: signOutputUrl, now: () => new Date() };

export { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
