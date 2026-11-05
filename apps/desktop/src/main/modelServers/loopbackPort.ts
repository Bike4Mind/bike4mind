import { createServer } from 'node:net';

const LAUNCH_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** The port Desktop would start a server on for this address; null when it is not plain http on this computer. */
export function loopbackLaunchPort(baseUrl: string): number | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || !LAUNCH_HOSTS.has(url.hostname.toLowerCase()) || !url.port) return null;
  return ['', '/', '/v1', '/v1/'].includes(url.pathname) ? Number(url.port) : null;
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * Whether a server could listen on 127.0.0.1:port now; anything bound there, answering or not, makes it false. On
 * Windows a listener on 0.0.0.0 or another address does not block a 127.0.0.1 bind, so the wildcard must bind too.
 */
export async function loopbackPortFree(port: number, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!(await canBind(port, '127.0.0.1'))) return false;
  return platform !== 'win32' || canBind(port, '0.0.0.0');
}
