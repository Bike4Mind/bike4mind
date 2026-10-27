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

Discovery omits unavailable hosts and returns authentication failures with `health.ok: false` (on a default port, only when the 401/403 carries an OpenAI/Ollama-style JSON `error` or a FastAPI string `detail`; bare status codes and HTML responses are ignored); pass `{ url, apiKey }` in `hosts` to authenticate. Runtime operations reject with typed errors, and cancelling a pull rejects with the signal's abort reason (`AbortError` by default). `idleTimeoutMs` must be positive and defaults to five minutes; `Infinity` disables the pull watchdog. Invalid values reject before sending a request. Unmeasurable disk and GPU memory are `null`. GPUs come from `nvidia-smi`, then Linux sysfs (amdgpu, checked against its KFD gfx target, and xe report VRAM) or the Windows video controllers and their driver keys; integrated GPUs, which Ollama skips by default, are not counted, so `memoryKind: 'cpu'` with `confidence: 'high'` means no usable GPU. VRAM is summed within one vendor only. `confidence: 'low'` means a usable GPU's memory is unknown or the GPUs could not be listed or opened (WSL, sandboxes without sysfs, containers without the GPU's device node). Pass an existing model directory to `probeHardware({ modelDir })` to measure its free disk space.

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

`isAbliteratedModel(model)` flags a search hit or detail whose repo id, tags or base models mark it as abliterated, decensored, uncensored or heretic (whole words except `abliterat`); callers hide these by default and never recommend them.

Live check against real runtimes (skipped unless the variables are set; set either runtime alone, `LOCAL_MODELS_LIVE_OPENAI_KEY` only for a server started with a key, `LOCAL_MODELS_LIVE_OLLAMA_MODELS` to pull something other than `qwen2.5:0.5b`, and `LOCAL_MODELS_LIVE_HF` to query the Hub, which with Ollama also pulls and removes a 105 MB SmolLM2 build): `LOCAL_MODELS_LIVE_OLLAMA=http://127.0.0.1:11434 LOCAL_MODELS_LIVE_OPENAI=http://127.0.0.1:8080 LOCAL_MODELS_LIVE_OPENAI_KEY=<key> LOCAL_MODELS_LIVE_HF=https://huggingface.co pnpm --filter @bike4mind/local-models test live`
