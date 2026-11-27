import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { OllamaKey } from '@bike4mind/common/modelHub';

const MAX_KEY_BYTES = 1024;

/** Ollama's public key from the home it runs with; it signs pulls of gated and private Hugging Face repos. */
export async function readOllamaKey(home: string | null): Promise<OllamaKey> {
  if (!home) {
    return {
      path: null,
      publicKey: null,
      message: "b4m-host could not tell which home Ollama runs with, so it cannot find Ollama's key.",
    };
  }
  const path = join(home, '.ollama', 'id_ed25519.pub');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_KEY_BYTES) {
      return { path, publicKey: null, message: `${path} is not an Ollama public key.` };
    }
    const text = (await handle.readFile('utf8')).trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [\x20-\x7e]*)?$/.test(text)) {
      return { path, publicKey: null, message: `${path} is not an Ollama public key.` };
    }
    return { path, publicKey: text, message: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { path, publicKey: null, message: `Ollama has not created ${path} yet; it does when it first starts.` };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { path, publicKey: null, message: `b4m-host cannot read ${path}. On the server, run: sudo cat ${path}` };
    }
    return { path, publicKey: null, message: `Could not read ${path} (${code ?? 'error'}).` };
  } finally {
    await handle?.close();
  }
}
