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

Discovery omits unavailable hosts and returns authentication failures with `health.ok: false` (on a default port, only when the 401/403 carries an OpenAI/Ollama-style JSON `error` body, so a secured non-LLM service there is not reported); pass `{ url, apiKey }` in `hosts` to authenticate. Runtime operations reject with typed errors, and cancelling a pull rejects with the signal's abort reason (`AbortError` by default). Unmeasurable disk and GPU memory are `null`, and `confidence: 'low'` indicates the GPU may be unmeasured. Pass an existing model directory to `probeHardware({ modelDir })` to measure its free disk space.

To size a model before it is installed, read its GGUF header from a local file or a URL. Only the header is fetched (Range requests, growing in size), so a 20 GB Hugging Face file costs a few MB:

```ts
import { inspectGguf, readGgufMetadata } from '@bike4mind/local-models';

const url = 'https://huggingface.co/unsloth/Qwen3-30B-A3B-GGUF/resolve/main/Qwen3-30B-A3B-Q4_K_M.gguf';
const { arch, tensorStats } = await inspectGguf(url, { authorization: `Bearer ${hfToken}` });
const { metadata, tensors } = await readGgufMetadata('/models/model.gguf');
```

`inspectGguf` returns the same `{ arch, tensorStats }` as `OllamaRuntime.inspect`. Arrays longer than 1024 entries (the tokenizer vocabulary and merges) come back as `{ omitted: true, itemType, length }`. For a split GGUF, it reads the tensor infos of every shard, which a URL or path named `*-00001-of-0000N.gguf` finds by itself (or pass `shards`), so MoE expert sizes cover the whole model. `authorization` is never sent to another origin, such as the CDN Hugging Face redirects to. A malformed, truncated, big-endian or v1 header rejects with `GgufFormatError`.

Live check against real runtimes (skipped unless the variables are set; set either runtime alone, `LOCAL_MODELS_LIVE_OPENAI_KEY` only for a server started with a key, and `LOCAL_MODELS_LIVE_OLLAMA_MODELS` to pull something other than `qwen2.5:0.5b`): `LOCAL_MODELS_LIVE_OLLAMA=http://127.0.0.1:11434 LOCAL_MODELS_LIVE_OPENAI=http://127.0.0.1:8080 LOCAL_MODELS_LIVE_OPENAI_KEY=<key> pnpm --filter @bike4mind/local-models test live`

GGUF live checks, in the same file pattern: `LOCAL_MODELS_LIVE_OLLAMA_STORE=<OLLAMA_MODELS dir>` compares each `LOCAL_MODELS_LIVE_OLLAMA_MODELS` blob with `inspect` and verbose `/api/show`; `LOCAL_MODELS_LIVE_GGUF_FILES=<a.gguf,b.gguf>` loads each file into Ollama and compares it with `inspect` (both need `LOCAL_MODELS_LIVE_OLLAMA`); `LOCAL_MODELS_LIVE_HF=1` reads Qwen2.5 (compared with a local copy listed in `LOCAL_MODELS_LIVE_GGUF_FILES`), Qwen3-30B-A3B, gpt-oss-20b and the split Qwen3-235B-A22B headers from Hugging Face, with `LOCAL_MODELS_LIVE_HF_TOKEN` optional: `pnpm --filter @bike4mind/local-models test gguf.live`
