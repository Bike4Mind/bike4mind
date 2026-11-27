import pkg from '../package.json' with { type: 'json' };

export const HOST_VERSION: string = pkg.version;
