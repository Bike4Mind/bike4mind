import type { JobMapperDeps } from '@bike4mind/server-utils/generations/signedOutput';
import { signOutputUrl } from '@bike4mind/server-utils/generations/signOutputUrl';

export const mapperDeps: JobMapperDeps = { sign: signOutputUrl, now: () => new Date() };
