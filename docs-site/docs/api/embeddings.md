---
title: Embeddings
description: Discover embedding models and create vectors through an OpenAI-compatible API.
sidebar_position: 6
---

# Embeddings

You create text vectors with `POST /api/v1/embeddings` and discover the available models with
`GET /api/v1/embedding-models`. Authenticate with an API key carrying `ai:generate`, or a JWT.
Use your deployment's base URL; the hosted URL is `https://app.bike4mind.com/api/v1`.

## Discover models

```bash
curl https://app.bike4mind.com/api/v1/embedding-models \
  -H 'Authorization: Bearer <your-api-key>'
```

The `models` array lists the models registered for your resolved provider credentials. Each entry
contains `id`, `display_name`, `provider`, `dimensions`, `max_input_tokens`, `supports_input_type`,
and `pricing.usd_per_million_input_tokens`. A model with no published credit rate is left out, since
the embeddings endpoint refuses it. The list is returned whole, without pagination.

Dimensions have one of three forms:

| Kind       | Accepted widths                         |
| ---------- | --------------------------------------- |
| `fixed`    | The `native` width                      |
| `range`    | Any integer from `min` through `native` |
| `discrete` | A width in `values`                     |

You must use matching models, widths and task hints when writing and searching your own vector index.
Changing the model does not convert existing vectors into the new vector space.

## Create vectors

```bash
curl https://app.bike4mind.com/api/v1/embeddings \
  -H 'Authorization: Bearer <your-api-key>' \
  -H 'Content-Type: application/json' \
  -d '{"model":"text-embedding-3-small","input":["A quiet cycling route"],"dimensions":512}'
```

The response follows the OpenAI embeddings shape: `object: "list"`, one entry in `data` per input,
`model`, and `usage.prompt_tokens` / `usage.total_tokens`. Each entry has `object: "embedding"`,
its input `index`, and an `embedding` array. Billing reserves credits before the provider call,
refunds on provider failure and settles using provider-reported input tokens when available.
For providers without a local tokenizer, the reservation includes an estimation margin.

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="<your-api-key>",
    base_url="https://app.bike4mind.com/api/v1",
)
result = client.embeddings.create(
    model="text-embedding-3-small",
    input=["A quiet cycling route"],
    dimensions=512,
    encoding_format="float",
)
vector = result.data[0].embedding
```

Send strings, rather than arrays of token IDs. If you use LangChain's Python `OpenAIEmbeddings`,
set `check_embedding_ctx_length=False` so it sends strings.

### Task hints

Set optional `input_type` to `document` while indexing or `query` while searching. Voyage models,
Gemini and Cohere map the hint to their provider's retrieval task. Models without task hints ignore
it. Omit the field to preserve the provider's default behavior. In the OpenAI SDK, use
`extra_body={"input_type": "query"}`.

### Dimensions and base64

Omit `dimensions` for the native width. OpenAI `text-embedding-3-*` accepts every positive integer
up to its native width. Other models follow the dimensions reported by the model list.
Set `encoding_format` to `base64` for the little-endian float32 bytes of each vector, encoded as a
base64 string; the default is `float`.

## Providers

OpenAI and Voyage use configured provider keys. Gemini uses the deployment's existing Gemini key.
Ollama runs on a self-hosted deployment's configured local server. Amazon Bedrock uses the executing
role's AWS credentials. Provider registration and credentials determine which entries you see.
Cohere Embed v4 is registered only when the operator configures `BEDROCK_COHERE_EMBED_MODEL_ID`
with an accessible Bedrock model or inference-profile ID. Set it in the deployment environment
before deploying, or in `.env.selfhost` for self-hosting. Its public model ID remains
`cohere.embed-v4:0`. Its text rate is $0.12 per million input tokens, as published in
[AWS's Bedrock pricing data](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json).

## Limits and errors

Each input must fit the selected model's `max_input_tokens`. A request accepts at most 2,048 strings,
300,000 input tokens in total, and 196,608 output values (`input count * dimensions`). For example,
1,536 dimensions permits at most 128 inputs. Split larger jobs into several requests.

Errors use the shared Bike4Mind error envelope with an `error` message, rather than OpenAI's error
body. See [Error Handling](./errors.md).

| Status | Meaning                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------- |
| `401`  | Invalid API credentials, or `provider_rejected` for a refused provider credential                  |
| `403`  | Your API key lacks the required scope                                                              |
| `422`  | Invalid input/model/dimensions, a limit was exceeded, no published rate, or `insufficient_credits` |
| `429`  | Rate limit exceeded                                                                                |
| `502`  | Provider request failed; reserved credits are refunded                                             |
| `503`  | `provider_not_configured`: the requested provider is unavailable                                   |
