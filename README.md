<div align="center">

# Bike4Mind

**Your bicycle for the mind in the age of AI.**

An open-core AI knowledge platform — a multi-model workspace where notebooks, autonomous agents, and a RAG knowledge engine work together to augment any cognitive task.

[![Chat on Bike4Mind](https://img.shields.io/badge/chat-Bike4Mind-6d28d9)](https://app.bike4mind.com) &nbsp;
[![License: BUSL-1.1](https://img.shields.io/badge/license-BUSL--1.1-blue)](./LICENSE) &nbsp;
[![Discussions](https://img.shields.io/badge/community-Discussions-24292f)](https://github.com/bike4mind/bike4mind/discussions)

</div>

---

## What is Bike4Mind?

Bike4Mind is an AI-powered knowledge platform that wires a superset of AI technologies together behind one workspace. Bring your own models, keep your data, and let agents do the heavy lifting.

- **Notebooks** — the core workspace: chat, documents, and context in one place, across any model.
- **Multi-LLM by design** — swap freely between **Anthropic, OpenAI, Google Gemini, xAI, Ollama** (local), and more, plus image models (FLUX, DALL·E 3, Stable Diffusion).
- **Quest Master** — autonomous, multi-step task planning: text and image generation, vision review, web search, math, code, and human-in-the-loop steps, run in parallel.
- **AI Agents** — autonomous ReAct-style agents that carry out complex tasks against your tools and knowledge.
- **Knowledge Engine** — RAG over your documents: smart chunking, vector search, collections, and tagging so agents can reason about what you know.
- **Artifacts** — reusable snippets, documents, and visualizations produced by agents, with a built-in publish-and-share layer.

Try the hosted service at **[app.bike4mind.com](https://app.bike4mind.com)**, or self-host the open core on your own infrastructure (below).

## Open core

Bike4Mind is **open core**. The engine is public and self-hostable; the multi-tenant hosted service is our business.

- **Open** (this repo, BUSL-1.1): the agent engine, LLM adapters, CLI, data models, and the self-host path — published as `@bike4mind/*` packages.
- **Commercial / closed**: operating the multi-tenant hosted service — billing, entitlements, hosted infrastructure — and premium overlays such as Overwatch.

See [CONTRIBUTING.md](./CONTRIBUTING.md#the-openclosed-boundary) for the exact open/closed boundary.

## Quickstart

**Hosted (fastest):** sign in at **[app.bike4mind.com](https://app.bike4mind.com)** — nothing to install.

**Self-host:** run the open core on your own hardware with Docker — no AWS account or cloud provider required. See the **[Self-Host Quickstart](./SELF_HOST.md)**. In short:

```bash
# 1. Copy the env template, then generate JWT_SECRET / SESSION_SECRET /
#    SECRET_ENCRYPTION_KEY (see SELF_HOST.md) and add your model keys
cp .env.selfhost.example .env.selfhost

# 2. Bring up the stack (app + MongoDB + object storage + queues + mail catcher)
docker compose -f compose.selfhost.yaml --env-file .env.selfhost up -d
```

Bike4Mind then runs at `http://localhost:3000`; sign-in code emails land in the bundled Mailpit at `http://localhost:8025`. The self-host image is published to `ghcr.io/bike4mind/bike4mind-selfhost`.

## Develop

Bike4Mind is a pnpm + Turborepo monorepo (Node 24).

```bash
pnpm i -r              # install
pnpm turbo:core:build  # build the @bike4mind/* core packages
pnpm turbo:typecheck   # type check
pnpm turbo:test        # run tests
```

Project layout: `apps/client` (Next.js SPA + pages API backend), `packages/cli` (interactive CLI + ReAct agent), `b4m-core/*` (the `@bike4mind/*` engine packages), `packages/database` (Mongoose models + migrations). Realtime WebSocket fanout ships as a separate `@bike4mind/subscriber-fanout` image. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide.

## Contributing

Contributions are welcome — fork → topic branch → PR → squash-merge. All contributors sign a lightweight CLA on their first PR (you keep your copyright). Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and our [Code of Conduct](./CODE_OF_CONDUCT.md). Questions and self-hosting help go in [Discussions](https://github.com/bike4mind/bike4mind/discussions).

## Security

Please report vulnerabilities privately — see [SECURITY.md](./SECURITY.md). Do not open public issues for security problems.

## License

Bike4Mind is licensed under the **[Business Source License 1.1](./LICENSE)** with a broad Additional Use Grant:

- ✅ You **may** read, modify, redistribute, and make production use of the code — including self-hosting it for your organization's own internal use, and building or commercializing your own products on top of it.
- ❌ You **may not** offer the software to third parties as a competing hosted/managed service (a "Bike4Mind Service", as defined in the LICENSE).
- 🕓 Each released version **converts to Apache-2.0** two years after its public release. This license will never be tightened.

For alternative licensing, contact **licensing@bike4mind.com**.

## Star History

<a href="https://www.star-history.com/?repos=bike4mind%2Fbike4mind&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=bike4mind/bike4mind&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=bike4mind/bike4mind&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=bike4mind/bike4mind&type=date&legend=top-left" />
 </picture>
</a>

© 2026 Bike4Mind, Inc.
