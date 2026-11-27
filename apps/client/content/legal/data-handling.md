---
title: Bike4Mind API Data Handling and Sub-processors
type: data-handling
version: 1.0.0
lastUpdated: '2026-11-13'
status: Draft - not yet in force (see README)
---

# Bike4Mind API Data Handling and Sub-processors

Last updated: 2026-11-13

_This statement describes what Bike4Mind does with the data you send through the Bike4Mind API: the completions API (`/api/ai/v1/completions`), the embeddings API (`/api/v1/embeddings`) and the image generation API (`/api/v1/image-generations`). It supplements the [Terms of Service](./terms-of-service.md), the [Usage Policy](./usage-policy.md) and the Privacy Policy, which govern if they conflict with it. You may cite it in your own privacy notices and data processing agreements._

> **Not legal advice.** Written in-house and maintained alongside the code that implements it (see the legal folder README).

## 1. Training

We do not train models on the inputs or outputs of requests sent through our API (Terms of Service, section 5). Each AI provider listed in section 7 handles the data it processes under its own terms.

## 2. What each endpoint stores

### 2.1 Completions (`/api/ai/v1/completions`)

We do not save the text of your prompts, messages, tool definitions, tool results or the model's responses. Each request is passed to the model provider and the response is streamed back to you. We record only metadata:

- **Usage record:** request id, your user id, the account or organization billed, the API key id, the model and provider, input, output and cache token counts, the prices applied, cost and credits charged, status and latency.
- **Credit ledger entry:** the credits charged, model, token counts, API key id and name, request id, and the names of tools the model called.
- **Analytics events:** model, token counts, duration, API key id, credits used and request id. For a failed request, an error code, HTTP status and error class only, never the error message.
- **API key request log:** written for every request made with an API key: the key id, your user id, the client IP address, endpoint, HTTP method, response status, response time and timestamp.

### 2.2 Embeddings (`/api/v1/embeddings`)

We do not save the input text or the returned vectors. We record a usage record (model, provider, token count, cost, credits charged, status and latency), a credit ledger entry and the API key request log described in 2.1.

### 2.3 Image generation (`/api/v1/image-generations`)

Unlike completions and embeddings, image generation saves content to your account. The prompt, any rewritten prompt, and the generated images are stored in a notebook in your account, the same way images you generate in the web app are. Unless you ask for a literal prompt (`prompt_resolution: "literal"`), your prompt and recent turns of that notebook may be sent to a language model to resolve follow-up requests before the image model is called. Generated images are checked by an automated image moderation service, stored in our cloud file storage and served through our content delivery network. Usage records, credit ledger entries and the API key request log are written as in 2.1.

## 3. How long we keep it

| Record                                    | Kept for                                     |
| ----------------------------------------- | -------------------------------------------- |
| API key request log (includes IP address) | 90 days, then deleted automatically          |
| Usage records, analytics events           | For the life of the account; see section 4   |
| Credit ledger entries                     | Kept as financial records; see section 4     |
| Image generation prompts and images       | Until you delete them or delete your account |
| Application logs                          | See section 5                                |
| Database backups                          | See the Privacy Policy                       |

## 4. Account deletion

When your account deletion completes (after the grace period described in the Privacy Policy):

- Your usage records are deleted. Usage records that belong to an organization that continues to exist keep their quantities, prices and the organization's ownership, but your user id, request id, session, data lake and API key identifiers are removed or replaced.
- Your analytics events are deleted.
- Notebooks, images and other content in your personal workspace, including image generation output, are deleted.
- Credit ledger entries are kept as financial records for accounting and tax obligations, for up to 10 years from the end of the financial year they belong to.
- API key request log entries are not deleted early; they expire within 90 days of the request.

Deleted data can remain in encrypted database backups for the period stated in the Privacy Policy.

## 5. Logs

Our application logger redacts content before it is written: prompts, messages, conversation history, content and text fields, tool arguments and results, request and response bodies and headers, credentials and tokens, and personal name fields are replaced with a placeholder, recognisable secrets (bearer tokens, API keys, signed URL parameters) are scrubbed from every string, and email addresses are reduced to their domain. Errors from model and cloud providers are logged with their status and error code, not the request or response payload.

Log retention in production:

| Log                                                       | Retention |
| --------------------------------------------------------- | --------- |
| Chat completion service (serves `/api/ai/v1/completions`) | 1 month   |
| Web server (serves the other API endpoints)               | 1 week    |
| Other production functions, unless set otherwise          | 1 month   |

## 6. No model fallback

The completions API calls the model named in your request. If that model fails or is unavailable, the request returns an error; it is not retried on a different model or provider.

## 7. Sub-processors

A request is processed only by the providers needed to serve it: the provider of the model you call, our hosting providers and, for image generation, the provider of the language model that resolves prompts (by default an OpenAI model; it is a platform setting and can be any model from a provider listed in 7.1). Each AI provider applies its own retention policy to the data it receives. Where the Region column says "Set by the provider", our code does not select a processing region and the provider decides where requests are processed.

### 7.1 AI model providers

| Sub-processor                 | Purpose                                                                         | Region                                                                                                                                                                                                                                                                                                                                                                 | Provider retention                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anthropic                     | Claude models (completions)                                                     | Set by the provider                                                                                                                                                                                                                                                                                                                                                    | Governed by the [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms)                                                                                                                           |
| Amazon Web Services (Bedrock) | Claude and other models served through Amazon Bedrock (completions, embeddings) | United States: requests are sent to US East (us-east-1 or us-east-2), and model ids starting with `us.` are routed within US Regions. Model ids starting with `global.` use AWS global [cross-region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html) and may be processed in any commercial AWS Region the profile covers | Governed by [Amazon Bedrock data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html)                                                                                                  |
| OpenAI                        | GPT models (completions), embeddings, image generation                          | Set by the provider                                                                                                                                                                                                                                                                                                                                                    | Chat and Responses requests are sent with `store: false`; the embeddings and image endpoints have no storage option. Otherwise governed by [OpenAI's API data policy](https://platform.openai.com/docs/guides/your-data) |
| Google (Gemini)               | Gemini models (completions), embeddings, image generation                       | Set by the provider                                                                                                                                                                                                                                                                                                                                                    | Governed by the [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms)                                                                                                                                    |
| xAI                           | Grok models (completions), image generation                                     | Set by the provider                                                                                                                                                                                                                                                                                                                                                    | Governed by the [xAI Privacy Policy](https://x.ai/legal/privacy-policy)                                                                                                                                                  |
| Moonshot AI                   | Kimi models (completions)                                                       | Set by the provider                                                                                                                                                                                                                                                                                                                                                    | Governed by the [Moonshot AI platform privacy policy](https://platform.moonshot.ai/docs/agreement/userprivacy)                                                                                                           |
| DeepSeek                      | DeepSeek models (completions)                                                   | Set by the provider                                                                                                                                                                                                                                                                                                                                                    | Governed by the [DeepSeek Privacy Policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)                                                                                                          |
| Voyage AI                     | Embeddings                                                                      | Set by the provider                                                                                                                                                                                                                                                                                                                                                    | Governed by the [Voyage AI Privacy Policy](https://www.voyageai.com/privacy)                                                                                                                                             |
| Black Forest Labs             | Image generation                                                                | Set by the provider                                                                                                                                                                                                                                                                                                                                                    | Governed by the [Black Forest Labs Privacy Policy](https://bfl.ai/legal/privacy-policy)                                                                                                                                  |

### 7.2 Infrastructure and services

| Sub-processor           | Purpose                                                                                                                                                     | Region                                                                        | Retention                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Amazon Web Services     | Application hosting, file storage and content delivery, queues, logs, moderation of generated images (Amazon Rekognition), transactional email (Amazon SES) | United States (us-east-2); content delivery uses AWS edge locations worldwide | As described in sections 3 to 5                                     |
| MongoDB (MongoDB Atlas) | Primary database (accounts, usage records, credit ledger, API key request log, notebooks)                                                                   | The region of our database cluster                                            | As described in sections 3 and 4                                    |
| Stripe                  | Payments and subscriptions (no API request content)                                                                                                         | Set by the provider                                                           | Governed by the [Stripe Privacy Policy](https://stripe.com/privacy) |

The web app uses further providers for features the API does not call (for example web search, web page fetching, weather lookups, speech and image analysis); those are covered by the Privacy Policy. We do not use a third-party error-tracking service: errors are recorded in our own logs and database.

## 8. Changes

We update this page before a new sub-processor begins processing customer data.
