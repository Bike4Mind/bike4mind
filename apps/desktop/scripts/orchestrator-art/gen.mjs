#!/usr/bin/env node
// Generate one image through the Bike4Mind image API using the signed-in CLI account (`b4m login`).
// Usage: node gen.mjs --name <id> --out <file.png> --model <model> --size <WxH> [--background transparent|opaque|auto]
//          --prompt-file <txt> [--api-url <origin>]
// The API origin comes from --api-url, else B4M_API_URL, else the CLI config's custom URL.
// Auth is read at runtime from ~/.bike4mind/config.json (never printed). When the access token is
// expired it is refreshed exactly like the CLI does (POST /api/oauth/refresh, client_id b4m-cli) and
// the rotated tokens are written back to the CLI config so the CLI session stays valid.
// Records {name: {model, size, background, prompt, date}} in generations.json next to --out; keep that
// ledger out of the repo, it is a local scratch record.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_PATH = path.join(os.homedir(), '.bike4mind', 'config.json');
const CLI_CLIENT_ID = 'b4m-cli';
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 6 * 60 * 1000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const key of ['name', 'out', 'model', 'prompt-file']) {
    if (!args[key]) throw new Error(`missing --${key}`);
  }
  return args;
}

async function getAccessToken(apiUrl) {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const baseUrl = apiUrl ?? process.env.B4M_API_URL ?? config.apiConfig?.customUrl;
  if (!baseUrl) throw new Error('no API origin: pass --api-url or set B4M_API_URL');
  const auth = config.auth;
  if (!auth?.refreshToken) throw new Error('not logged in: run `b4m login`');
  if (new Date(auth.expiresAt).getTime() - 60_000 > Date.now()) return { baseUrl, token: auth.accessToken };

  const response = await fetch(`${baseUrl}/api/oauth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: CLI_CLIENT_ID }),
  });
  if (!response.ok) throw new Error(`token refresh failed: HTTP ${response.status}`);
  const grant = await response.json();
  config.auth = {
    ...auth,
    accessToken: grant.access_token,
    refreshToken: grant.refresh_token ?? auth.refreshToken,
    expiresAt: new Date(Date.now() + grant.expires_in * 1000).toISOString(),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return { baseUrl, token: grant.access_token };
}

async function api(baseUrl, token, method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompt = fs.readFileSync(args['prompt-file'], 'utf8').trim();
  const { baseUrl, token } = await getAccessToken(args['api-url']);

  const body = {
    prompt,
    model: args.model,
    prompt_resolution: 'literal',
    sessionName: `tavern-art ${args.name}`,
    ...(args.size ? { size: args.size } : {}),
    ...(args.background ? { background: args.background } : {}),
    ...(args.quality ? { quality: args.quality } : {}),
  };
  const ack = await api(baseUrl, token, 'POST', '/api/v1/image-generations', body);
  const questId = ack.quest.id;
  console.log(`queued ${args.name}`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let quest;
  for (;;) {
    quest = await api(baseUrl, token, 'GET', `/api/v1/quests/${questId}`);
    const settled = quest.status === 'done' || quest.status === 'stopped' || quest.type === 'error';
    if (settled && (quest.type === 'error' || (quest.images ?? []).length > 0 || quest.status !== 'running')) break;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${args.name}`);
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  if (quest.type === 'error') throw new Error(`generation failed: ${quest.errorCode ?? ''} ${quest.reply ?? ''}`);
  const urls = new Map((quest.files ?? []).map(file => [file.name, file.url]));
  const imageName = (quest.images ?? [])[0];
  const url = urls.get(imageName);
  if (!url) throw new Error(`no image url for ${args.name}: ${JSON.stringify(Object.keys(quest))}`);

  const image = await fetch(url);
  if (!image.ok) throw new Error(`download failed: HTTP ${image.status}`);
  fs.writeFileSync(args.out, Buffer.from(await image.arrayBuffer()));
  console.log(`saved ${args.out}`);

  const ledgerPath = path.join(path.dirname(args.out), 'generations.json');
  const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : {};
  ledger[args.name] = {
    model: args.model,
    size: args.size,
    background: args.background,
    prompt,
    date: new Date().toISOString(),
  };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
