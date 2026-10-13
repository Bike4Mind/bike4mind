---
title: AI Models & Language Support
description: Comprehensive guide to supported AI models and configuration options
sidebar_position: 2
tags: [ai-models, configuration, llm]
---

# AI Models & Language Support

Bike4Mind supports a wide range of state-of-the-art AI models for text generation, image generation, video generation, and speech-to-text, giving you the flexibility to choose the right model for your specific needs.

> **Model Availability:** Model availability is managed at the organizational level by your administrator. If you don't see a model or provider listed below in your model selector, it may be disabled for your organization or restricted to certain user roles. Contact your organization administrator to request access to additional models or providers.

## Supported Text Models

Bike4Mind offers 60+ AI models. The lists below cover everything currently offered; your model picker shows exactly what is enabled for your organization.

### OpenAI Models

- **GPT-6.1 Sol**
- **GPT-6 Astra**, **GPT-6 Luna**, **GPT-6 Sol**
- **GPT-5.6 Sol**, **GPT-5.6 Luna**, **GPT-5.6 Terra**
- **GPT-5.5**, **GPT-5.4** (plus **Mini** and **Nano**), **GPT-5.2**, **GPT-5.1**
- **GPT-5**, **GPT-5 Mini**, **GPT-5 Nano**
- **GPT-4.1** and **GPT-4.1 Mini**
- **GPT-4o** and **GPT-4o Mini**
- **o3** - Advanced reasoning with structured thinking

### Anthropic Models (Claude)

Anthropic models are available via both the Anthropic API and AWS Bedrock. Your administrator determines which backend is active for your organization.

- **Claude Fable 5.1** and **Claude Fable 5** - Anthropic's most capable models, built for complex long-running agentic tasks. Their safety classifiers may decline some requests (targeting cybersecurity and research-biology content); when that happens the request transparently continues on another Claude model rather than failing.
- **Claude Opus 5.5**, **Claude Opus 5**, **Claude Opus 4.8**, **Claude Opus 4.7**, **Claude Opus 4.6** - Top-tier reasoning and analysis
- **Claude Sonnet 5.5**, **Claude Sonnet 5**, **Claude Sonnet 4.6** - Balanced performance and cost, strong for coding
- **Claude Haiku 5.5** - Fast and lightweight

### Google Gemini Models
- **Gemini 3.8 Flash**, **Gemini 3.7 Flash**, **Gemini 3.6 Flash**, **Gemini 3.5 Flash**, **Gemini 3 Flash Preview**
- **Gemini 3.5 Flash Lite**, **Gemini 3.1 Flash Lite**
- **Gemini 3.1 Pro Preview** (including a Custom Tools variant)
- **Gemini 2.5 Computer Use Preview**
- **Deep Research Preview** and **Deep Research Max Preview** - Long-running research agents
- **Gemini Flash Latest** and **Gemini Flash-Lite Latest** - Aliases that follow the newest Flash releases

### xAI Models (Grok)
- **Grok 4.7**, **Grok 4.6**, **Grok 4.5**, **Grok 4.3**
- **Grok 4.20** (reasoning, non-reasoning, and multi-agent variants)
- **Grok Build 0.1**

### DeepSeek Models
- **DeepSeek V4 Pro** and **DeepSeek Flash** (direct API)
- **DeepSeek R1**, **DeepSeek V3.2**, and **DeepSeek V3.1** (via AWS Bedrock)

### Moonshot Models (Kimi)
- **Kimi K3** - Moonshot's flagship model (direct API and AWS Bedrock)
- **Kimi K2.7 Code** and **Kimi K2.7 Code (High Speed)** - Coding-focused variants
- **Kimi K2.6** - Previous-generation general-purpose model
- **Kimi K2.5** and **Kimi K2 Thinking** (via AWS Bedrock)

### Meta Llama Models (AWS Bedrock)
- **Llama 4 Maverick 17B Instruct**
- **Llama 4 Scout 17B Instruct**
- **Llama 3.3 70B Instruct**
- **Llama 3.1 70B Instruct** and **Llama 3.1 8B Instruct**
- **Llama 3 Instruct 70B** and **Llama 3 Instruct 8B** (retiring 2027-03-30)

### Local Models (Ollama)

If your organization has Ollama configured, you can access any locally-hosted models installed on your organization's Ollama instance. Requests go only to that instance, never to an external provider.

### Retiring Soon

These models are being retired by their providers. Move saved notebooks, agents, and API calls to a current model before the date shown.

| Model | Retirement date |
|-------|-----------------|
| Claude Haiku 4.5 (direct Anthropic API) | 2026-10-15 |
| Gemini 2.5 Pro and Flash-Lite | 2026-10-16 |
| GPT-4, GPT-4 Turbo, GPT-4.1 Nano, o4-mini | 2026-10-23 |
| Claude Opus 4.5 | 2026-11-24 |
| Claude Sonnet 4.5 | 2026-11-30 |
| o3 | 2026-12-11 |

Claude Sonnet 4 (direct Anthropic API) and Gemini 2.5 Flash have already been retired and no longer appear in the model picker. For developers: where a retirement is scheduled, `GET /api/v1/models` (API key with `ai:chat` or `ai:generate`) returns it in `deprecation_date`.

## Supported Image and Video Models

### Image
- **GPT-Image-2** and **GPT-Image-2.5** variants (OpenAI), plus **GPT-Image-1.5** and **GPT-Image-1 Mini**
- **Nano Banana Pro**, **Nano Banana 2**, and **Nano Banana** (Google)
- **FLUX Pro Ultra** and **FLUX Pro 1.1** - Photorealistic, professional quality (Black Forest Labs)
- **FLUX Kontext Pro** and **FLUX Kontext Max** - Image-to-image transformations and editing (Black Forest Labs)

GPT-Image-1 and Grok Imagine (Quality) are retiring on 2026-10-23 and 2026-11-02.

### Video
- **Veo 3.1 Fast** (Google)
- **Grok Imagine Video 1.5** (xAI)

## Speech-to-Text Models

- **Whisper-1** (OpenAI) — Industry-leading speech recognition
- **Amazon Transcribe** (AWS) — Cloud-based transcription service

## Model Configuration

### Temperature (0.0 - 2.0)
Controls randomness in responses:
- **0.0**: Most deterministic, factual
- **0.7**: Balanced creativity
- **1.0**: Default setting
- **2.0**: Maximum creativity

### Max Tokens
Controls response length:
- Automatically adjusted based on model capabilities
- Context-aware limits to prevent overflow
- Model-specific maximums respected

### Advanced Settings

#### Streaming
- Real-time token-by-token generation
- Reduces perceived latency
- Available for most models

#### Multiple Responses (n)
- Generate 1-4 parallel responses
- Compare different approaches
- Useful for creative tasks

#### Thinking Models
- Explicit reasoning steps before responding
- Configurable token budget
- Available for models flagged with thinking support, including o3, recent GPT models, the Claude Opus, Sonnet, Haiku, and Fable families, and the Gemini 3.x models

## Model Selection Best Practices

### For General Use
- **Claude Haiku 5.5** or **Gemini 3.8 Flash**: Best balance of cost and speed
- **Gemini 3.5 Flash Lite**: Very fast responses for simple queries

### For Complex Tasks
- **Claude Opus 5.5**, **GPT-6.1 Sol**, or **Claude Fable 5.1**: Deep analysis, reasoning, and mathematical or logical problems

### For Creative Writing
- **Claude Sonnet 5.5**: Nuanced creative output
- **GPT-5.6 Sol**: Long-form content
- Temperature: 0.8-1.2

### For Code Generation
- **Claude Sonnet 5.5**, **Kimi K2.7 Code**, or **GPT-5.6 Sol**: Strong code comprehension
- **DeepSeek V4 Pro**: Strong reasoning for complex code tasks
- Temperature: 0.3-0.5

### For Image Generation
- **FLUX 1.1 Pro Ultra**: Photorealistic images
- **GPT-Image-2** or **Nano Banana Pro**: Creative and artistic
- **FLUX Kontext**: Image transformations and editing

## Cost Optimization

### Tips for Managing Credits
1. **Start with smaller models** for initial drafts (Haiku, Flash, and Flash Lite variants)
2. **Use streaming** to stop generation early if needed
3. **Set appropriate max tokens** to avoid waste
4. **Choose the right model tier** for the task complexity

### Model Cost Tiers
- **Economy**: Claude Haiku 5.5, Gemini 3.5 Flash Lite, DeepSeek Flash
- **Standard**: Claude Sonnet 5.5, Gemini 3.8 Flash, GPT-5.5
- **Premium**: Claude Opus 5.5, GPT-6.1 Sol, Gemini 3.1 Pro, Grok 4.7
- **Ultra**: Claude Fable 5.1

## API Keys & Custom Models

### Bring Your Own Keys
- Use your own API keys for supported providers (OpenAI, Anthropic, Google, xAI, DeepSeek, Moonshot (Kimi), Black Forest Labs)
- Manage keys from your Profile settings

### Ollama Integration
- Connect locally-hosted models
- Custom model support
- Privacy-first approach

### Need a Model Enabled?

If a model or provider you need isn't available in your model selector, contact your organization administrator. They can:
- Enable or disable specific models for your organization
- Configure which providers are active
- Adjust model access based on user roles

---

## Related Features

- [Notebooks](./notebooks.md) - Where you use AI models
- [Research Mode](./research-mode.md) - Compare multiple models side-by-side
- [Profile & Settings](./profile-settings.md) - Manage API keys
- [Image Generation](./image-processing-generation.md) - Image model usage
