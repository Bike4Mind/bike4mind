// Stand-in for `ollama serve` in tests: reads OLLAMA_HOST, logs the listening line and answers /api/version.
// FAKE_OLLAMA_MODE: ok | crash | silent (listens, never logs the line) | ignore-term.
// FAKE_OLLAMA_RECORD: write the argv and the OLLAMA_* environment seen to this file.
// FAKE_OLLAMA_PID_FILE: write this process's pid here.
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const mode = process.env.FAKE_OLLAMA_MODE ?? 'ok';
const [host, portText] = (process.env.OLLAMA_HOST ?? '127.0.0.1:11434').split(':');
const port = Number(portText);
const log = (level, msg) =>
  process.stderr.write(`time=2026-01-01T00:00:00.000Z level=${level} source=routes.go:1 msg="${msg}"\n`);

if (process.env.FAKE_OLLAMA_RECORD) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('OLLAMA_')));
  writeFileSync(process.env.FAKE_OLLAMA_RECORD, JSON.stringify({ args, env }));
}
if (process.env.FAKE_OLLAMA_PID_FILE) writeFileSync(process.env.FAKE_OLLAMA_PID_FILE, String(process.pid));
if (mode === 'crash') {
  log('ERROR', 'unable to initialize llm library');
  process.exit(1);
}
if (mode === 'ignore-term') process.on('SIGTERM', () => log('INFO', 'ignoring SIGTERM'));
else process.on('SIGTERM', () => process.exit(0));

const server = createServer((request, response) => {
  response.writeHead(request.url === '/api/version' ? 200 : 404, { 'content-type': 'application/json' });
  response.end(JSON.stringify(request.url === '/api/version' ? { version: '0.12.0' } : { error: 'not found' }));
});
server.once('error', () => {
  process.stderr.write(`Error: listen tcp ${host}:${port}: bind: address already in use\n`);
  process.exit(1);
});
server.listen(port, host, () => {
  if (mode !== 'silent') log('INFO', `Listening on ${host}:${port} (version 0.12.0)`);
});
