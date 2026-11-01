---
title: Desktop Model Servers
description: Chat with models running on another machine from Bike4Mind Desktop, over Tailscale, an https proxy, an SSH tunnel, or your LAN
sidebar_position: 31
tags: [desktop, models, ollama, llama-server, self-hosted]
---

# Desktop Model Servers

Model servers let Bike4Mind Desktop chat with models that run on another machine, such as a GPU box at home or in a lab. You add the server once under Settings > Model servers, and its models appear in the model picker next to the ones on your own computer.

Desktop supports two kinds of server:

- Ollama.
- OpenAI-compatible servers such as llama-server, LM Studio and vLLM.

Each server has an Access setting. Chat only lets Desktop list and use the server's models for chat. Chat and manage also lets you download and remove models on an Ollama server from the Models screen. OpenAI-compatible servers only support listing and chat, with either access setting. Chat only is the default, and the setting applies to this device only.

## When to use this

Use a model server when the model is too large for your computer, or when several people or devices should share one machine's GPU. If the model runs on the same computer as Desktop, you do not need this: Desktop manages local runtimes itself.

## How Desktop protects your credentials

A server can need a bearer token or a custom header (for example `X-Api-Key`). Desktop applies these rules:

- The token or header value is encrypted with your operating system's secure storage and is never shown again after you save it.
- Credentials are sent only to the address you saved, never to any other host.
- Desktop does not follow redirects. A server that redirects, including `http` to `https`, shows an error and no credentials are sent on. Enter the final address instead.
- Credentials travel only over `https`, or over plain `http` to this computer (loopback) or a Tailscale IPv6 address (`fd7a:115c:a1e0::/48`).
- Plain `http` to a private network address (`192.168.x.x`, `10.x.x.x`, `172.16.x.x` to `172.31.x.x`, Tailscale IPv4 `100.64.0.0/10`, which covers `100.64.x.x` to `100.127.x.x`, and IPv6 unique local addresses in `fc00::/7`) works only without credentials. Desktop marks these servers Unencrypted.
- A public address needs `https` with a valid certificate. Plain `http` to a public address is refused. Link-local addresses (`169.254.x.x`, `fe80::/10`) count as public.
- A host name is judged by the addresses it resolves to, and the least trusted one decides. `localhost` counts as this computer.

If your computer has no secure storage available, Desktop keeps the credential only until you quit and marks the server Credentials kept until Desktop quits.

## Pick a setup

| Setup | Address you enter | Credentials |
|-------|-------------------|-------------|
| Tailscale with HTTPS | `https://gpu.tailnet-name.ts.net` | Optional |
| Caddy in front of Ollama | `https://ollama.example.com` | Bearer token |
| SSH local port forward | `http://127.0.0.1:21434` | None needed |
| Plain LAN | `http://192.168.1.20:11434` | None, shown as Unencrypted |

## Prepare the server

Ollama listens only on `127.0.0.1` by default. For the proxy and SSH setups below, leave it that way: the proxy or the SSH daemon is the only thing that needs to reach it. Set `OLLAMA_HOST` only when another machine must connect to Ollama directly, as in the LAN setup:

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

Never expose Ollama on a public address without a proxy that requires a token. Ollama has no authentication of its own, so anyone who finds the address can run your models and pull or delete them. Desktop warns you when a public address answers without credentials.

For llama-server, start it with `--host` and `--port` the same way, and `--api-key` if you want it to check a bearer token itself.

## Tailscale

Tailscale gives each machine a private address that only your tailnet can reach. Install Tailscale on both machines and sign in to the same tailnet.

Desktop trusts plain `http` with credentials only on the Tailscale IPv6 address. The IPv4 address in `100.64.0.0/10` counts as a private network address, so it works without credentials and is marked Unencrypted. To use a token or to avoid the Unencrypted mark, serve the model over HTTPS with Tailscale's own certificates:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:11434
```

Then add `https://<machine>.<tailnet>.ts.net` in Settings > Model servers. Check the Tailscale documentation for the current `serve` syntax and to enable HTTPS certificates for your tailnet.

Ollama rejects requests whose `Host` header is not a local name, and Tailscale's documentation does not say whether `serve` rewrites that header. Before you add the server, run `curl -i https://<machine>.<tailnet>.ts.net/api/version` from another machine on the tailnet. If it returns `403`, use the Caddy setup below on the same machine instead, or connect over the Tailscale IPv6 address without `serve`.

## Caddy with https and two bearer tokens

Use this when the server has a public name. Caddy gets a certificate for the name automatically. Point the DNS record for the name at the server and open ports 80 and 443.

Ollama has no per-user access control, so the Chat only setting is enforced only on your device: anyone who holds the credential can still pull and delete models by calling the server directly. To enforce it on the server, give the proxy two tokens and let only the second one reach the management paths:

| Token | Allowed paths | Use it for |
|-------|---------------|------------|
| Chat token | `/api/version`, `/api/tags`, `/api/show`, `/api/ps`, `/api/chat` | Servers set to Chat only |
| Manage token | The chat paths, plus `/api/pull` and `/api/delete` | Servers set to Chat and manage |

These are the Ollama paths Desktop calls on a saved server, and the CLI's `b4m models` commands use the same ones except `/api/chat`: `/api/version` and `/api/tags` for the connection test and the model list, `/api/show` for each model's context size and capabilities, `/api/ps` for the models loaded in memory, and `/api/chat` for replies. Downloads use `/api/pull` and removals use `/api/delete`.

Create a `Caddyfile`:

```text
{$SITE_ADDRESS} {
	@chat {
		header Authorization "Bearer {$CHAT_TOKEN}"
		path /api/version /api/tags /api/show /api/ps /api/chat
	}
	@manage {
		header Authorization "Bearer {$MANAGE_TOKEN}"
		path /api/version /api/tags /api/show /api/ps /api/chat /api/pull /api/delete
	}
	@chat_token header Authorization "Bearer {$CHAT_TOKEN}"
	@manage_token header Authorization "Bearer {$MANAGE_TOKEN}"

	handle @chat {
		reverse_proxy 127.0.0.1:11434 {
			header_up Host {upstream_hostport}
		}
	}
	handle @manage {
		reverse_proxy 127.0.0.1:11434 {
			header_up Host {upstream_hostport}
		}
	}
	handle @chat_token {
		respond "Forbidden" 403
	}
	handle @manage_token {
		respond "Forbidden" 403
	}
	handle {
		respond "Unauthorized" 401
	}
}
```

A request with no token or a wrong token gets `401`. A valid token on a path it may not use gets `403`. Every path that is not listed is refused for both tokens, including Ollama's account routes (`/api/me`, `/api/signout`), `/api/create`, `/api/copy`, `/api/push`, `/api/generate`, `/api/embed` and the `/v1/*` routes. Desktop does not call any of those on a saved Ollama server.

The `header_up` lines are required. Caddy passes the public name through as the `Host` header, and Ollama answers `403` to any `Host` that is not a local name.

Generate the tokens and run Caddy with all three values set:

```bash
export CHAT_TOKEN="$(openssl rand -hex 32)"
export MANAGE_TOKEN="$(openssl rand -hex 32)"
export SITE_ADDRESS=ollama.example.com
caddy run --config Caddyfile
```

Keep the tokens out of the Caddyfile itself so you do not commit them by accident. Share the chat token with everyone who should only chat, and keep the manage token for yourself.

### Stop cloud models

A path rule cannot stop Ollama's cloud models. Ollama picks them from the `model` field inside a chat request, so a chat token that is allowed on `/api/chat` can name a cloud model and use the cloud account signed in on the server. Start Ollama with cloud models turned off. This needs Ollama 0.16.2 or later; older versions ignore the variable without a warning.

```bash
OLLAMA_NO_CLOUD=1 ollama serve
```

If you run Ollama as a service, set the variable in the service's environment instead, then restart the service. On a shared server, do this even when you trust the people with the token. To check it, ask for a cloud model with the chat token. A model name that does not exist locally returns `404`, while a cloud model with cloud disabled returns `403`:

```bash
curl -i -H "Authorization: Bearer $CHAT_TOKEN" https://ollama.example.com/api/chat -d '{"model":"gpt-oss:120b-cloud","stream":false,"messages":[{"role":"user","content":"hi"}]}'
```

### Which token goes in Desktop

In Settings > Model servers, add `https://ollama.example.com`, set Credentials to Bearer token and paste one token:

- For Access set to Chat only, paste the chat token.
- For Access set to Chat and manage, paste the manage token.

The Access setting is enforced only on your device: Desktop and the CLI refuse downloads and removals on a Chat only server. The token is what the server enforces. If you set Chat and manage with the chat token, the controls appear and the proxy answers `403` when you use them.

### Which token the CLI uses

The CLI cannot read the credential Desktop stores, so give it its own copy. Use the same token as in Desktop for that server:

```bash
b4m models servers login gpu-box
```

The CLI keeps the token in its config file. See [Model commands](../cli/model-commands.md#use-the-model-servers-saved-in-desktop) for the details.

### Check the proxy

You can confirm the proxy before you add it:

```bash
curl -i https://ollama.example.com/api/version
curl -i -H "Authorization: Bearer " https://ollama.example.com/api/version
curl -i -H "Authorization: Bearer $CHAT_TOKEN" https://ollama.example.com/api/version
curl -i -H "Authorization: Bearer $CHAT_TOKEN" https://ollama.example.com/api/pull -d '{"model":"no-such-model"}'
curl -i -H "Authorization: Bearer $MANAGE_TOKEN" https://ollama.example.com/api/pull -d '{"model":"no-such-model"}'
```

The first and second calls return `401`. The third returns the Ollama version. The fourth returns `403`. The fifth reaches Ollama, which answers `200` with an `error` line in the body because the model does not exist, so nothing downloads.

### vLLM and other OpenAI-compatible servers

An OpenAI-compatible server has no pull or delete calls in Desktop, so one token is enough. Desktop uses `/v1/models` for the connection test and the model list, and `/v1/chat/completions` for replies. The CLI lists models from `/v1/models` and calls `/v1/chat/completions` only for `b4m models servers --check-tools`. The connection test also reads the server version from vLLM's `/version` or llama-server's `/props`, and Desktop reads a llama-server's context size from `/props`. If you leave them out of the proxy, the server still works, but that version or figure is blank. The `Host` header does not matter to vLLM, so no `header_up` line is needed:

```text
{$SITE_ADDRESS} {
	@chat {
		header Authorization "Bearer {$CHAT_TOKEN}"
		path /v1/models /v1/chat/completions /version /props
	}
	@chat_token header Authorization "Bearer {$CHAT_TOKEN}"

	handle @chat {
		reverse_proxy 127.0.0.1:8000
	}
	handle @chat_token {
		respond "Forbidden" 403
	}
	handle {
		respond "Unauthorized" 401
	}
}
```

Replace `8000` with the port your server listens on. Add the server in Desktop with Kind set to OpenAI-compatible and the chat token as the bearer token. To have vLLM check the token itself too, start it with `--api-key` set to the same value as the chat token, because Caddy forwards Desktop's `Authorization` header unchanged.

### Already self-hosting Bike4Mind?

If you run the [self-host stack](https://github.com/Bike4Mind/bike4mind/blob/main/SELF_HOST.md) with its bundled Caddy ([Path B](https://github.com/Bike4Mind/bike4mind/blob/main/SELF_HOST.md#path-b-public-domain-with-the-bundled-caddy-proxy), which covers setting up that proxy), you can serve the stack's bundled Ollama to Desktop through the same Caddy. That guide does not cover Ollama through the proxy, so the steps are here.

Use a separate host name for the models, such as `models.example.com`, with its own DNS record. Do not share the app's host name: the app serves its own `/api/chat`, so the model paths would collide. The stack's Caddy reaches the bundled `ollama` service by name on the compose network, so you start the `ollama` profile as well as the `proxy` profile.

The stack's `compose.caddy.yaml` passes only `B4M_DOMAIN` to Caddy, and the `ollama` service has no cloud setting, so this needs a small override file of your own. Save it as `compose.models.yaml` next to the other compose files:

```yaml
name: bike4mind-selfhost

services:
  caddy:
    env_file: ./.env.models
    environment:
      MODEL_DOMAIN: ${MODEL_DOMAIN:?set MODEL_DOMAIN in .env.selfhost}
  ollama:
    environment:
      OLLAMA_NO_CLOUD: '1'
```

Add `MODEL_DOMAIN=models.example.com` to `.env.selfhost`. Put the tokens in a separate `.env.models` file, so only the Caddy container receives them, and do not commit it:

```text
CHAT_TOKEN=<chat token>
MANAGE_TOKEN=<manage token>
```

Then paste the Caddy block from above at the end of `selfhost/caddy/Caddyfile`, as a second site block under `{$MODEL_DOMAIN} {`, with two changes: the upstream is `ollama:11434` and the Host line is `header_up Host localhost`. Bring the stack up with the override and both profiles:

```bash
docker compose -f compose.selfhost.yaml -f compose.caddy.yaml -f compose.models.yaml \
  --env-file .env.selfhost --profile proxy --profile ollama up -d
```

Both edits are changes to your copy of the stack, not settings: the Caddyfile is a tracked file, and the override adds the environment the stock files do not pass.

The tailnet setup (Path A) has no equivalent. The tailnet sidecar publishes only the app and the realtime gateway. Tailscale Serve routes by path but cannot check a token per path, so Chat only and Chat and manage would not be enforced on the server. Publishing Ollama through it would need a new entry in `selfhost/tailscale/serve.json` for `http://ollama:11434`, and it would let every tailnet member pull and delete models. Use Path B for the two-token setup.

## SSH local port forward

If you can already SSH to the server, forward its Ollama port to your computer. Desktop then sees a loopback address, which it trusts without `https`, and SSH encrypts the traffic.

```bash
ssh -N -L 21434:127.0.0.1:11434 user@gpu.example.com
```

Use a local port other than `11434`. Desktop's This computer entry always uses `127.0.0.1:11434`, so a tunnel on that port would clash with a local Ollama or make This computer talk to the remote machine.

Add `http://127.0.0.1:21434` in Settings > Model servers. The server shows Unreachable whenever the SSH session is closed, so keep it running, or use a tool such as `autossh` to restart it.

## Plain LAN without credentials

On a trusted home or office network you can connect directly:

1. On the server, run Ollama with `OLLAMA_HOST=0.0.0.0:11434`.
2. In Desktop, add `http://192.168.1.20:11434` with Credentials set to None.

Desktop marks the server Unencrypted. Anyone on that network can read your conversations and the replies. Use this only on a network you trust, and do not use it on shared or public Wi-Fi. If you need a token, use one of the setups above.

## Add a server in Desktop

1. Open Settings > Model servers.
2. Under Add a server, enter the address. A bare `host:port` is treated as `http`.
3. Set Credentials to None, Bearer token or Custom header, and fill in the token, or the header name and value.
4. Select Test. Desktop reports the kind, version, model count and latency, or the reason it could not connect.
5. After a successful Test, Desktop shows the Name, Kind and Access fields. Kind (Ollama or OpenAI-compatible) is filled in from the Test result. Check the fields, set Access (Chat only or Chat and manage), then select Save server.

The address must not include a username, password, query string or fragment. If the server sits behind a proxy path, include the path.

If Test warns that a public address answered without credentials, put a proxy with a token in front of it. Saving anyway requires you to tick Save it anyway.

## Manage models on an Ollama server

1. In Settings > Model servers, set the Ollama server's Access to Chat and manage.
2. Open Models and select the server in the server switcher. This computer manages models on your own computer instead.
3. Use Explore to choose a model and build, then select Download and confirm the destination. The download uses the server's saved connection and credentials, and stores the model on that server.
4. Use Installed to see the server's models or remove one. Removing a model affects other users of that server too.

Desktop cannot see how much free disk space a remote server has. Check the server's storage before downloading a large model.

If a download connection drops or stops reporting progress, the download pauses. Restore the connection and select Resume to reuse partial data still kept by Ollama. If Ollama restarts after a download has been paused for more than an hour, it starts over. Desktop keeps your computer awake while a server download runs, but releases that request when it pauses or finishes.

Removing a saved server or changing its Access to Chat only stops its downloads in Desktop and closes open download and removal dialogs. It does not remove models already stored on the server.

## Rate models for a server's hardware

Desktop cannot measure a remote server's memory, so by default the Models screen shows no fit badges for a saved server and its Curated picks are not chosen for it. To rate models for the server, enter its hardware:

1. In Settings > Model servers, select Hardware on the server.
2. Enter its RAM and, if it has one, its GPU memory, in GB as the hardware is sold. Tick The GPU shares this RAM for a machine with unified memory, such as an Apple silicon Mac. For a machine whose GPU can use only part of that memory, enter that part as GPU memory.
3. Select Save hardware.

The Curated tab then picks models for that server and shows fit badges for it, as it does for your own computer. Explore and the download dialog use the same figures. RAM is required; without it the server stays unrated.

This computer has the same Hardware fields. Desktop detects this computer's hardware itself and shows what it found next to the fields. Fill in only what it got wrong: an entered figure replaces the detected one for fit badges, Curated picks and the context size local chat uses. Select Use detected hardware to go back.

You can also enter memory bandwidth in GB/s. Desktop saves it, but it does not change ratings yet.

## Troubleshooting

- Download or Remove is missing: select an Ollama server with Access set to Chat and manage. Chat only and OpenAI-compatible servers do not offer these controls.
- A download is paused: check the server and connection, then select Resume. If it pauses again behind a proxy, check whether the proxy allows long-running streaming responses.

- Needs credentials: the server returned 401, or Desktop no longer has the saved credential. Check the token, or the header name and value. If the message says the saved credential could not be read, the secure storage lost it, for example after a keyring reset. If it says the credential was kept only until Desktop quit, it was session-only and Desktop restarted. In both cases open the server's credentials and enter the value again.
- Refused with a correct token, behind a proxy: the proxy or Ollama answered 403. Ollama does this when the `Host` header was not rewritten, and the Caddy setup above returns it for a path your token may not use. Check the Caddy setup, and test with `curl -i` against the address.
- Unreachable: the address, port or firewall is wrong, or the SSH forward is closed.
- Unreachable on macOS, for a server on your local network: macOS asks the first time an app connects to a LAN address and blocks it if you decline. Open System Settings > Privacy & Security > Local Network, turn on Bike4Mind, then select Check now on the server. This applies to macOS 15 and later. Servers reached over the internet or on this computer are not affected.
- Refused: the server redirected, a proxy answered 403, its certificate is not trusted, or the address is not allowed. Read the message under Test. If you were redirected to another address, enter the final `https` address. If the redirect stayed on the same address, check the path you entered.
- The certificate is not trusted: Test shows this message, and the server shows Refused, when the certificate fails verification. Use a certificate from a trusted authority or a local CA your computer already trusts. Tailscale certificates also work.
