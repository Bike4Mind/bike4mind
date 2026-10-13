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

Bike4Mind offers 60+ AI models. The lists below name the current lineup; your model picker shows exactly what is enabled for your organization.

### OpenAI Models
- **GPT-6.1 Sol** and the **GPT-6** family (**Astra**, **Luna**, **Sol**)
- **GPT-5.6** and **GPT-5.5**
- **o3** — Advanced reasoning with structured thinking

### Anthropic Models (Claude)

Anthropic models are available via both the Anthropic API and AWS Bedrock. Your administrator determines which backend is active for your organization.

- **Claude Fable 5.1** — Anthropic's most capable model, built for complex long-running agentic tasks. Its safety classifiers may decline some requests (targeting cybersecurity and research-biology content); when that happens the request transparently continues on another Claude model rather than failing.
- **Claude Opus 5.5** and **Claude Opus 5** — Top-tier reasoning and analysis
- **Claude Sonnet 5.5** and **Claude Sonnet 5** — Balanced performance and cost, strong for coding
- **Claude Haiku 5.5** — Fast and lightweight
- **Claude Opus 4.8** — Previous-generation Opus, still available

### Google Gemini Models
- **Gemini 3.1 Pro** — Advanced reasoning with thinking support
- **Gemini 3.8 Flash** — Fast and efficient
- **Gemini 3.5 Flash Lite** — Ultra-lightweight variant

### xAI Models (Grok)
- **Grok 4.7**
- **Grok 4.20**

### DeepSeek Models
- **DeepSeek V4 Pro** — Reasoning-focused flagship
- **DeepSeek Flash** — Fast general-purpose model
- **DeepSeek R1** and **DeepSeek V3.2** — Available via AWS Bedrock

### Moonshot Models (Kimi)
- **Kimi K3** — Moonshot's flagship model with vision, tool use, and reasoning support
- **Kimi K2.7 Code** — Coding-focused variant

### Meta Llama Models (AWS Bedrock)
- **Llama 4 Maverick**
- **Llama 4 Scout**

### Local Models (Ollama)

If your organization has Ollama configured, you can access any locally-hosted models installed on your organization's Ollama instance. Nothing leaves your machine.

### Retiring Soon

These models are being retired by their providers. Move saved notebooks, agents, and API calls to a current model before the date shown.

| Model | Retirement date |
|-------|-----------------|
| Claude Sonnet 4 | 2026-10-14 |
| Claude Haiku 4.5 (direct Anthropic API) | 2026-10-15 |
| Gemini 2.5 models | 2026-10-20 |
| GPT-4, GPT-4 Turbo, GPT-4.1 Nano, o4-mini | 2026-10-23 |
| Claude Opus 4.5 | 2026-11-24 |
| Claude Sonnet 4.5 | 2026-11-30 |

## Supported Image and Video Models

### Image
- **GPT-Image-2** (OpenAI)
- **Nano Banana Pro** and **Nano Banana 2** (Google)
- **FLUX 1.1 Pro Ultra** — Highest quality, photorealistic output (Black Forest Labs)
- **FLUX Kontext** — Image-to-image transformations and editing (Black Forest Labs)

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
- **Claude Opus 5.5**, **GPT-6.1 Sol**, or **Claude Fable 5.1**: Deep analysis and reasoning
- **o3**: Mathematical and logical problems

### For Creative Writing
- **Claude Sonnet 5.5**: Nuanced creative output
- **GPT-5.6**: Long-form content
- Temperature: 0.8-1.2

### For Code Generation
- **Claude Sonnet 5.5**, **Kimi K2.7 Code**, or **GPT-5.6**: Strong code comprehension
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
- **Ultra**: Claude Fable 5.1, o3

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
