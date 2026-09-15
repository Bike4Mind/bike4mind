#!/usr/bin/env node
// Removes compiled test routes from a Next.js build output.
//
// Next treats every file under pages/ as a route, including __tests__/
// subdirectories (see CLAUDE.md testing guidelines), so vitest files compile
// into routable page entries. The standalone server preloads every route
// module at boot, which executes test-file side effects in production: one
// test calls aws-sdk-client-mock's mockClient(S3Client), replacing
// S3Client.prototype.send process-wide with a stub that resolves undefined,
// silently breaking every S3/MinIO operation in the self-host image. Pruning
// the compiled entries keeps test code out of the shipped server entirely.
//
// Usage: node pruneTestRoutes.mjs <path-to-.next-dir>

import fs from 'node:fs';
import path from 'node:path';

const nextDir = process.argv[2];
if (!nextDir || !fs.existsSync(path.join(nextDir, 'server', 'pages-manifest.json'))) {
  console.error('usage: pruneTestRoutes.mjs <.next dir containing server/pages-manifest.json>');
  process.exit(1);
}

const isTestEntry = (p) => p.includes('/__tests__/') || /\.test\.js$/.test(p);

const pagesManifestPath = path.join(nextDir, 'server', 'pages-manifest.json');
const pagesManifest = JSON.parse(fs.readFileSync(pagesManifestPath, 'utf8'));
let droppedRoutes = 0;
for (const [route, file] of Object.entries(pagesManifest)) {
  if (!isTestEntry(file)) continue;
  for (const target of [file, `${file}.nft.json`]) {
    fs.rmSync(path.join(nextDir, 'server', target), { force: true });
  }
  delete pagesManifest[route];
  droppedRoutes++;
}
fs.writeFileSync(pagesManifestPath, JSON.stringify(pagesManifest));

const routesManifestPath = path.join(nextDir, 'routes-manifest.json');
if (fs.existsSync(routesManifestPath)) {
  const routesManifest = JSON.parse(fs.readFileSync(routesManifestPath, 'utf8'));
  for (const key of ['staticRoutes', 'dynamicRoutes']) {
    if (Array.isArray(routesManifest[key])) {
      routesManifest[key] = routesManifest[key].filter(r => !isTestEntry(`${r.page}.js`));
    }
  }
  fs.writeFileSync(routesManifestPath, JSON.stringify(routesManifest));
}

// Drop the now-empty compiled __tests__ directories.
const pagesDir = path.join(nextDir, 'server', 'pages');
const testDirs = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === '__tests__') testDirs.push(full);
    else walk(full);
  }
};
if (fs.existsSync(pagesDir)) walk(pagesDir);
for (const dir of testDirs) fs.rmSync(dir, { recursive: true, force: true });

console.log(`pruned ${droppedRoutes} test routes, removed ${testDirs.length} __tests__ dirs`);
