import type { JobMapperDeps } from '@bike4mind/server-utils/generations/signedOutput';
import { signOutputUrl } from './signOutputUrl';

export const mapperDeps: JobMapperDeps = { sign: signOutputUrl, now: () => new Date() };
