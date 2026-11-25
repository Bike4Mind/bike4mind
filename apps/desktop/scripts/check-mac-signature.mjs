// Checks a macOS app signed with a pinned self-signed certificate: strict deep verification, the
// exact designated requirement, and the same certificate leaf on every Mach-O file inside.
// Usage: node check-mac-signature.mjs <path to .app> <bundle id> <certificate SHA-1>
import { execFileSync } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Thin and universal Mach-O headers, either byte order.
const MACH_O = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca']);

export function designatedRequirement(target) {
  return execFileSync('codesign', ['-d', '-r-', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function* machOFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    // Framework Versions/Current links point at files this walk reaches directly.
    if (entry.isDirectory()) yield* machOFiles(path);
    else if (entry.isFile()) {
      const file = await open(path, 'r');
      const { buffer, bytesRead } = await file.read(Buffer.alloc(4), 0, 4, 0);
      await file.close();
      if (bytesRead === 4 && MACH_O.has(buffer.toString('hex'))) yield path;
    }
  }
}

export async function checkMacSignature(app, bundleId, sha1) {
  if (!/^[0-9a-f]{40}$/.test(sha1)) throw new Error('Expected a lowercase 40-character certificate SHA-1');
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: ['ignore', 'pipe', 'pipe'] });
  const expected = `designated => identifier "${bundleId}" and certificate leaf = H"${sha1}"`;
  const requirement = designatedRequirement(app);
  if (requirement !== expected) throw new Error(`Unexpected designated requirement for ${app}: ${requirement}`);
  const leaf = `certificate leaf = H"${sha1}"`;
  let count = 0;
  for await (const file of machOFiles(app)) {
    const nested = designatedRequirement(file);
    if (!nested.includes(leaf)) throw new Error(`${file} is not signed by the expected certificate: ${nested}`);
    count += 1;
  }
  if (count === 0) throw new Error(`No Mach-O files found in ${app}`);
  return { requirement, machOFiles: count };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [app, bundleId, sha1] = process.argv.slice(2);
  if (!app || !bundleId || !sha1) {
    console.error('Usage: node check-mac-signature.mjs <app> <bundle id> <certificate SHA-1>');
    process.exit(2);
  }
  try {
    const { requirement, machOFiles: count } = await checkMacSignature(app, bundleId, sha1);
    console.log(`${requirement}\nAll ${count} Mach-O files carry the same certificate leaf.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
