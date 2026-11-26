import type { Socket } from 'node:net';
import {
  createHostFrameDecoder,
  encodeHostFrame,
  HOST_ERROR_CODES,
  hostFailure,
  isHostRequest,
  type HostError,
  type HostMessage,
} from '@shared/hostProtocol';
import type { HostServer } from '../server';
import type { HostLogger } from './logging';

/**
 * Output a client has not read yet. Past it the client is dropped rather than buffered for
 * without bound; it resumes from its event cursor when it reconnects.
 */
export const MAX_UNREAD_OUTPUT_BYTES = 64 * 1024 * 1024;

export type ServeSocketOptions = { maxUnreadOutputBytes?: number };

/**
 * Serves one client over a stream socket (created with `allowHalfOpen`): newline-delimited
 * JSON-RPC in both directions, one HostServer connection per socket. A frame that is not valid
 * JSON, is not a host message or is over the frame limit ends this connection with a protocol
 * error; the host and its other clients carry on.
 */
export function serveHostSocket(
  socket: Socket,
  server: Pick<HostServer, 'connect'>,
  logger: HostLogger,
  options: ServeSocketOptions = {}
): void {
  const maxUnread = options.maxUnreadOutputBytes ?? MAX_UNREAD_OUTPUT_BYTES;
  const decoder = createHostFrameDecoder();
  let open = true;
  let inputEnded = false;
  let pending = 0;

  const send = (message: HostMessage) => {
    if (!open || socket.destroyed) return;
    socket.write(encodeHostFrame(message));
    if (socket.writableLength > maxUnread) {
      logger.warn(`HOST: dropped a client that left ${socket.writableLength} bytes unread`);
      close();
      socket.destroy();
    }
  };
  const connection = server.connect(send);

  const close = () => {
    if (!open) return;
    open = false;
    connection.close();
  };
  const refuse = (error: HostError) => {
    logger.warn(`HOST: closed a connection that sent a bad frame: ${error.message}`);
    const failure = encodeHostFrame(hostFailure(null, error.code, error.message));
    close();
    socket.end(failure, () => socket.destroy());
  };

  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    if (!open) return;
    for (const frame of decoder.push(chunk)) {
      if (!frame.ok) return refuse(frame.error);
      // A client sends requests only; the host asks nothing of it, so anything else is ignored.
      if (!isHostRequest(frame.message)) continue;
      pending++;
      const { id } = frame.message;
      void connection
        .handle(frame.message)
        .then(send, (error: unknown) => {
          logger.error('HOST: a request failed without a response', error);
          send(hostFailure(id, HOST_ERROR_CODES.internalError, 'The host failed to answer this request'));
        })
        .finally(() => {
          pending--;
          endIfDrained();
        });
    }
  });
  // A client that half-closes still gets the answers to what it already asked.
  const endIfDrained = () => {
    if (!inputEnded || pending > 0 || !open) return;
    close();
    socket.end();
  };
  socket.on('end', () => {
    inputEnded = true;
    endIfDrained();
  });
  socket.on('close', close);
  socket.on('error', error => {
    logger.debug(`HOST: client connection failed: ${error.message}`);
    close();
  });
}
