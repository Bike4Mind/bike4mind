import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PYODIDE_VERSION } from '@bike4mind/common';

// Builds the runtime image's Pyodide directory (apps/workers/Dockerfile.callablefunction): the core files of the
// installed pyodide package, then the baked packages' wheels, each checked against the sha256 its lock file records.

// The first five are SUPPORTED_PYTHON_PACKAGES in apps/client/app/utils/pythonPackages.ts; lzma and Brotli are codecs.
const BAKED_PACKAGES = ['numpy', 'pandas', 'matplotlib', 'scipy', 'scikit-learn', 'lzma', 'brotli'];
const CORE_FILES = ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
const DISTRIBUTION = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

function closure(lock, names) {
  const seen = new Map();
  const queue = [...names];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const entry = lock.packages[name];
    if (!entry) throw new Error(`pyodide-lock.json has no package ${name}`);
    seen.set(name, entry);
    queue.push(...entry.depends);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function bake(outDir) {
  const require = createRequire(import.meta.url);
  const packageDir = path.dirname(require.resolve('pyodide/package.json'));
  const { version } = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  if (version !== PYODIDE_VERSION) {
    throw new Error(`pyodide ${version} is installed, but the runtime pins ${PYODIDE_VERSION}`);
  }
  await mkdir(outDir, { recursive: true });
  for (const file of CORE_FILES) await copyFile(path.join(packageDir, file), path.join(outDir, file));

  const lock = JSON.parse(await readFile(path.join(outDir, 'pyodide-lock.json'), 'utf8'));
  if (lock.info.version !== PYODIDE_VERSION) {
    throw new Error(`pyodide-lock.json is for ${lock.info.version}, not ${PYODIDE_VERSION}`);
  }
  for (const entry of closure(lock, BAKED_PACKAGES)) {
    const response = await fetch(new URL(entry.file_name, DISTRIBUTION));
    if (!response.ok) throw new Error(`${entry.file_name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== entry.sha256) {
      throw new Error(`${entry.file_name}: sha256 ${sha256}, but pyodide-lock.json records ${entry.sha256}`);
    }
    await writeFile(path.join(outDir, entry.file_name), bytes);
    console.log(`${entry.file_name} ${bytes.length} ${sha256}`);
  }
}

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node bakePyodide.mjs <output directory>');
  process.exit(2);
}
await bake(path.resolve(outDir));
