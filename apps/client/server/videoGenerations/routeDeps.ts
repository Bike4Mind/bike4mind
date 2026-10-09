import { signOutputUrl } from './signOutputUrl';

export const mapperDeps = { sign: signOutputUrl, now: () => new Date() };
