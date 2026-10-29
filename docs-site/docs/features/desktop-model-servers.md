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

## Caddy with https and a bearer token

Use this when the server has a public name and you want a token in front of Ollama. Caddy gets a certificate for the name automatically. Point the DNS record for the name at the server and open ports 80 and 443.

Create a `Caddyfile`:

```text
{$SITE_ADDRESS} {
	@unauthorized not header Authorization "Bearer {$OLLAMA_TOKEN}"
	respond @unauthorized "Unauthorized" 401
	reverse_proxy 127.0.0.1:11434 {
		header_up Host {upstream_hostport}
	}
}
```

The `header_up` line is required. Caddy passes the public name through as the `Host` header, and Ollama answers `403` to any `Host` that is not a local name.

Generate a token and run Caddy with both values set:

```bash
export OLLAMA_TOKEN="$(openssl rand -hex 32)"
export SITE_ADDRESS=ollama.example.com
caddy run --config Caddyfile
```

Keep the token out of the Caddyfile itself so you do not commit it by accident. In Desktop, add `https://ollama.example.com` with Credentials set to Bearer token and paste the token.

You can confirm the proxy before you add it:

```bash
curl -i https://ollama.example.com/api/version
curl -i -H "Authorization: Bearer $OLLAMA_TOKEN" https://ollama.example.com/api/version
```

The first call returns `401`. The second returns the Ollama version.

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

## Troubleshooting

- Download or Remove is missing: select an Ollama server with Access set to Chat and manage. Chat only and OpenAI-compatible servers do not offer these controls.
- A download is paused: check the server and connection, then select Resume. If it pauses again behind a proxy, check whether the proxy allows long-running streaming responses.

- Needs credentials: the server returned 401 or 403, or Desktop no longer has the saved credential. Check the token, or the header name and value. If the message says the saved credential could not be read, the secure storage lost it, for example after a keyring reset. If it says the credential was kept only until Desktop quit, it was session-only and Desktop restarted. In both cases open the server's credentials and enter the value again.
- Needs credentials with a correct token, behind a proxy: Ollama may be answering 403 because the `Host` header was not rewritten. Check the Caddy setup above, and test with `curl -i` against the address.
- Unreachable: the address, port or firewall is wrong, or the SSH forward is closed.
- Refused: the server redirected, its certificate is not trusted, or the address is not allowed. Read the message under Test. If you were redirected to another address, enter the final `https` address. If the redirect stayed on the same address, check the path you entered.
- The certificate is not trusted: Test shows this message, and the server shows Refused, when the certificate fails verification. Use a certificate from a trusted authority or a local CA your computer already trusts. Tailscale certificates also work.
