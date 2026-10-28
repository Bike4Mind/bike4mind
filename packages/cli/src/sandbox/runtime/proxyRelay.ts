/**
 * Node script run as the entry point of a network-isolated Bubblewrap sandbox. Argv: proxy port,
 * Unix socket path, command. It listens on 127.0.0.1:<port> inside the sandbox, forwards each
 * connection to the socket (bridged to the host proxy by ProxyManager), then runs the command
 * under bash and exits with its status. If the listener fails, the command still runs, offline.
 */
export const PROXY_RELAY_SOURCE = `
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const [port, socketPath, command] = process.argv.slice(1);
let started = false;
const run = () => {
  if (started) return;
  started = true;
  const child = spawn('bash', ['-c', command], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', error => {
    process.stderr.write('sandbox: ' + error.message + '\\n');
    process.exit(127);
  });
  child.on('exit', (code, signal) => process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0)));
};
const server = net.createServer({ allowHalfOpen: true }, client => {
  const upstream = net.connect({ path: socketPath, allowHalfOpen: true });
  client.pipe(upstream).pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
});
server.on('error', error => {
  process.stderr.write('sandbox: network proxy relay unavailable, running without network: ' + error.message + '\\n');
  run();
});
server.listen(Number(port), '127.0.0.1', run);
`;
