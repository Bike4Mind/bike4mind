import { createServer } from 'node:net';

/** Whether a server could listen on 127.0.0.1:port now; anything bound there, answering or not, makes it false. */
export function loopbackPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}
