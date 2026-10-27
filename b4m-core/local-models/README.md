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

`inspectGguf` returns the same `{ arch, tensorStats }` as `OllamaRuntime.inspect`. Arrays longer than 1024 entries (the tokenizer vocabulary and merges) come back as `{ omitted: true, itemType, length }`. For a split GGUF, it reads the tensor infos of every shard, which a URL or path named `*-00001-of-0000N.gguf` finds by itself (or pass `shards`), so MoE expert sizes cover the whole model. `authorization` is never sent to another origin, such as the CDN Hugging Face redirects to. A malformed, truncated, big-endian or v1 header rejects with `GgufFormatError`.

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

`LlamaServerRuntime` manages llama.cpp's `llama-server` over a directory of GGUF files the caller owns. It is a `LocalRuntime` with id and kind `llama-server`; its `baseUrl` is the models directory as a `file:` URL, since each server listens on its own port. `findLlamaServer({ path })` checks a configured or bundled binary (or, without `path`, the first qualifying `llama-server` on PATH) by running `--version`, and requires build `MIN_LLAMA_SERVER_BUILD` (b5501, the first with `--offline`) or newer; an older or unnumbered build throws `LlamaServerVersionError`, and `health()` reports the same without throwing. Nothing downloads a binary or a model on its own.

`store` lists, adds, removes and downloads GGUF files, and lists or discards partial downloads (`partials()`, `discardPartial(name)`; `remove(name)` also deletes a name that has only a partial download). A model's name is its path under the models directory with `/` separators: `add(path)` copies a file (with its sibling shards, or `ModelIncompleteError` naming the missing ones) to the top level, and downloads land under `<owner>/<repo>/<path in repo>`, so files of the same name from different repos never collide. Each path segment may hold only letters, digits, space and `._+-()[]` (`InvalidModelNameError` otherwise), and `list()` skips files whose names break that. Capabilities come from the chat template in the GGUF header: `tools` is false only when the template is readable and never mentions tools, and `thinking` is true when it uses `<think>` or `enable_thinking`.

Every write holds `<file>.lock`, so a second download, copy or removal of the same file, in this process or another, fails with `ModelFileBusyError`. The holder refreshes the lock every 10 seconds; a lock not refreshed for 30 seconds, or last refreshed before the machine booted, is taken over, and a writer whose lock was taken over stops before its next write. `remove` and `discardPartial` take `{ force: true }` to override a live lock. File errors reject with `RuntimeStorageError`, whose `code` is the errno code and `operation` says whether a read or a write failed. `store.download(hub, { repo, revision, files })` fetches a Hugging Face build from its pinned resolve URLs, resumes a `.partial` file with a Range request after re-hashing the bytes it keeps (progress status `resuming`), checks the size on disk and the sha256 before renaming it into place, records the repo, revision and sha256 in `<file>.source.json` (the model's `source`), and keeps the token off the CDN; a file with no published sha256 starts over instead of resuming. A file already present is kept only when its sha256 matches, from the sidecar or by hashing it (status `verifying`); otherwise the download throws `ModelFileConflictError`. `pull('hf.co/<repo>:<quant>')` downloads the build whose quant label matches, ignoring case (`Q4_K_M` when the ref names none), and `list()` shows only complete, non-projector models.

`start(model)` runs one server per model on `127.0.0.1` with `--port 0 --offline --no-webui --jinja` and a fresh API key passed in the environment (not argv). It takes the port from the server's own listening line, so nothing else answering on a port is mistaken for it, then waits for `/health`, requires `/props` to refuse a request without the key (`LlamaServerStartError` with reason `unauthenticated` otherwise, for instance behind a launcher in `binaryArgs` that drops the environment), and checks that `/v1/models` serves the model with the key. The context is `DEFAULT_LLAMA_SERVER_CONTEXT_SIZE` (16384) when `contextSize` is not set; callers such as Desktop pass one sized to the hardware. `extraArgs` accepts only the flags in `LLAMA_SERVER_TUNING_FLAGS`, each value as its own argument. The returned process exposes `baseUrl`, `apiKey` and `model` for chat; `exited` and `onExit` report a crash, and `stop()` sends SIGTERM, then SIGKILL, to the server's process group (its process tree on Windows). Concurrent `start(model)` calls share one server: each caller's `signal` rejects only that call, the start is cancelled once every waiting caller has aborted, each caller's `onExit` is called, and the first caller's tuning applies. `stop(model)` on a server that is still loading cancels it, and its `start` rejects; `running()` and `loaded()` list only servers that are ready. A process that exits before it is ready rejects with `LlamaServerExitError` (`portInUse` for a fixed `port` that was taken); one that prints nothing for `startTimeoutMs` (default 120 seconds; loading output resets it) rejects with `LlamaServerStartError` reason `timeout`; a batch-file `binaryPath` with `LlamaServerBinaryError`; a failed hash check with `DownloadVerificationError`.

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
const server = await llama.start(model.name, { contextSize: 8192, extraArgs: ['--flash-attn', 'on'] });
// POST `${server.baseUrl}/v1/chat/completions` with `Authorization: Bearer ${server.apiKey}` and `model: server.model`
await llama.stopAll();
```

`isAbliteratedModel(model)` flags a search hit or detail whose repo id, tags or base models mark it as abliterated, decensored, uncensored or heretic (whole words except `abliterat`); callers hide these by default and never recommend them.

Live check against real runtimes (skipped unless the variables are set; set either runtime alone, `LOCAL_MODELS_LIVE_OPENAI_KEY` only for a server started with a key, `LOCAL_MODELS_LIVE_OLLAMA_MODELS` to pull something other than `qwen2.5:0.5b`, and `LOCAL_MODELS_LIVE_HF` to query the Hub, which with Ollama also pulls and removes a 105 MB SmolLM2 build): `LOCAL_MODELS_LIVE_OLLAMA=http://127.0.0.1:11434 LOCAL_MODELS_LIVE_OPENAI=http://127.0.0.1:8080 LOCAL_MODELS_LIVE_OPENAI_KEY=<key> LOCAL_MODELS_LIVE_HF=https://huggingface.co pnpm --filter @bike4mind/local-models test live`

GGUF live checks, in the same file pattern: `LOCAL_MODELS_LIVE_OLLAMA_STORE=<OLLAMA_MODELS dir>` compares each `LOCAL_MODELS_LIVE_OLLAMA_MODELS` blob with `inspect` and verbose `/api/show`; `LOCAL_MODELS_LIVE_GGUF_FILES=<a.gguf,b.gguf>` loads each file into Ollama and compares it with `inspect` (both need `LOCAL_MODELS_LIVE_OLLAMA`); `LOCAL_MODELS_LIVE_HF` (any non-empty value) reads Qwen2.5 (compared with a local copy listed in `LOCAL_MODELS_LIVE_GGUF_FILES`), Qwen3-30B-A3B, gpt-oss-20b and the split Qwen3-235B-A22B headers from Hugging Face, with `LOCAL_MODELS_LIVE_HF_TOKEN` optional: `pnpm --filter @bike4mind/local-models test gguf.live`

Live check of llama-server (skipped unless both are set; the GGUF file is copied into a temporary models directory, so a small one keeps it quick): `LOCAL_MODELS_LIVE_LLAMA_SERVER=<path to llama-server> LOCAL_MODELS_LIVE_LLAMA_SERVER_GGUF=<path to a .gguf file> pnpm --filter @bike4mind/local-models test llamaServer.live`
