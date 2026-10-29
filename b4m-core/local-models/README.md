# @bike4mind/local-models

Discovery and management of local LLM runtimes (Ollama, LM Studio, llama-server, vLLM) and host hardware, shared by the B4M CLI and desktop app.

This is a private workspace package bundled by its consumers; it is not published to npm. Desktop and CLI integration land separately.

```ts
import { detectRuntimes, OllamaRuntime, probeHardware } from '@bike4mind/local-models';

const detected = await detectRuntimes();
for (const { runtime, health } of detected) {
  if (!health.ok) {
    console.error(runtime.id, health.error);
    continue;
  }
  console.log(runtime.id, await runtime.list());
}

const ollama = new OllamaRuntime();
const controller = new AbortController();
await ollama.pull('qwen2.5:0.5b', {
  signal: controller.signal,
  onProgress: progress => console.log(progress),
});
console.log(await ollama.inspect('qwen2.5:0.5b'));
console.log(await probeHardware());
```

Discovery omits unavailable hosts and returns authentication failures with `health.ok: false` (on a default port, only when the 401/403 carries an OpenAI/Ollama-style JSON `error` or a FastAPI string `detail`; bare status codes and HTML responses are ignored); pass `{ url, apiKey }` in `hosts` to authenticate. Runtime operations reject with typed errors, and cancelling a pull rejects with the signal's abort reason (`AbortError` by default). `idleTimeoutMs` must be positive and defaults to five minutes; `Infinity` disables the pull watchdog. Invalid values reject before sending a request. Unmeasurable disk and GPU memory are `null`. GPUs come from `nvidia-smi`, then Linux sysfs (amdgpu reports VRAM, checked against its KFD gfx target; Intel Arc memory stays unknown) or the Windows video controllers and their driver keys; integrated GPUs that Ollama skips by default are not counted; supported Strix Halo graphics stay visible with unknown memory, so `memoryKind: 'cpu'` with `confidence: 'high'` means no usable GPU. VRAM is summed within one vendor only. `confidence: 'low'` means a usable GPU's memory is unknown or the GPUs could not be listed or opened (WSL, sandboxes without sysfs, containers without access to the GPU's device node, failed Windows enumeration, or malformed controller data). Pass an existing model directory to `probeHardware({ modelDir })` to measure its free disk space.

To size a model before it is installed, read its GGUF header from a local file or a URL. Only the header is fetched (Range requests, growing in size), so a 20 GB Hugging Face file costs a few MB:

```ts
import { inspectGguf, readGgufMetadata } from '@bike4mind/local-models';

const url = 'https://huggingface.co/unsloth/Qwen3-30B-A3B-GGUF/resolve/main/Qwen3-30B-A3B-Q4_K_M.gguf';
const { arch, tensorStats } = await inspectGguf(url, { authorization: `Bearer ${hfToken}` });
const { metadata, tensors } = await readGgufMetadata('/models/model.gguf');
```

`inspectGguf` returns the same `{ arch, tensorStats }` as `OllamaRuntime.inspect`. Arrays longer than 1024 entries (the tokenizer vocabulary and merges) come back as `{ omitted: true, itemType, length }`. `readGgufMetadata` also returns `types`, each key's GGUF type plus `itemType` for an array, which `metadata` cannot show for an integer's width or an empty array. For a split GGUF, it reads the tensor infos of every shard, which a URL or path named `*-00001-of-0000N.gguf` finds by itself (or pass `shards`), so MoE expert sizes cover the whole model. `authorization` is never sent to another origin, such as the CDN Hugging Face redirects to. A malformed, truncated, big-endian or v1 header rejects with `GgufFormatError`.

`HuggingFaceHub` searches the Hugging Face Hub for GGUF repos and reads a repo's builds pinned to one commit: each quant with its files (split shards grouped, subfolders included), sizes, sha256, resolve URLs and a planned `hf.co/<repo>:<tag>` ref for Ollama, plus vision projectors, every declared license (`licenses`; a repo that lists several is bound by all of them, and `other` marks a license named only in `licenseName` or ones dropped past the cap of ten), base models and gated status. The registry behind those refs serves the first file in path order whose name ends with the tag and skips some draft and assistant models that the file list cannot reveal, so call `verifyOllamaRef` right before a pull: it asks the registry for the tag's manifest and returns the ref only when the model layer is the build's sha256. Pass `token` for gated or private repos; it is sent only to the configured endpoint and never appears in errors. Ollama's own pull never carries that token: for a repo with `ollamaNeedsSshKey`, the Ollama host's public key (`~/.ollama/id_ed25519.pub`) has to be added to the Hugging Face account at `HUGGING_FACE_SSH_KEYS_URL` first, as [Hugging Face's Ollama guide](https://huggingface.co/docs/hub/en/ollama#run-private-ggufs-from-the-hugging-face-hub) describes.

```ts
import { HuggingFaceHub, OllamaRuntime } from '@bike4mind/local-models';

const hub = new HuggingFaceHub();
const { models } = await hub.search({ query: 'qwen2.5 0.5b', sort: 'downloads' });
const detail = await hub.getModel(models[0].id);
const build = detail.builds.find(entry => entry.quant === 'Q4_K_M');
const ref = build && (await hub.verifyOllamaRef(detail, build));
if (ref) await new OllamaRuntime().pull(ref);
```

`LlamaServerRuntime` manages llama.cpp's `llama-server` over a directory of GGUF files the caller owns. It is a `LocalRuntime` with id and kind `llama-server`; its `baseUrl` is the models directory as a `file:` URL, since each server listens on its own port. `findLlamaServer({ path })` checks a configured or bundled binary (or, without `path`, the first qualifying `llama-server` on PATH) by running `--version`, and requires build `MIN_LLAMA_SERVER_BUILD` (b5501, the first with `--offline`) or newer; an older or unnumbered build throws `LlamaServerVersionError`, and `health()` reports the same without throwing. On Linux a binary with `libllama.so` beside it runs with its directory on `LD_LIBRARY_PATH`, since older release zips (b5501 among them) carry no `$ORIGIN` runpath; a launcher in `binaryArgs` must set that itself. Nothing downloads a binary or a model on its own.

`store` lists, adds, removes and downloads GGUF files, and lists or discards partial downloads (`partials()`, `discardPartial(name)`; `remove(name)` also deletes a name that has only a partial download). A model's name is its path under the models directory with `/` separators: `add(path)` copies a file (with its sibling shards, or `ModelIncompleteError` naming the missing ones) to the top level, and downloads land under `<owner>/<repo>/<path in repo>`, so files of the same name from different repos never collide. Each path segment may hold only letters, digits, space and `._+-()[]` (`InvalidModelNameError` otherwise), and `list()` skips files whose names break that. Capabilities come from the GGUF header as `readGgufMetadata` reads it: a `clip` file counts as a projector, whatever its name; a model with a pooling type or an encoder-only architecture reports `embeddings` and no `completion`; every other model reports `completion`, `tools` unless its chat template is readable and never mentions tools, and `thinking` when the template uses `<think>`, `enable_thinking`, `reasoning_effort`, gpt-oss's analysis channel or `[THINK]`. A header with an array of arrays is unreadable, as it is to llama.cpp.

Every write holds `<file>.lock`, so a second download, copy or removal of the same file, in this process or another, fails with `ModelFileBusyError`. The holder refreshes the lock every 10 seconds; a lock not refreshed for 30 seconds, or last refreshed before the machine booted, is taken over. A download reads its lock back at least every 16 MiB and right before renaming, so a writer whose lock was taken over stops within 16 MiB and never renames over the new holder's file; a lock it cannot read for a moment (`EACCES`, `EBUSY`) is kept until the 30-second window passes, and the read before renaming retries it a few times before failing. One process at a time takes over a given lock, through `<file>.lock.takeover`; a guard left by a crash is cleared on the same 30-second and boot rules, and `.stale-*` files and guard drafts a crash leaves are swept once that old. On file systems without hard links (FAT32, exFAT) the guard is created with an exclusive open instead, and an empty guard there counts as a crash leftover only once it is a few seconds old. A `.partial.json` left without its partial is deleted by `partials()` and by the next download of that file. `remove` and `discardPartial` take `{ force: true }` to override a live lock. File errors reject with `RuntimeStorageError`, whose `code` is the errno code and `operation` says whether a read or a write failed. `store.download(hub, { repo, revision, files })` fetches a Hugging Face build from its pinned resolve URLs, resumes a `.partial` file with a Range request after re-hashing the bytes it keeps (progress status `resuming`) when its `.partial.json` names the same sha256 and size (otherwise it starts over), checks the size on disk and the sha256 before renaming it into place, records the repo, revision and sha256 in `<file>.source.json` (the model's `source`), and keeps the token off the CDN; a file with no published sha256 starts over instead of resuming. A file already present, or finished by another download while this one waited for the lock, is kept only when its sha256 matches, from the sidecar or by hashing it (status `verifying`); otherwise the download throws `ModelFileConflictError`. `HuggingFaceHub.download` follows the same rule and never overwrites its destination. `pull('hf.co/<repo>:<quant>')` downloads the build whose quant label matches, ignoring case (`Q4_K_M` when the ref names none), and `list()` shows only complete, non-projector models.

`start(model)` runs one server per model on `127.0.0.1` with `--port 0 --offline --no-webui --jinja` and a fresh API key passed in the environment (not argv). It takes the port from the server's own listening lines, matched whole in the formats llama-server prints (b5501 on bind, current builds after the load), so a model string logged during the load cannot name another port mid-line. On Linux every port named that way must also have its listening socket held by the server's process group, so a whole forged line naming another port is passed over and start keeps waiting for the real one. A group member that a launcher reparented away from it still counts, by its process group in `/proc`. A build whose listening line is in another format is found by the one loopback socket its group holds, but only once its model has loaded a few seconds ago with no named port confirmed, so another listener a launcher keeps in the group never wins over the real line. Elsewhere the named ports are tried in the order printed: the real server binds before it prints its line, so a port that refuses the connection is passed over and the first one that answers at all (`503` while loading included) is kept. A forged line naming a live listener, printed before the real line, is the limit there. If the server has said its model loaded and no port is confirmed, or the confirmed port has not answered `/health`, within `LLAMA_SERVER_PORT_GRACE_MS` (30 seconds), start fails with `LlamaServerStartError`: reason `no-port` when no port was named or the port never became healthy, or, on Linux, `socket-unreadable` (no `/proc/net/tcp`, or a setuid or setcap binary that hides its sockets), `other-namespace` (a launcher that runs the server in a container or another network namespace) or `wrong-server` (a launcher that moves the server out of its process group). It then waits for `/health`, requires `/props` to refuse a request without the key (`LlamaServerStartError` with reason `unauthenticated` otherwise, for instance behind a launcher in `binaryArgs` that drops the environment), and checks that `/v1/models` serves the model with the key. The context is `DEFAULT_LLAMA_SERVER_CONTEXT_SIZE` (16384) when `contextSize` is not set; callers such as Desktop pass one sized to the hardware. `extraArgs` accepts only the flags in `LLAMA_SERVER_TUNING_FLAGS`, each value as its own argument. Flash attention is the typed `flashAttention` option (`auto`, the default, `on` or `off`), since the flag changed in b6325 (`LLAMA_SERVER_FLASH_ATTN_VALUE_BUILD`): `auto` passes nothing on any build (the default from b6325, off before it); `on` and `off` pass `-fa on` and `-fa off` from that build, and before it `on` passes a bare `-fa` and `off` nothing. The runtime reads the build from `--version` once per binary, keyed on the file that actually runs (symlinks resolved, and any file in `binaryArgs`); a build that prints no number is refused only when `on` or `off` needs it. A quantized V cache (`-ctv q8_0` and the like) needs flash attention, so it turns `auto` into `on`, and `flashAttention: 'off'` with one is refused before spawning. The returned process exposes `baseUrl`, `apiKey` and `model` for chat; `exited` and `onExit` report a crash, and `stop()` sends SIGTERM, then SIGKILL, to the server's process group (its process tree on Windows); if a launcher exits first, the rest of its group is killed with it (POSIX only; on Windows a launcher that exits first can leave llama-server running). Concurrent `start(model)` calls share one server: each caller's `signal` rejects only that call, the start is cancelled once every waiting caller has aborted, each caller's `onExit` is called, and the first caller's tuning applies. `stop(model)` on a server that is still loading cancels it, and its `start` rejects; a `start(model)` during a `stop(model)`, or after a cancelled one, waits for the old server to exit and starts a fresh one, so one model never runs twice; `running()` and `loaded()` list only servers that are ready. A process that exits before it is ready rejects with `LlamaServerExitError` (`portInUse` for a fixed `port` that was taken); start waits as long as the process is alive and loading (current builds print nothing while they load), until ready, exit, `signal`, `stop()` or the port grace above; `startTimeoutMs`, if set, caps the whole start and rejects with `LlamaServerStartError` reason `timeout`; a batch-file `binaryPath` with `LlamaServerBinaryError`; a failed hash check with `DownloadVerificationError`.

Servers still running when the Node process emits `exit` are killed. They run in their own process group, so Ctrl-C in a terminal does not reach them, and a signal ends Node without `exit` unless the host handles it: the host must stop the servers in its own SIGINT and SIGTERM handlers, or they keep running as orphans:

```ts
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void llama.stopAll().finally(() => process.exit(0)));
}
```

```ts
import { LlamaServerRuntime, findLlamaServer } from '@bike4mind/local-models';

const binary = await findLlamaServer({ path: bundledLlamaServerPath });
const llama = new LlamaServerRuntime({ binaryPath: binary.path, modelsDir });
await llama.pull('hf.co/ggml-org/SmolLM2-135M-GGUF:Q4_K_M', { signal, onProgress });
const [model] = await llama.list();
const server = await llama.start(model.name, { contextSize: 8192, flashAttention: 'on', extraArgs: ['-ctv', 'q8_0'] });
// POST `${server.baseUrl}/v1/chat/completions` with `Authorization: Bearer ${server.apiKey}` and `model: server.model`
await llama.stopAll();
```

`isAbliteratedModel(model)` flags a search hit or detail whose repo id, tags or base models mark it as abliterated, decensored, uncensored or heretic (whole words except `abliterat`); callers hide these by default and never recommend them.

`loadCuratedManifest()` returns the curated model list bundled from `catalog/model-hub/curated-v2.json`, validated with the `HubManifest` schema from `@bike4mind/common` (this package's one workspace dependency). `curatedListing`, `curatedPicks` and `curatedBuildForRef` select from it the entries Desktop and the CLI offer (never abliterated ones, restricted licenses only when the list's policy labels them), this machine's tier picks, and the offered build behind a pull ref.

Live check against real runtimes (skipped unless the variables are set; set either runtime alone, `LOCAL_MODELS_LIVE_OPENAI_KEY` only for a server started with a key, `LOCAL_MODELS_LIVE_OLLAMA_MODELS` to pull something other than `qwen2.5:0.5b`, and `LOCAL_MODELS_LIVE_HF` to query the Hub, which with Ollama also pulls and removes a 105 MB SmolLM2 build): `LOCAL_MODELS_LIVE_OLLAMA=http://127.0.0.1:11434 LOCAL_MODELS_LIVE_OPENAI=http://127.0.0.1:8080 LOCAL_MODELS_LIVE_OPENAI_KEY=<key> LOCAL_MODELS_LIVE_HF=https://huggingface.co pnpm --filter @bike4mind/local-models test live`

GGUF live checks, in the same file pattern: `LOCAL_MODELS_LIVE_OLLAMA_STORE=<OLLAMA_MODELS dir>` compares each `LOCAL_MODELS_LIVE_OLLAMA_MODELS` blob with `inspect` and verbose `/api/show`; `LOCAL_MODELS_LIVE_GGUF_FILES=<a.gguf,b.gguf>` loads each file into Ollama and compares it with `inspect` (both need `LOCAL_MODELS_LIVE_OLLAMA`); `LOCAL_MODELS_LIVE_HF` (any non-empty value) reads Qwen2.5 (compared with a local copy listed in `LOCAL_MODELS_LIVE_GGUF_FILES`), Qwen3-30B-A3B, gpt-oss-20b and the split Qwen3-235B-A22B headers from Hugging Face, with `LOCAL_MODELS_LIVE_HF_TOKEN` optional: `pnpm --filter @bike4mind/local-models test gguf.live`

Live check of llama-server (skipped unless both are set; the GGUF file is copied into a temporary models directory, so a small one keeps it quick): `LOCAL_MODELS_LIVE_LLAMA_SERVER=<path to llama-server> LOCAL_MODELS_LIVE_LLAMA_SERVER_GGUF=<path to a .gguf file> pnpm --filter @bike4mind/local-models test llamaServer.live`
