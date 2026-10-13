import type { JobMapperDeps } from './signedOutput';
import { signOutputUrl } from './signOutputUrl';

export const mapperDeps: JobMapperDeps = { sign: signOutputUrl, now: () => new Date() };
