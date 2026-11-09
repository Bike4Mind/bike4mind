import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOllamaWslPatchProbe, fileContainsAny, WSL_MEMORY_PATCH_MARKERS } from './ollamaWslPatch';

const URL = 'http://127.0.0.1:11434';
const PID = 4242;
const stockImage = () => Buffer.concat([Buffer.from('\x7fELF'), Buffer.alloc(4096, 7), Buffer.from('OLLAMA_HOST')]);
const imageWith = (marker: string) =>
  Buffer.concat([Buffer.from('\x7fELF'), Buffer.alloc(2048, 7), Buffer.from(`${marker}OLLAMA_HOST`)]);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ollama-wsl-patch-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const later = () => Date.now() + 10_000;

describe('fileContainsAny', () => {
  it.each(WSL_MEMORY_PATCH_MARKERS)('finds %s', async marker => {
    const path = join(dir, 'ollama');
    await writeFile(path, imageWith(marker));
    await expect(fileContainsAny(path, WSL_MEMORY_PATCH_MARKERS, later())).resolves.toBe(true);
  });

  it('reads a release build to the end and finds none', async () => {
    const path = join(dir, 'ollama');
    await writeFile(path, stockImage());
    await expect(fileContainsAny(path, WSL_MEMORY_PATCH_MARKERS, later())).resolves.toBe(false);
  });

  it('finds a marker split across two reads', async () => {
    const path = join(dir, 'ollama');
    await writeFile(path, Buffer.from('abcdeOLLAMA_WSL_GPU_SPILLxyz'));
    await expect(fileContainsAny(path, WSL_MEMORY_PATCH_MARKERS, later(), 8)).resolves.toBe(true);
    await expect(fileContainsAny(path, ['SPILLx'], later(), 3)).resolves.toBe(true);
    await expect(fileContainsAny(path, ['SPILLy'], later(), 3)).resolves.toBe(false);
  });

  it('is unknown for a file it cannot open', async () => {
    await expect(fileContainsAny(join(dir, 'missing'), WSL_MEMORY_PATCH_MARKERS, later())).resolves.toBeNull();
  });

  it('is unknown once the deadline passes before the end', async () => {
    const path = join(dir, 'ollama');
    await writeFile(path, stockImage());
    await expect(fileContainsAny(path, WSL_MEMORY_PATCH_MARKERS, Date.now() - 1)).resolves.toBeNull();
  });
});

describe('createOllamaWslPatchProbe', () => {
  async function runningImage(content: Buffer, pid = PID) {
    await mkdir(join(dir, String(pid)), { recursive: true });
    await writeFile(join(dir, String(pid), 'exe'), content);
  }

  it.each(WSL_MEMORY_PATCH_MARKERS)('reports a running build declaring %s as carrying the fix', async marker => {
    await runningImage(imageWith(marker));
    const serverPid = vi.fn(async () => PID);
    await expect(createOllamaWslPatchProbe({ serverPid, procDir: dir })(URL)).resolves.toBe(true);
    expect(serverPid).toHaveBeenCalledWith(URL);
  });

  it('reports a running release build as lacking the fix', async () => {
    await runningImage(stockImage());
    await expect(createOllamaWslPatchProbe({ serverPid: async () => PID, procDir: dir })(URL)).resolves.toBe(false);
  });

  it.each([
    ['no server process is seen for the address', async () => null],
    ['the process lookup fails', async () => Promise.reject(new Error('EMFILE'))],
    ['the pid is not one', async () => 0],
  ])('is unknown when %s', async (_case, serverPid: () => Promise<number | null>) => {
    await runningImage(stockImage());
    await expect(createOllamaWslPatchProbe({ serverPid, procDir: dir })(URL)).resolves.toBeNull();
  });

  it("is unknown when the server's image cannot be read, as another user's", async () => {
    await expect(createOllamaWslPatchProbe({ serverPid: async () => PID, procDir: dir })(URL)).resolves.toBeNull();
  });

  it('is unknown when the process lookup does not answer in time', async () => {
    await runningImage(stockImage());
    const probe = createOllamaWslPatchProbe({ serverPid: () => new Promise(() => {}), procDir: dir, timeoutMs: 20 });
    await expect(probe(URL)).resolves.toBeNull();
  });

  it('reads again once Ollama runs another binary', async () => {
    await runningImage(imageWith('OLLAMA_WSL_SHARED_GPU_MEMORY'));
    const probe = createOllamaWslPatchProbe({ serverPid: async () => PID, procDir: dir });
    await expect(probe(URL)).resolves.toBe(true);
    await expect(probe(URL)).resolves.toBe(true);
    await runningImage(stockImage());
    await expect(probe(URL)).resolves.toBe(false);
  });
});
