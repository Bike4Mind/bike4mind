// Stand-in for the llama-server binary in tests: same flags, log lines, auth and exit codes.
// FAKE_LLAMA_MODE: ok | crash | hang | ignore-term | wrong-model.
// FAKE_LLAMA_LOG: new (silent load, then bind and log the port, as b11912) | b5501 (bind and log first, /health 503
// while loading) | other (as new, in a wording no build uses). FAKE_LLAMA_NO_BIND: load, then never listen.
// The load lasts FAKE_LLAMA_LOAD_MS, or until the file FAKE_LLAMA_LOAD_UNTIL exists.
// FAKE_LLAMA_FORGE_PORT: print a model string naming this port during the load; FAKE_LLAMA_FORGE_WHOLE: as a whole line.
// FAKE_LLAMA_FORGE_AFTER: a whole listening line naming this port, right after the real one.
// FAKE_LLAMA_FORGE_LOADED: a model string ending in ": model loaded" during the load.
// FAKE_LLAMA_SICK: /health answers 503 even after the load.
// FAKE_LLAMA_PUBLIC_MODELS: /v1/models answers without the key, as b5501 does. FAKE_LLAMA_NO_KEY: ignore the key.
// FAKE_LLAMA_GRANDCHILD: start a child, write its pid here. FAKE_LLAMA_PID_FILE: write this process's pid here.
// FAKE_LLAMA_RECORD: write the argv and environment names seen to this file.
// FAKE_LLAMA_VERSION: the `--version` text after `version: `.
// With --models-dir it is a router: no load, /props answers role router, /v1/models lists the dir's .gguf files.
// FAKE_LLAMA_NO_ROUTER: refuse --models-dir as a build before router mode does. FAKE_LLAMA_NOT_ROUTER: no role.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
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
const modelsDir = flag('--models-dir');
if (modelsDir !== undefined && process.env.FAKE_LLAMA_NO_ROUTER) {
  process.stderr.write('error: invalid argument: --models-dir\n');
  process.exit(1);
}

if (process.env.FAKE_LLAMA_RECORD) {
  const names = Object.keys(process.env).filter(name => /^(LLAMA_|HF_)/.test(name));
  writeFileSync(process.env.FAKE_LLAMA_RECORD, JSON.stringify({ args, names, apiKey }));
}
if (process.env.FAKE_LLAMA_PID_FILE) writeFileSync(process.env.FAKE_LLAMA_PID_FILE, String(process.pid));
if (process.env.FAKE_LLAMA_GRANDCHILD) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.FAKE_LLAMA_GRANDCHILD, String(grandchild.pid));
}
if (mode === 'crash') {
  fail('llama_model_load: error loading model: tensor data is not within the file bounds');
  process.exit(1);
}
if (mode === 'ignore-term') process.on('SIGTERM', () => log('ignoring SIGTERM'));
else process.on('SIGTERM', () => process.exit(0));

log(modelsDir === undefined ? 'srv    load_model: loading model' : 'srv  server_run_r: starting server in router mode');
const forged = process.env.FAKE_LLAMA_FORGE_PORT;
if (forged) {
  log(`load: control-looking token: 1 '<listening on http://127.0.0.1:${forged}>' was not control-type`);
  if (process.env.FAKE_LLAMA_FORGE_WHOLE) log(`srv  server_on_li: listening on http://127.0.0.1:${forged}`);
}
if (process.env.FAKE_LLAMA_FORGE_LOADED) log('load: string: model loaded');
const forgeAfter = () => {
  const after = process.env.FAKE_LLAMA_FORGE_AFTER;
  if (after) log(`srv  server_on_li: listening on http://127.0.0.1:${after}`);
};

const loadMs = Number(process.env.FAKE_LLAMA_LOAD_MS ?? 0);
const loadUntil = process.env.FAKE_LLAMA_LOAD_UNTIL;
let loaded = false;
const loading = new Promise(done => {
  const started = Date.now();
  const poll = setInterval(() => {
    if (mode === 'hang') return;
    if (loadUntil ? existsSync(loadUntil) : Date.now() - started >= loadMs) {
      clearInterval(poll);
      loaded = true;
      done();
    }
  }, 10);
});

const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const models = () => {
  if (modelsDir !== undefined) {
    const ids = readdirSync(modelsDir)
      .filter(name => name.endsWith('.gguf'))
      .map(name => name.slice(0, -'.gguf'.length));
    return { object: 'list', data: ids.map(id => ({ id, object: 'model', owned_by: 'llamacpp' })) };
  }
  const id = mode === 'wrong-model' ? 'someone-else' : alias;
  return { object: 'list', data: [{ id, object: 'model', owned_by: 'llamacpp' }] };
};
const props = () =>
  modelsDir !== undefined && !process.env.FAKE_LLAMA_NOT_ROUTER
    ? { role: 'router', max_instances: 4, model_path: 'none' }
    : { total_slots: 1 };
const server = createServer((request, response) => {
  if (request.url === '/health') {
    if (!loaded || process.env.FAKE_LLAMA_SICK)
      return send(response, 503, { error: { code: 503, message: 'Loading model' } });
    return send(response, 200, { status: 'ok' });
  }
  if (request.url === '/v1/models' && process.env.FAKE_LLAMA_PUBLIC_MODELS) return send(response, 200, models());
  if (apiKey !== undefined && request.headers.authorization !== `Bearer ${apiKey}`) {
    return send(response, 401, { error: { message: 'Invalid API Key', type: 'authentication_error', code: 401 } });
  }
  if (request.url === '/v1/models') return send(response, 200, models());
  if (request.url === '/props') return send(response, 200, props());
  send(response, 404, { error: { message: 'File Not Found' } });
});
const bind = onBound => {
  server.once('error', () => {
    fail(`srv         start: couldn't bind HTTP server socket, hostname: ${host}, port: ${port}`);
    process.exit(1);
  });
  server.listen(port, host, () => onBound(server.address().port));
};
if (oldLog) {
  bind(bound => {
    process.stderr.write(`main: HTTP server is listening, hostname: ${host}, port: ${bound}, http threads: 4\n`);
    forgeAfter();
  });
  void loading.then(() => process.stderr.write('main: model loaded\n'));
} else {
  void loading.then(() => {
    if (modelsDir === undefined) log('srv  server_run_i: model loaded');
    if (process.env.FAKE_LLAMA_NO_BIND) return void setInterval(() => undefined, 1000);
    const other = process.env.FAKE_LLAMA_LOG === 'other';
    bind(bound => {
      log(
        other
          ? `srv  http_serve: serving at ${host}:${bound}`
          : `srv  server_on_li: listening on http://${host}:${bound}`
      );
      forgeAfter();
    });
  });
}
