import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * A host version as the installer accepts it: it becomes a directory name on the remote machine
 * and is written into the scripts sent there. `.tmp` names an install in progress there, so no
 * version ends with it. Must stay in sync with requireVersion in scripts/host-artifact.cjs, which
 * packs the artifact (hostArtifact.test.ts checks both on the same inputs).
 */
const HOST_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const MAX_HOST_VERSION_LENGTH = 64;

export const isHostVersion = (version: string): boolean =>
  version.length <= MAX_HOST_VERSION_LENGTH && HOST_VERSION_PATTERN.test(version) && !version.endsWith('.tmp');

/** The directory, in the app's resources and in a source run's `out`, that holds the packed host. */
export const HOST_ARTIFACT_DIRECTORY = 'host';
const SOURCE_ARTIFACT_DIRECTORY = join('out', 'host-artifact');
const MANIFEST_FILE = 'manifest.json';

/** The manifest scripts/host-artifact.cjs writes beside the tarball. */
const manifestSchema = z.object({
  schema: z.literal(1),
  version: z.string().refine(isHostVersion, 'not a host version'),
  entry: z.literal('b4m-host.cjs'),
  tarball: z.object({
    file: z.literal('b4m-host.tar.gz'),
    size: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  files: z.array(z.object({ path: z.string().min(1), size: z.number().int().nonnegative() })),
});

/** The host program this Desktop installs: a gzipped tarball of the build, checked against its manifest. */
export type HostArtifact = { version: string; tarballPath: string; size: number; sha256: string };

export class HostArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostArtifactError';
  }
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Reads the artifact in `directory` and checks it: the manifest must parse, name `version`, and
 * describe the tarball beside it byte for byte. Any mismatch is a broken package, never a reason
 * to install something else.
 */
export async function readHostArtifact(directory: string, version: string): Promise<HostArtifact> {
  const manifestPath = join(directory, MANIFEST_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new HostArtifactError(
      `The host program is missing from this Desktop (${manifestPath}: ${error instanceof Error ? error.message : String(error)})`
    );
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new HostArtifactError(`${manifestPath} is not a host program manifest`);
  const manifest = parsed.data;
  if (manifest.version !== version) {
    throw new HostArtifactError(`The host program in ${directory} is version ${manifest.version}, not ${version}`);
  }
  const tarballPath = join(directory, manifest.tarball.file);
  const size = await stat(tarballPath).then(
    found => found.size,
    () => -1
  );
  if (size !== manifest.tarball.size || (await sha256Of(tarballPath)) !== manifest.tarball.sha256) {
    throw new HostArtifactError(`${tarballPath} does not match its manifest`);
  }
  return { version, tarballPath, size, sha256: manifest.tarball.sha256 };
}

/** Builds a source run's artifact at `version`; rejects with what the build printed. */
export type HostArtifactBuilder = (version: string) => Promise<void>;

export type HostArtifactSource =
  { packaged: true; resourcesPath: string } | { packaged: false; appPath: string; build?: HostArtifactBuilder };

const BUILD_OUTPUT_TAIL = 4 * 1024;

/**
 * Runs scripts/host-artifact.cjs with the Electron binary acting as Node, the way packaging runs
 * it, so a source run installs the source it runs.
 */
export function scriptArtifactBuilder(appPath: string, execPath: string = process.execPath): HostArtifactBuilder {
  return version =>
    new Promise((resolve, reject) => {
      const child = spawn(execPath, [join(appPath, 'scripts', 'host-artifact.cjs'), 'build', '--version', version], {
        cwd: appPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let output = '';
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-BUILD_OUTPUT_TAIL);
      };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.once('error', error => reject(new HostArtifactError(`Could not build the host program: ${error.message}`)));
      child.once('close', code => {
        if (code === 0) resolve();
        else reject(new HostArtifactError(`Building the host program failed (exit ${code}): ${output.trim()}`));
      });
    });
}

/**
 * Where this Desktop's host program comes from. A packaged app reads the copy packaging put in its
 * resources, once. A source run builds it on every call, at this run's version, so a run never
 * installs a stale build of another version; calls made during a build wait for that build rather
 * than start another in the same output directory. Edits that keep the version (a dirty tree)
 * do not reach a machine that already has it: the install keeps a working copy of a version.
 */
export function hostArtifactProvider(source: HostArtifactSource, version: string): () => Promise<HostArtifact> {
  if (source.packaged) {
    let read: Promise<HostArtifact> | null = null;
    return () => {
      // A failed read is not kept: the next call tries again.
      read ??= readHostArtifact(join(source.resourcesPath, HOST_ARTIFACT_DIRECTORY), version).catch(
        (error: unknown) => {
          read = null;
          throw error;
        }
      );
      return read;
    };
  }
  const build = source.build ?? scriptArtifactBuilder(source.appPath);
  let building: Promise<HostArtifact> | null = null;
  return () => {
    if (building) return building;
    const run = (async () => {
      await build(version);
      return readHostArtifact(join(source.appPath, SOURCE_ARTIFACT_DIRECTORY), version);
    })();
    building = run;
    const clear = () => {
      if (building === run) building = null;
    };
    run.then(clear, clear);
    return run;
  };
}
