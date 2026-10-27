// Stand-in for the llama-server binary in tests: same flags, log lines, auth and exit codes.
// FAKE_LLAMA_MODE: ok | crash | hang | ignore-term | wrong-model. FAKE_LLAMA_LOAD_MS: /health answers 503 this long.
// FAKE_LLAMA_LOG: new (port logged after loading, as current builds) | b5501 (port logged on bind, before loading).
// FAKE_LLAMA_PUBLIC_MODELS: /v1/models answers without the key, as b5501 does. FAKE_LLAMA_NO_KEY: ignore the key.
// FAKE_LLAMA_CHATTY: print a line every 50ms while loading. FAKE_LLAMA_GRANDCHILD: start a child, write its pid here.
// FAKE_LLAMA_RECORD: write the argv and environment names seen to this file.
// FAKE_LLAMA_VERSION: the `--version` text after `version: `.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const log = line => process.stderr.write(`0.00.000.000 I ${line}\n`);
const fail = line => process.stderr.write(`0.00.000.000 E ${line}\n`);

if (args.includes('--version')) {
  const version = process.env.FAKE_LLAMA_VERSION ?? '0.7.0-dev (build 11912, commit fake)';
  process.stderr.write(`version: ${version}\nbuilt with fake for tests\n`);
  process.exit(0);
}

const mode = process.env.FAKE_LLAMA_MODE ?? 'ok';
const host = flag('--host');
const port = Number(flag('--port'));
const alias = flag('--alias');
const apiKey = process.env.FAKE_LLAMA_NO_KEY ? undefined : process.env.LLAMA_API_KEY;
const oldLog = process.env.FAKE_LLAMA_LOG === 'b5501';

if (process.env.FAKE_LLAMA_RECORD) {
  const names = Object.keys(process.env).filter(name => /^(LLAMA_|HF_)/.test(name));
  writeFileSync(process.env.FAKE_LLAMA_RECORD, JSON.stringify({ args, names, apiKey }));
}
if (process.env.FAKE_LLAMA_GRANDCHILD) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.FAKE_LLAMA_GRANDCHILD, String(grandchild.pid));
}
if (mode === 'crash') {
  fail('llama_model_load: error loading model: tensor data is not within the file bounds');
  process.exit(1);
}
if (mode === 'hang') setInterval(() => undefined, 1000);
if (mode === 'ignore-term') process.on('SIGTERM', () => log('ignoring SIGTERM'));
else process.on('SIGTERM', () => process.exit(0));

const loadMs = Number(process.env.FAKE_LLAMA_LOAD_MS ?? 0);
const readyAt = Date.now() + loadMs;
if (process.env.FAKE_LLAMA_CHATTY) {
  const timer = setInterval(() => (Date.now() < readyAt ? log('load_tensors: loading') : clearInterval(timer)), 50);
}
const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const models = () => {
  const id = mode === 'wrong-model' ? 'someone-else' : alias;
  return { object: 'list', data: [{ id, object: 'model', owned_by: 'llamacpp' }] };
};
const server = createServer((request, response) => {
  if (request.url === '/health') {
    if (Date.now() < readyAt) return send(response, 503, { error: { code: 503, message: 'Loading model' } });
    return send(response, 200, { status: 'ok' });
  }
  if (request.url === '/v1/models' && process.env.FAKE_LLAMA_PUBLIC_MODELS) return send(response, 200, models());
  if (apiKey !== undefined && request.headers.authorization !== `Bearer ${apiKey}`) {
    return send(response, 401, { error: { message: 'Invalid API Key', type: 'authentication_error', code: 401 } });
  }
  if (request.url === '/v1/models') return send(response, 200, models());
  if (request.url === '/props') return send(response, 200, { total_slots: 1 });
  send(response, 404, { error: { message: 'File Not Found' } });
});
if (mode !== 'hang') {
  server.once('error', () => {
    fail(`srv         start: couldn't bind HTTP server socket, hostname: ${host}, port: ${port}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const bound = server.address().port;
    if (oldLog) log(`srv         start: HTTP server is listening, hostname: ${host}, port: ${bound}, http threads: 4`);
    else setTimeout(() => log(`srv  server_on_li: listening on http://${host}:${bound}`), loadMs);
  });
}
