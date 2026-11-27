import { HOST_EXIT_CODES } from '../../../../host/headless/exitCodes';
import { isHostVersion } from './hostArtifact';

/*
 * The scripts Desktop runs on a remote machine, each sent on stdin to `ssh <alias> -- sh -s`.
 * POSIX sh only. Everything in them is fixed text except four values, each checked against a
 * strict pattern before it is placed between single quotes: the version (from Desktop's own
 * manifest), the sha256 (likewise), a lock token Desktop generates, and the Node.js path the
 * probe found; and the upload, checked to be base64 lines. Nothing else the machine reports
 * reaches a script or a command line.
 *
 * Layout under ~/.b4m/host (the daemon's data directory too, see host/headless/cli.ts):
 *   versions/<version>/      one complete, verified build each
 *   versions/<version>.tmp/  an install in progress; removed by the next install
 *   bin/b4m-host             the launcher REMOTE_CONNECT_COMMAND (sshCommand.ts) runs
 *   install.lock             a symlink to `<token>-<epoch seconds>`; one install at a time
 */

/** Node.js paths the installer writes into a launcher: absolute, no quote or control character. */
const NODE_PATH_PATTERN = /^\/[A-Za-z0-9 ._+@/-]*$/;
const MAX_NODE_PATH_LENGTH = 1024;
const TOKEN_PATTERN = /^[0-9a-f]{16,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const isUsableNodePath = (path: string): boolean =>
  path.length <= MAX_NODE_PATH_LENGTH && NODE_PATH_PATTERN.test(path);

/** A checked value as a single-quoted shell word; throws for anything the pattern does not accept. */
function quoted(value: string, valid: (value: string) => boolean, what: string): string {
  if (!valid(value)) throw new Error(`Refusing to place ${what} ${JSON.stringify(value)} in a remote script`);
  return `'${value}'`;
}

/** Seconds after which another installer's lock counts as abandoned. */
export const INSTALL_LOCK_STALE_SECONDS = 600;
/** Seconds an install waits for another install's live lock before giving up. */
export const INSTALL_LOCK_WAIT_SECONDS = 120;

/** Prefix of every line the probe reports on stdout. */
export const PROBE_PREFIX = 'b4m-probe';
/** Prefix of the install script's phase and error lines on stdout. */
export const INSTALL_PREFIX = 'b4m-install';

/**
 * Prints the version of the daemon recorded in the lock file named by its argument, if that
 * process is alive; nothing otherwise. Deliberately looser than the daemon's own check (which also
 * asks the socket): a version kept by mistake costs disk space, one pruned by mistake breaks a
 * running daemon. No single quote inside: the scripts embed it in single quotes.
 */
const RUNNING_DAEMON_JS = [
  'try {',
  '  const lock = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));',
  '  let alive = true;',
  '  try { process.kill(lock.pid, 0); } catch (error) { alive = error.code === "EPERM"; }',
  '  if (alive && typeof lock.version === "string") process.stdout.write(lock.version);',
  '} catch {}',
].join(' ');

/**
 * Reads the base64 upload on stdin, checks it against the sha256 in argv[1], and writes the
 * ungzipped tar to argv[2]. Writes nothing for an upload that arrived damaged.
 */
const DECODE_UPLOAD_JS = [
  'const chunks = [];',
  'process.stdin.on("data", chunk => chunks.push(chunk));',
  'process.stdin.on("end", () => {',
  '  const gzipped = Buffer.from(Buffer.concat(chunks).toString("latin1"), "base64");',
  '  const sha256 = require("crypto").createHash("sha256").update(gzipped).digest("hex");',
  '  if (sha256 !== process.argv[1]) {',
  '    process.stderr.write("the upload arrived damaged (sha256 " + sha256 + ")\\n");',
  '    process.exit(3);',
  '  }',
  '  require("fs").writeFileSync(process.argv[2], require("zlib").gunzipSync(gzipped), { mode: 0o600 });',
  '});',
].join(' ');

/**
 * Reports what the installer needs to know, one `b4m-probe <key> <value>` line each, ending with
 * `end`. Node.js is looked up through the login shell first, because a non-interactive ssh
 * session often lacks the PATH that nvm or Homebrew set up, and reports its own executable: a
 * version manager's shim or per-shell link may not outlive the shell that found it. The launcher's own `version` tells
 * whether the active install still works; its exit code says why not.
 */
export const PROBE_SCRIPT = `set -eu
H="$HOME/.b4m/host"
say() { printf '${PROBE_PREFIX} %s %s\\n' "$1" "$2"; }
say format 1
say os "$(uname -s)"
say arch "$(uname -m)"
if command -v tar >/dev/null 2>&1; then say tar yes; else say tar no; fi
node=$("\${SHELL:-/bin/sh}" -lc 'node -p process.execPath' </dev/null 2>/dev/null | tail -n 1 || true)
case $node in /*) ;; *) node=$(node -p process.execPath </dev/null 2>/dev/null | tail -n 1 || true) ;; esac
case $node in
  /*)
    say node "$node"
    say nodeVersion "$("$node" --version </dev/null 2>/dev/null | head -n 1 || true)"
    ;;
esac
if [ -d "$H/versions" ]; then
  for d in "$H/versions"/*; do
    if [ -d "$d" ]; then say installed "\${d##*/}"; fi
  done
fi
if [ -e "$H/bin/b4m-host" ]; then
  set +e
  active=$("$H/bin/b4m-host" version </dev/null 2>/dev/null)
  code=$?
  set -e
  say launcherExit "$code"
  say active "$(printf '%s' "$active" | head -n 1)"
fi
if [ -f "$H/host.lock" ]; then
  case $node in
    /*) say daemon "$("$node" -e '${RUNNING_DAEMON_JS}' "$H/host.lock" </dev/null 2>/dev/null || true)" ;;
    *) say daemon unknown ;;
  esac
fi
say end 1
`;

/** Stops the daemon, if one runs, through the active launcher. */
export const STOP_DAEMON_SCRIPT = `set -eu
L="$HOME/.b4m/host/bin/b4m-host"
if [ -x "$L" ]; then exec "$L" stop </dev/null; fi
`;

/**
 * The launcher: runs one installed build with the Node.js the probe found. It names an absolute
 * Node path because the non-interactive shell ssh starts may not have node on PATH at all.
 */
export function launcherScript(version: string, nodePath: string): string {
  const v = quoted(version, isHostVersion, 'the version');
  const node = quoted(nodePath, isUsableNodePath, 'the Node.js path');
  return `#!/bin/sh
# Written by Bike4Mind Desktop; every install replaces it.
node=${node}
if [ ! -x "$node" ]; then
  echo "b4m-host: Node.js is no longer at $node; reinstall the host program from Bike4Mind Desktop" >&2
  exit ${HOST_EXIT_CODES.nodeMissing}
fi
exec "$node" "$HOME/.b4m/host/versions/"${v}"/b4m-host.cjs" "$@"
`;
}

type LockedScriptInput = {
  version: string;
  nodePath: string;
  /** Names this run's lock; random, generated by Desktop. */
  token: string;
  /** Default INSTALL_LOCK_WAIT_SECONDS. */
  lockWaitSeconds?: number;
};

export type InstallScriptInput = LockedScriptInput & {
  sha256: string;
  /** The gzipped tarball, base64 in lines no longer than 76 characters. */
  payloadLines: readonly string[];
  /** False to leave the version unpacked beside the active one, for activateScript to switch to. Default true. */
  activate?: boolean;
};

export type ActivateScriptInput = LockedScriptInput;

const PAYLOAD_END = 'B4M_PAYLOAD_END';
const LAUNCHER_END = 'B4M_LAUNCHER_END';

/**
 * The script head, everything before the upload. Takes the install lock (waiting for a live one,
 * clearing an abandoned one), and on any exit removes this install's unfinished files and releases
 * it. Also clears what an install killed before its trap ran left behind.
 */
function lockedHead(input: LockedScriptInput): string {
  const wait = input.lockWaitSeconds ?? INSTALL_LOCK_WAIT_SECONDS;
  if (!Number.isInteger(wait) || wait < 0) throw new Error(`Not a lock wait: ${wait}`);
  return `set -eu
umask 077
H="$HOME/.b4m/host"
V=${quoted(input.version, isHostVersion, 'the version')}
NODE=${quoted(input.nodePath, isUsableNodePath, 'the Node.js path')}
TOKEN=${quoted(input.token, value => TOKEN_PATTERN.test(value), 'the lock token')}
LOCK="$H/install.lock"
T="$H/versions/$V.tmp"
phase() { printf '${INSTALL_PREFIX} phase %s\\n' "$1"; }
fail() { printf '${INSTALL_PREFIX} error %s\\n' "$1"; printf 'b4m-host install: %s\\n' "$2" >&2; exit 1; }
mkdir -p "$H/versions" "$H/bin"
chmod 700 "$H"
taken=''
release() {
  if [ -n "$taken" ] && [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$taken" ]; then
    rm -rf "$T" "$T.tar" "$H/bin/b4m-host.$TOKEN.tmp"
    rm -f "$LOCK"
  fi
  taken=''
}
trap release EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
waited=0
while :; do
  stamp="$TOKEN-$(date +%s)"
  if ln -s "$stamp" "$LOCK" 2>/dev/null; then taken=$stamp; break; fi
  owner=$(readlink "$LOCK" 2>/dev/null || true)
  since=\${owner##*-}
  case $since in ''|*[!0-9]*) since=0 ;; esac
  if [ $(( $(date +%s) - since )) -gt ${INSTALL_LOCK_STALE_SECONDS} ]; then
    # Moved aside under this install's own name first, so two installs clearing one abandoned
    # lock cannot both remove it; a lock that turns out fresh is put back.
    if mv "$LOCK" "$LOCK.$TOKEN" 2>/dev/null; then
      moved=$(readlink "$LOCK.$TOKEN" 2>/dev/null || true)
      if [ "$moved" != "$owner" ]; then ln -s "$moved" "$LOCK" 2>/dev/null || true; fi
      rm -f "$LOCK.$TOKEN"
    fi
    continue
  fi
  if [ "$waited" -ge ${wait} ]; then
    fail busy "another install to this machine has held its lock for over ${wait} seconds"
  fi
  sleep 1
  waited=$((waited + 1))
done
for leftover in "$H/versions"/*.tmp "$H/versions"/*.tmp.tar "$H/bin"/b4m-host.*.tmp; do
  if [ -e "$leftover" ]; then rm -rf "$leftover"; fi
done
`;
}

/**
 * Installs one version: unpacks the upload into `<version>.tmp`, checks that the build there
 * reports the expected version, renames it into place, then (unless `activate` is false) replaces
 * the launcher (written beside it and renamed, so a connect never runs half a launcher) and prunes
 * every other version except the running daemon's. Prints `b4m-install phase <name>` as it moves
 * on, and `b4m-install error <code>` before failing for a reason of its own. Re-running it after any interruption converges:
 * a version already in place and working is kept instead of unpacked again.
 *
 * The upload is a here-document inside the `if`, so the shell has read all of it before running
 * any of that block: an upload cut short is a syntax error that runs nothing, and the lock and the
 * leftovers are cleared by the trap now and by the next install.
 */
export function installScript(input: InstallScriptInput): string {
  for (const line of input.payloadLines) {
    if (!/^[A-Za-z0-9+/=]{1,76}$/.test(line))
      throw new Error('The upload must be base64 lines of at most 76 characters');
  }
  const sha = quoted(input.sha256, value => SHA256_PATTERN.test(value), 'the sha256');
  return `${lockedHead(input)}SHA=${sha}
if [ "$("$NODE" "$H/versions/$V/b4m-host.cjs" version </dev/null 2>/dev/null || true)" != "$V" ]; then
  mkdir "$T"
  "$NODE" -e '${DECODE_UPLOAD_JS}' "$SHA" "$T.tar" <<'${PAYLOAD_END}'
${input.payloadLines.join('\n')}
${PAYLOAD_END}
  phase verifying
  tar -xf "$T.tar" -C "$T"
  rm -f "$T.tar"
  reported=$("$NODE" "$T/b4m-host.cjs" version </dev/null 2>&1 | head -n 1 || true)
  if [ "$reported" != "$V" ]; then fail verify "the uploaded build reports version '$reported', not $V"; fi
  rm -rf "$H/versions/$V"
  mv "$T" "$H/versions/$V"
else
  phase verifying
fi
${input.activate === false ? '' : activation(input)}phase installed
`;
}

/**
 * Makes an installed version the active one (see installScript); fails with `b4m-install error
 * verify` when that version is missing or does not run.
 */
export function activateScript(input: ActivateScriptInput): string {
  return `${lockedHead(input)}if [ "$("$NODE" "$H/versions/$V/b4m-host.cjs" version </dev/null 2>/dev/null || true)" != "$V" ]; then
  fail verify "version $V is not installed"
fi
${activation(input)}phase installed
`;
}

/** Replaces the launcher, then prunes every version but V and the running daemon's. */
function activation(input: LockedScriptInput): string {
  return `phase activating
cat > "$H/bin/b4m-host.$TOKEN.tmp" <<'${LAUNCHER_END}'
${launcherScript(input.version, input.nodePath)}${LAUNCHER_END}
chmod 755 "$H/bin/b4m-host.$TOKEN.tmp"
mv -f "$H/bin/b4m-host.$TOKEN.tmp" "$H/bin/b4m-host"
running=$("$NODE" -e '${RUNNING_DAEMON_JS}' "$H/host.lock" </dev/null 2>/dev/null || true)
for d in "$H/versions"/*; do
  if [ ! -d "$d" ]; then continue; fi
  name=\${d##*/}
  if [ "$name" = "$V" ] || [ "$name" = "$running" ]; then continue; fi
  rm -rf "$d"
done
`;
}
