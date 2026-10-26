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

Discovery omits unavailable hosts and returns authentication failures with `health.ok: false`; pass `{ url, apiKey }` in `hosts` to authenticate. Runtime operations reject with typed errors, and cancelling a pull rejects with the signal's abort reason (`AbortError` by default). Unmeasurable disk and GPU memory are `null`, and `confidence: 'low'` indicates the GPU may be unmeasured. Pass an existing model directory to `probeHardware({ modelDir })` to measure its free disk space.

Live check against real runtimes (skipped unless the variables are set; set either runtime alone, `LOCAL_MODELS_LIVE_OPENAI_KEY` only for a server started with a key, and `LOCAL_MODELS_LIVE_OLLAMA_MODELS` to pull something other than `qwen2.5:0.5b`): `LOCAL_MODELS_LIVE_OLLAMA=http://127.0.0.1:11434 LOCAL_MODELS_LIVE_OPENAI=http://127.0.0.1:8080 LOCAL_MODELS_LIVE_OPENAI_KEY=<key> pnpm --filter @bike4mind/local-models test live`
