import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, opendir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  isPeerIdentity,
  isPeerRequest,
  PEER_FRAME_LIMIT,
  PEER_LEASE_MS,
  PEER_PROTOCOL_VERSION,
  type PeerIdentity,
  type PeerManifest,
  type PeerRequest,
  type PeerResponse,
} from './protocol.js';

const DEADLINE_MS = 5_000;
const MAX_CONNECTIONS = 8;
const MAX_REGISTRY_ENTRIES = 4096;
const MAX_REGISTERED_PEERS = 1024;
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const secretPattern = /^[a-f0-9]{64}$/;

function supported(): void {
  if (process.platform === 'win32' || !process.getuid)
    throw new Error('Local CLI peers currently require macOS or Linux.');
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function ensurePeerRoot(root: string): Promise<string> {
  supported();
  if (!isAbsolute(root) || root.includes('\0')) throw new Error('The peer registry must have an absolute path.');
  const target = resolve(root);
  if (target === parse(target).root) throw new Error('The peer registry needs its own private directory.');
  const trustedTemporary = new Set([await realpath(tmpdir()), await realpath('/tmp')]);
  let current = parse(target).root;
  for (const component of relative(current, target).split('/')) {
    current = join(current, component);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (!missing(error)) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
      }
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error('Peer registry paths cannot contain symbolic links.');
    const own = entry.uid === process.getuid!();
    const trustedStickyTemporary = trustedTemporary.has(current) && entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if ((!own && entry.uid !== 0) || ((entry.mode & 0o022) !== 0 && !trustedStickyTemporary))
      throw new Error('The peer registry has an unsafe parent directory.');
    if (current === target && (!own || (entry.mode & 0o077) !== 0))
      throw new Error('The peer registry must be owned by this user and private (0700).');
  }
  return target;
}

function identityOf(manifest: PeerManifest): PeerIdentity {
  return {
    id: manifest.id,
    generation: manifest.generation,
    threadId: manifest.threadId,
    name: manifest.name,
    projectId: manifest.projectId,
    accountId: manifest.accountId,
  };
}

function sameScope(a: PeerIdentity, b: Pick<PeerIdentity, 'accountId' | 'projectId'>): boolean {
  return a.accountId === b.accountId && a.projectId === b.projectId;
}

function sameIdentity(a: PeerIdentity, b: PeerIdentity): boolean {
  return JSON.stringify(identityOf(a as PeerManifest)) === JSON.stringify(identityOf(b as PeerManifest));
}

function sign(token: string, value: unknown): string {
  return createHmac('sha256', token).update(JSON.stringify(value)).digest('hex');
}

function equalSecret(a: unknown, b: string): boolean {
  return (
    typeof a === 'string' && secretPattern.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  );
}

async function readManifest(root: string, id: string, requireFresh = true): Promise<PeerManifest | null> {
  if (!idPattern.test(id)) return null;
  const file = join(root, `${id}.json`);
  try {
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid!() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 16_384
    )
      return null;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: unknown;
    try {
      const opened = await handle.stat();
      if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > 16_384) return null;
      const contents = await handle.readFile('utf8');
      if (Buffer.byteLength(contents) > 16_384) return null;
      value = JSON.parse(contents);
    } finally {
      await handle.close();
    }
    if (!isPeerIdentity(value)) return null;
    const candidate = value as Partial<PeerManifest>;
    if (
      candidate.version !== PEER_PROTOCOL_VERSION ||
      candidate.id !== id ||
      typeof candidate.endpoint !== 'string' ||
      !isAbsolute(candidate.endpoint) ||
      Buffer.byteLength(candidate.endpoint) > 103 ||
      typeof candidate.token !== 'string' ||
      !secretPattern.test(candidate.token) ||
      typeof candidate.updatedAt !== 'number' ||
      !Number.isFinite(candidate.updatedAt) ||
      (candidate.processId !== undefined && (!Number.isSafeInteger(candidate.processId) || candidate.processId <= 0)) ||
      candidate.updatedAt > Date.now() + 5_000 ||
      (requireFresh && Date.now() - candidate.updatedAt > PEER_LEASE_MS)
    )
      return null;
    return {
      ...identityOf(value as PeerManifest),
      version: 1,
      endpoint: candidate.endpoint,
      token: candidate.token,
      updatedAt: candidate.updatedAt,
      ...(candidate.processId !== undefined && { processId: candidate.processId }),
    };
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ELOOP')
      return null;
    throw error;
  }
}

async function writeManifest(root: string, manifest: PeerManifest, initial = false): Promise<void> {
  const destination = join(root, `${manifest.id}.json`);
  if (initial) {
    try {
      await lstat(`${destination}.prune`);
      throw new Error('The peer registration is being cleaned up.');
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  const temporary = initial ? destination : join(root, `${manifest.id}.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(JSON.stringify(manifest));
  } finally {
    await handle.close();
  }
  if (!initial) {
    try {
      const original = await lstat(destination);
      const previous = await readManifest(root, manifest.id, false);
      if (!previous || previous.generation !== manifest.generation || previous.token !== manifest.token)
        throw new Error('The peer registration changed.');
      const current = await lstat(destination);
      if (current.ino !== original.ino || current.dev !== original.dev)
        throw new Error('The peer registration changed.');
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function registryFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const directory = await opendir(root);
  let count = 0;
  for await (const entry of directory) {
    if (++count > MAX_REGISTRY_ENTRIES) throw new Error('The peer registry contains too many entries.');
    if (entry.isFile() && /^[a-zA-Z0-9_-]{1,128}\.json$/.test(entry.name)) files.push(entry.name);
  }
  return files;
}

function processEnded(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function disconnectedEndpoint(endpoint: string): Promise<boolean> {
  return new Promise(resolveDisconnected => {
    const socket = createConnection({ path: endpoint });
    const timer = setTimeout(() => finish(false), 100);
    timer.unref();
    const finish = (disconnected: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolveDisconnected(disconnected);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', error =>
      finish(['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? ''))
    );
  });
}

async function removeOrphanEndpoint(root: string, manifest: PeerManifest): Promise<void> {
  const direct = manifest.endpoint === join(root, `${manifest.id}.sock`);
  const temporaryRoot = await realpath('/tmp');
  const parent = dirname(manifest.endpoint);
  const temporary =
    dirname(parent) === temporaryRoot &&
    /^b4m-peer-[a-zA-Z0-9]{6}$/.test(parent.slice(temporaryRoot.length + 1)) &&
    manifest.endpoint === join(parent, 's');
  if (!direct && !temporary) return;
  try {
    await validateEndpoint(manifest.endpoint);
    const original = await lstat(manifest.endpoint);
    if (!(await disconnectedEndpoint(manifest.endpoint))) return;
    const current = await lstat(manifest.endpoint);
    if (current.ino !== original.ino || current.dev !== original.dev || !current.isSocket()) return;
    await rm(manifest.endpoint);
    if (temporary) {
      const directory = await opendir(parent);
      const empty = (await directory.read()) === null;
      await directory.close();
      if (empty) await rmdir(parent);
    }
  } catch (error) {
    if (!missing(error)) return;
  }
}

async function pruneManifest(root: string, manifest: PeerManifest): Promise<void> {
  if (Date.now() - manifest.updatedAt <= PEER_LEASE_MS || !processEnded(manifest.processId)) return;
  const file = join(root, `${manifest.id}.json`);
  const claim = `${file}.prune`;
  let marker;
  try {
    marker = await open(claim, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  try {
    const original = await lstat(file);
    const current = await readManifest(root, manifest.id, false);
    if (
      !current ||
      current.generation !== manifest.generation ||
      current.token !== manifest.token ||
      current.updatedAt !== manifest.updatedAt ||
      !processEnded(current.processId)
    )
      return;
    const checked = await lstat(file);
    if (checked.ino !== original.ino || checked.dev !== original.dev) return;
    await removeOrphanEndpoint(root, current);
    const final = await readManifest(root, manifest.id, false);
    if (
      !final ||
      final.generation !== manifest.generation ||
      final.token !== manifest.token ||
      final.updatedAt !== manifest.updatedAt
    )
      return;
    await rm(file);
  } catch (error) {
    if (!missing(error)) throw error;
  } finally {
    const owned = await marker.stat();
    await marker.close();
    const current = await lstat(claim).catch(() => null);
    if (current?.ino === owned.ino && current.dev === owned.dev) await rm(claim);
  }
}

async function registeredPeers(root: string, includeStaleOwners = false): Promise<PeerManifest[]> {
  const peers: PeerManifest[] = [];
  for (const file of await registryFiles(root)) {
    const manifest = await readManifest(root, file.slice(0, -5), false);
    if (!manifest) continue;
    if (Date.now() - manifest.updatedAt > PEER_LEASE_MS) {
      await pruneManifest(root, manifest);
      if (includeStaleOwners && !processEnded(manifest.processId)) peers.push(manifest);
    } else peers.push(manifest);
  }
  if (peers.length > MAX_REGISTERED_PEERS) throw new Error('The peer registry has reached its session limit.');
  return peers;
}

export async function discoverPeers(
  root: string,
  scope?: Pick<PeerIdentity, 'accountId' | 'projectId'>
): Promise<PeerIdentity[]> {
  const directory = await ensurePeerRoot(root);
  return (await registeredPeers(directory)).filter(manifest => !scope || sameScope(manifest, scope)).map(identityOf);
}

function frame(socket: Socket, value: unknown): void {
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > PEER_FRAME_LIMIT) throw new Error('The peer frame exceeds its size limit.');
  socket.write(text);
}

function readFrame(socket: Socket): Promise<unknown> {
  return new Promise((resolveFrame, reject) => {
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const finish = (error?: Error, value?: unknown) => {
      socket.pause();
      socket.removeListener('data', data);
      socket.removeListener('error', fail);
      socket.removeListener('end', ended);
      socket.removeListener('close', ended);
      if (error) reject(error);
      else resolveFrame(value);
    };
    const fail = (error: Error) => finish(error);
    const ended = () => finish(new Error('The peer disconnected.'));
    const data = (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > PEER_FRAME_LIMIT)
        return finish(new Error('The peer frame exceeds its size limit.'));
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      if (buffer.slice(newline + 1).trim()) return finish(new Error('Only one peer frame is allowed per exchange.'));
      try {
        finish(undefined, JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish(new Error('The peer sent an invalid frame.'));
      }
    };
    socket.on('data', data);
    socket.once('error', fail);
    socket.once('end', ended);
    socket.once('close', ended);
    socket.resume();
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid peer frame.');
  return value as Record<string, unknown>;
}

function validResponse(value: unknown): value is PeerResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  if (response.ok === false)
    return (
      typeof response.error === 'string' &&
      response.error.length <= 4096 &&
      (response.unknown === undefined || typeof response.unknown === 'boolean')
    );
  if (response.ok !== true) return false;
  if (response.presence !== undefined) {
    if (!response.presence || typeof response.presence !== 'object') return false;
    const presence = response.presence as Record<string, unknown>;
    if (!['hold', 'accept', 'refuse'].includes(String(presence.policy)) || typeof presence.ready !== 'boolean')
      return false;
  }
  if (response.receipt === undefined) return true;
  if (!response.receipt || typeof response.receipt !== 'object') return false;
  const receipt = response.receipt as Record<string, unknown>;
  return (
    ['id', 'senderId', 'recipientId'].every(
      key => typeof receipt[key] === 'string' && idPattern.test(receipt[key] as string)
    ) &&
    [
      'queued',
      'held',
      'delivered',
      'completed',
      'rejected',
      'expired',
      'cancelled',
      'unknown',
      'failed',
      'stopped',
    ].includes(String(receipt.status)) &&
    typeof receipt.createdAt === 'number' &&
    Number.isFinite(receipt.createdAt) &&
    typeof receipt.expiresAt === 'number' &&
    Number.isFinite(receipt.expiresAt) &&
    typeof receipt.hops === 'number' &&
    Number.isInteger(receipt.hops) &&
    receipt.hops >= 0 &&
    receipt.hops <= 5 &&
    ['text', 'result', 'error', 'replyTo'].every(key => receipt[key] === undefined || typeof receipt[key] === 'string')
  );
}

async function validateEndpoint(endpoint: string): Promise<void> {
  await ensurePeerRoot(dirname(endpoint));
  const entry = await lstat(endpoint);
  if (!entry.isSocket() || entry.uid !== process.getuid!() || (entry.mode & 0o077) !== 0)
    throw new Error('The peer endpoint is not a private socket.');
}

export async function startPeerTransport(options: {
  root: string;
  identity: PeerIdentity;
  handle: (sender: PeerIdentity, request: PeerRequest) => Promise<PeerResponse>;
}): Promise<{ close(): Promise<void>; manifest: PeerManifest }> {
  supported();
  if (!isPeerIdentity(options.identity)) throw new Error('Invalid peer identity.');
  const root = await ensurePeerRoot(options.root);
  const registered = await registeredPeers(root, true);
  if (registered.length >= MAX_REGISTERED_PEERS) throw new Error('The peer registry has reached its session limit.');
  if (registered.some(peer => peer.threadId === options.identity.threadId && sameScope(peer, options.identity)))
    throw new Error('This saved thread already has a registered peer process.');
  const identity = { ...options.identity };
  let temporaryDirectory: string | undefined;
  let endpoint = join(root, `${identity.id}.sock`);
  if (Buffer.byteLength(endpoint) > 103) {
    const temporaryRoot = await realpath('/tmp');
    temporaryDirectory = await mkdtemp(join(temporaryRoot, 'b4m-peer-'));
    await chmod(temporaryDirectory, 0o700);
    await ensurePeerRoot(temporaryDirectory);
    endpoint = join(temporaryDirectory, 's');
  }
  const manifest: PeerManifest = {
    ...identity,
    version: 1,
    endpoint,
    token: randomBytes(32).toString('hex'),
    updatedAt: Date.now(),
    processId: process.pid,
  };
  const sockets = new Set<Socket>();
  let closed = false;
  let published = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatWrite: Promise<void> = Promise.resolve();
  const server = createServer(socket => {
    if (closed || sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('error', () => undefined);
    const deadline = setTimeout(() => socket.destroy(), DEADLINE_MS);
    deadline.unref();
    socket.once('close', () => {
      clearTimeout(deadline);
      sockets.delete(socket);
    });
    void (async () => {
      const nonce = randomBytes(32).toString('hex');
      frame(socket, {
        version: 1,
        nonce,
        generation: manifest.generation,
        proof: sign(manifest.token, ['challenge', nonce, manifest.id, manifest.generation]),
      });
      const envelope = object(await readFrame(socket));
      if (
        envelope.version !== 1 ||
        typeof envelope.senderId !== 'string' ||
        typeof envelope.generation !== 'string' ||
        !isPeerRequest(envelope.request)
      )
        throw new Error('Invalid peer request.');
      const sender = await readManifest(root, envelope.senderId);
      if (
        !sender ||
        sender.generation !== envelope.generation ||
        !sameScope(sender, identity) ||
        sender.id === identity.id ||
        !equalSecret(
          envelope.proof,
          sign(sender.token, ['request', nonce, identity.id, identity.generation, envelope.request])
        )
      )
        throw new Error('Peer authentication or scope failed.');
      const response = await options.handle(identityOf(sender), envelope.request);
      if (!validResponse(response)) throw new Error('Invalid peer response.');
      if (
        response.ok &&
        response.receipt &&
        (response.receipt.senderId !== sender.id || response.receipt.recipientId !== identity.id)
      )
        throw new Error('Invalid peer receipt owner.');
      if (closed || socket.destroyed) return;
      frame(socket, { version: 1, response, proof: sign(manifest.token, ['response', nonce, response]) });
      socket.end();
    })().catch(() => socket.destroy());
  });
  server.maxConnections = MAX_CONNECTIONS;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    await heartbeatWrite.catch(() => undefined);
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    if (published) {
      const current = await readManifest(root, identity.id, false);
      if (current?.generation === identity.generation && current.token === manifest.token)
        await rm(join(root, `${identity.id}.json`), { force: true });
    }
    if (temporaryDirectory)
      await rmdir(temporaryDirectory).catch(error => {
        if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
      });
  };
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => {
        server.removeListener('error', reject);
        done();
      });
    });
    server.on('error', () => undefined);
    await chmod(endpoint, 0o600);
    await writeManifest(root, manifest, true);
    published = true;
    heartbeat = setInterval(() => {
      heartbeatWrite = heartbeatWrite
        .then(async () => {
          if (closed) return;
          manifest.updatedAt = Date.now();
          await ensurePeerRoot(root);
          await writeManifest(root, manifest);
        })
        .catch(() => {
          void close().catch(() => undefined);
        });
    }, 15_000);
    heartbeat.unref();
    return { close, manifest };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function callPeer(
  root: string,
  sender: PeerIdentity,
  targetId: string,
  request: PeerRequest,
  expectedTarget?: PeerIdentity
): Promise<PeerResponse> {
  let socket: Socket | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let dispatched = false;
  try {
    if (!isPeerIdentity(sender) || !idPattern.test(targetId) || !isPeerRequest(request))
      throw new Error('Invalid peer request.');
    const directory = await ensurePeerRoot(root);
    const [source, target] = await Promise.all([readManifest(directory, sender.id), readManifest(directory, targetId)]);
    if (!source || !sameIdentity(source, sender)) throw new Error('The sending peer is not registered or changed.');
    if (!target || !sameScope(source, target) || target.id === source.id)
      throw new Error('The target peer is unavailable in this account and project.');
    if (expectedTarget && !sameIdentity(target, expectedTarget))
      throw new Error('The approved recipient changed. Request a new approval.');
    await validateEndpoint(target.endpoint);
    socket = createConnection({ path: target.endpoint });
    const connection = socket;
    connection.on('error', () => undefined);
    deadline = setTimeout(() => connection.destroy(new Error('The peer deadline expired.')), DEADLINE_MS);
    deadline.unref();
    await new Promise<void>((done, reject) => {
      connection.once('connect', done);
      connection.once('error', reject);
    });
    const challenge = object(await readFrame(connection));
    if (
      challenge.version !== 1 ||
      typeof challenge.nonce !== 'string' ||
      !secretPattern.test(challenge.nonce) ||
      challenge.generation !== target.generation ||
      !equalSecret(challenge.proof, sign(target.token, ['challenge', challenge.nonce, target.id, target.generation]))
    )
      throw new Error('The peer challenge could not be authenticated.');
    frame(connection, {
      version: 1,
      senderId: source.id,
      generation: source.generation,
      request,
      proof: sign(source.token, ['request', challenge.nonce, target.id, target.generation, request]),
    });
    dispatched = true;
    const result = object(await readFrame(connection));
    if (
      result.version !== 1 ||
      !validResponse(result.response) ||
      !equalSecret(result.proof, sign(target.token, ['response', challenge.nonce, result.response]))
    )
      throw new Error('The peer response could not be authenticated.');
    if (
      result.response.ok &&
      result.response.receipt &&
      (result.response.receipt.senderId !== sender.id || result.response.receipt.recipientId !== target.id)
    )
      throw new Error('The peer receipt has a different owner.');
    return result.response;
  } catch (error) {
    return {
      ok: false,
      error: dispatched
        ? 'Delivery could not be confirmed. Do not automatically retry.'
        : error instanceof Error
          ? error.message
          : 'The peer is unavailable.',
      ...(dispatched && { unknown: true }),
    };
  } finally {
    clearTimeout(deadline);
    socket?.destroy();
  }
}
