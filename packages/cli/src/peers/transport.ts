import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, opendir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
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
  return validateRoot(root);
}

export async function preparePeerRoot(root: string): Promise<string> {
  const config = join(homedir(), '.bike4mind');
  const expected = join(config, 'peers');
  return validateRoot(root, resolve(root) === expected ? new Set([config, expected]) : new Set());
}

async function validateRoot(root: string, repair = new Set<string>()): Promise<string> {
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
      throw new Error(`Peer registry path ${JSON.stringify(current)} must be a directory without symbolic links.`);
    const own = entry.uid === process.getuid!();
    if (own && repair.has(current) && (entry.mode & 0o077) !== 0) {
      const directory = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const opened = await directory.stat();
        if (opened.ino !== entry.ino || opened.dev !== entry.dev || opened.uid !== process.getuid!())
          throw new Error(`Peer directory ${JSON.stringify(current)} changed while securing it. Try again.`);
        await directory.chmod(0o700);
      } finally {
        await directory.close();
      }
      const secured = await lstat(current);
      if (
        secured.ino !== entry.ino ||
        secured.dev !== entry.dev ||
        secured.isSymbolicLink() ||
        secured.uid !== process.getuid!()
      )
        throw new Error(`Peer directory ${JSON.stringify(current)} changed while securing it. Try again.`);
      entry = secured;
    }
    const trustedStickyTemporary = trustedTemporary.has(current) && entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if ((!own && entry.uid !== 0) || ((entry.mode & 0o022) !== 0 && !trustedStickyTemporary))
      throw new Error(
        `Peer registry parent ${JSON.stringify(current)} is unsafe. Verify its owner and remove group/other write permission before retrying.`
      );
    if (current === target && (!own || (entry.mode & 0o077) !== 0))
      throw new Error(
        `Peer registry ${JSON.stringify(current)} must be owned by this user and private (0700). Verify ownership and set directory permissions to 0700 before retrying.`
      );
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

function sameThread(a: PeerIdentity, b: PeerIdentity): boolean {
  return a.threadId === b.threadId && sameScope(a, b);
}

async function acquireEnrollment(root: string, identity: PeerIdentity): Promise<() => Promise<void>> {
  const directory = await ensurePeerRoot(join(root, 'enrollments'));
  const key = createHash('sha256')
    .update(JSON.stringify([identity.accountId, identity.projectId, identity.threadId]))
    .digest('hex');
  const file = join(directory, `${key}.lock`);
  const started = performance.now();
  let handle;
  while (!handle) {
    try {
      handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await lstat(file).catch(error => {
        if (missing(error)) return null;
        throw error;
      });
      if (!current) continue;
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.uid !== process.getuid!() ||
        (current.mode & 0o077) !== 0
      )
        throw new Error(
          `Unsafe peer enrollment lock ${JSON.stringify(file)}. Verify its owner and permissions before retrying.`
        );
      if (performance.now() - started >= DEADLINE_MS)
        throw new Error(
          `Peer enrollment lock ${JSON.stringify(file)} did not release. After verifying no peer enrollment is running, remove only this lock file and retry.`
        );
      await delay(10);
    }
  }
  const original = await handle.stat();
  const owner = JSON.stringify({ id: identity.id, generation: identity.generation, processId: process.pid });
  try {
    await handle.writeFile(owner);
  } catch (error) {
    await handle.close();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const current = await lstat(file).catch(error => {
        if (missing(error)) return null;
        throw error;
      });
      if (!current || current.ino !== original.ino || current.dev !== original.dev) return;
      const read = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const checked = await read.stat();
        if (checked.ino !== original.ino || checked.dev !== original.dev || (await read.readFile('utf8')) !== owner)
          return;
      } finally {
        await read.close();
      }
      await rm(file);
    } finally {
      await handle.close();
    }
  };
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
      candidate.updatedAt < 0 ||
      (requireFresh && (candidate.updatedAt > Date.now() + 5_000 || Date.now() - candidate.updatedAt > PEER_LEASE_MS))
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
  const release = initial ? undefined : await acquireEnrollment(root, manifest);
  try {
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
  } finally {
    await release?.();
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

async function ownerResponds(manifest: PeerManifest): Promise<boolean | undefined> {
  let socket: Socket | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await validateEndpoint(manifest.endpoint);
    socket = createConnection({ path: manifest.endpoint });
    const connection = socket;
    connection.on('error', () => undefined);
    timeout = setTimeout(() => connection.destroy(new Error('Peer ownership probe timed out.')), 1000);
    timeout.unref();
    await new Promise<void>((done, reject) => {
      connection.once('connect', done);
      connection.once('error', reject);
    });
    const challenge = object(await readFrame(connection));
    return challenge.version === 1 &&
      typeof challenge.nonce === 'string' &&
      secretPattern.test(challenge.nonce) &&
      challenge.generation === manifest.generation &&
      equalSecret(
        challenge.proof,
        sign(manifest.token, ['challenge', challenge.nonce, manifest.id, manifest.generation])
      )
      ? true
      : undefined;
  } catch (error) {
    return ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '') ? false : undefined;
  } finally {
    clearTimeout(timeout);
    socket?.destroy();
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

async function pruneManifest(root: string, manifest: PeerManifest, held?: PeerIdentity): Promise<void> {
  if (Date.now() - manifest.updatedAt <= PEER_LEASE_MS || (held && !sameThread(held, manifest))) return;
  const release = held ? undefined : await acquireEnrollment(root, manifest);
  try {
    const file = join(root, `${manifest.id}.json`);
    const claim = `${file}.prune`;
    let marker;
    try {
      marker = await open(
        claim,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
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
        current.updatedAt !== manifest.updatedAt
      )
        return;
      if ((await ownerResponds(current)) !== false) return;
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
  } finally {
    await release?.();
  }
}

async function registeredPeers(root: string, includeStaleOwners = false, held?: PeerIdentity): Promise<PeerManifest[]> {
  const peers: PeerManifest[] = [];
  for (const file of await registryFiles(root)) {
    const manifest = await readManifest(root, file.slice(0, -5), false);
    if (!manifest) continue;
    if (Date.now() - manifest.updatedAt > PEER_LEASE_MS) {
      await pruneManifest(root, manifest, held);
      const remaining = includeStaleOwners ? await readManifest(root, manifest.id, false) : null;
      if (remaining) peers.push(remaining);
    } else if (includeStaleOwners || manifest.updatedAt <= Date.now() + 5_000) peers.push(manifest);
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

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function boundedText(value: unknown, limit: number): boolean {
  return typeof value === 'string' && Buffer.byteLength(value) <= limit;
}

function validResponse(value: unknown): value is PeerResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  if (response.ok === false)
    return (
      onlyKeys(response, ['ok', 'error', 'unknown']) &&
      boundedText(response.error, 4096) &&
      (response.unknown === undefined || typeof response.unknown === 'boolean')
    );
  if (response.ok !== true || !onlyKeys(response, ['ok', 'receipt', 'presence'])) return false;
  if (response.presence !== undefined) {
    if (!response.presence || typeof response.presence !== 'object') return false;
    const presence = response.presence as Record<string, unknown>;
    if (
      !onlyKeys(presence, ['policy', 'ready']) ||
      !['hold', 'accept', 'refuse'].includes(String(presence.policy)) ||
      typeof presence.ready !== 'boolean'
    )
      return false;
  }
  if (response.receipt === undefined) return true;
  if (!response.receipt || typeof response.receipt !== 'object') return false;
  const receipt = response.receipt as Record<string, unknown>;
  return (
    onlyKeys(receipt, [
      'id',
      'senderId',
      'recipientId',
      'status',
      'createdAt',
      'expiresAt',
      'text',
      'replyTo',
      'hops',
      'result',
      'error',
    ]) &&
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
    receipt.createdAt >= 0 &&
    typeof receipt.expiresAt === 'number' &&
    Number.isFinite(receipt.expiresAt) &&
    receipt.expiresAt > receipt.createdAt &&
    typeof receipt.hops === 'number' &&
    Number.isInteger(receipt.hops) &&
    receipt.hops >= 0 &&
    receipt.hops <= 5 &&
    (receipt.text === undefined || boundedText(receipt.text, 8192)) &&
    (receipt.result === undefined || boundedText(receipt.result, 12288)) &&
    (receipt.error === undefined || boundedText(receipt.error, 1024)) &&
    (receipt.replyTo === undefined || (typeof receipt.replyTo === 'string' && idPattern.test(receipt.replyTo)))
  );
}

async function validateEndpoint(endpoint: string): Promise<void> {
  await ensurePeerRoot(dirname(endpoint));
  const entry = await lstat(endpoint);
  if (!entry.isSocket() || entry.uid !== process.getuid!() || (entry.mode & 0o077) !== 0)
    throw new Error('The peer endpoint is not a private socket.');
}

interface PeerTransportOptions {
  root: string;
  identity: PeerIdentity;
  handle: (sender: PeerIdentity, request: PeerRequest) => Promise<PeerResponse>;
  onClosed?: (reason: string) => void;
}

export async function startPeerTransport(
  options: PeerTransportOptions
): Promise<{ close(): Promise<void>; manifest: PeerManifest }> {
  supported();
  if (!isPeerIdentity(options.identity)) throw new Error('Invalid peer identity.');
  const root = await ensurePeerRoot(options.root);
  await registeredPeers(root);
  const release = await acquireEnrollment(root, options.identity);
  try {
    return await startEnrolledTransport(options, root, release);
  } finally {
    await release();
  }
}

async function startEnrolledTransport(
  options: PeerTransportOptions,
  root: string,
  releaseEnrollment: () => Promise<void>
): Promise<{ close(): Promise<void>; manifest: PeerManifest }> {
  const registered = await registeredPeers(root, true, options.identity);
  if (registered.length >= MAX_REGISTERED_PEERS) throw new Error('The peer registry has reached its session limit.');
  const duplicate = registered.find(peer => sameThread(peer, options.identity));
  if (duplicate)
    throw new Error(
      `This saved thread already has a registered peer process. Stop that process first. If ownership cannot be verified, inspect ${JSON.stringify(join(root, `${duplicate.id}.json`))}; remove only that manifest after confirming the old peer is stopped, then retry.`
    );
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
        !onlyKeys(envelope, ['version', 'senderId', 'generation', 'request', 'proof']) ||
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
      const release = await acquireEnrollment(root, identity);
      try {
        const current = await readManifest(root, identity.id, false);
        if (current?.generation === identity.generation && current.token === manifest.token)
          await rm(join(root, `${identity.id}.json`), { force: true });
      } finally {
        await release();
      }
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
    await releaseEnrollment();
    heartbeat = setInterval(() => {
      heartbeatWrite = heartbeatWrite
        .then(async () => {
          if (closed) return;
          manifest.updatedAt = Date.now();
          await ensurePeerRoot(root);
          await writeManifest(root, manifest);
        })
        .catch(error => {
          if (closed) return;
          void close().catch(() => undefined);
          try {
            options.onClosed?.(error instanceof Error ? error.message : 'The peer transport closed unexpectedly.');
          } catch {
            /* The transport must close even if its lifecycle observer fails. */
          }
        });
    }, 15_000);
    heartbeat.unref();
    return { close, manifest };
  } catch (error) {
    await releaseEnrollment();
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
      !onlyKeys(challenge, ['version', 'nonce', 'generation', 'proof']) ||
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
      !onlyKeys(result, ['version', 'response', 'proof']) ||
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
