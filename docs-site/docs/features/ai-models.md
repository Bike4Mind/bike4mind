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

### OpenAI Models

#### GPT-5 Family
- **GPT-5.5** — Latest and most capable flagship, ~1M context window (1.05M tokens)
- **GPT-5.4** — Highly capable previous flagship, 1M+ context window
- **GPT-5.4 Mini** — Compact GPT-5.4 variant, 400K context window
- **GPT-5.4 Nano** — Ultra-lightweight GPT-5.4, 400K context window
- **GPT-5.2** — Previous-generation flagship, 400K context window
- **GPT-5.2 Chat Latest** — Always points to the latest GPT-5.2 version
- **GPT-5.1** — Early GPT-5 series, 400K context window
- **GPT-5.1 Chat Latest** — Always points to the latest GPT-5.1 version
- **GPT-5** — Original GPT-5 release, 400K context window
- **GPT-5 Mini** — Compact version with excellent performance at lower cost
- **GPT-5 Nano** — Ultra-efficient variant for lightweight tasks
- **GPT-5 Chat Latest** — Always points to the latest GPT-5 version

#### GPT-4 Family
- **GPT-4.1** — Enhanced GPT-4 with 1M+ token context window
- **GPT-4.1 Mini** — Cost-effective variant with the same 1M+ context window
- **GPT-4.1 Nano** — Ultra-efficient variant with the same 1M+ context window
- **GPT-4.5 Preview** — Preview model bridging GPT-4 and GPT-5
- **GPT-4o** — Multimodal model with 128K context
- **GPT-4o Mini** — Cost-effective multimodal model
- **GPT-4 Turbo** — High-performance model with 128K context
- **GPT-4** — Original GPT-4 model

#### O-Series (Reasoning Models)
- **O4 Mini** — Latest compact reasoning model with agentic capabilities
- **O3** — Advanced reasoning with structured thinking
- **O3 Mini** — Smaller, faster reasoning model
- **O1** — Original reasoning model with 200K context
- **O1 Preview** — Early reasoning model preview
- **O1 Mini** — Compact reasoning model

### Anthropic Models (Claude)

Anthropic models are available via both the Anthropic API and AWS Bedrock. Your administrator determines which backend is active for your organization.

#### Claude Fable Series
- **Claude Fable 5** — Anthropic's most capable model, built for complex long-running agentic tasks, with 1M context and adaptive reasoning. Generally available and selectable in the model picker. Its safety classifiers may decline some requests (targeting cybersecurity and research-biology content); when that happens the request transparently continues on Claude 4.8 Opus rather than failing.

#### Claude 4.8 Series
- **Claude 4.8 Opus** — Latest generally available Claude flagship, 1M context window with adaptive reasoning

#### Claude 4.7 Series
- **Claude 4.7 Opus** — High-capability reasoning and analysis, 1M context window with adaptive reasoning

#### Claude 4.6 Series
- **Claude 4.6 Opus** — Powerful reasoning and analysis, 1M context window
- **Claude 4.6 Sonnet** — Enhanced coding, analysis, and complex reasoning with improved speed and efficiency

#### Claude 4.5 Series
- **Claude 4.5 Opus** — Top-tier reasoning and analysis
- **Claude 4.5 Sonnet** — Balanced performance and cost
- **Claude 4.5 Haiku** — Fast and lightweight with large output capacity

#### Claude 4 Series
- **Claude 4.1 Opus** — Enhanced Claude 4 with improved performance
- **Claude 4 Opus** — Powerful reasoning and analysis
- **Claude 4 Sonnet** — Balanced model with competitive pricing

#### Claude 3 Series
- **Claude 3.7 Sonnet** — Most advanced Claude 3.x model with thinking support
- **Claude 3.5 Sonnet** / **Claude 3.5 Sonnet V2** — Balanced performance and cost
- **Claude 3.5 Haiku** — Fast and lightweight
- **Claude 3 Opus** — Original top-tier Claude model

Claude 3.x through 4.5 models (and Claude 4.6 Sonnet) support a 200K token context window. Claude 4.6 Opus and the newer Opus models (4.7, 4.8) and Claude Fable 5 support a 1M token context window.

### Google Gemini Models

#### Gemini 3.5
- **Gemini 3.5 Flash** — Latest generation, fast and efficient with 1M context window and thinking support

#### Gemini 3.1 (Preview)
- **Gemini 3.1 Pro Preview** — Advanced reasoning with 1M context window and thinking support
- **Gemini 3.1 Flash Lite** — Ultra-lightweight latest-gen variant with 1M context window and thinking support

#### Gemini 3 (Preview)
- **Gemini 3 Pro Preview** — Earlier Gemini 3 generation, 1M context window
- **Gemini 3 Flash Preview** — Speed-optimized Gemini 3 generation

#### Gemini 2.5
- **Gemini 2.5 Pro** — Flagship model with 2M context window and thinking support
- **Gemini 2.5 Flash** — Fast and efficient with 1M context window and thinking support
- **Gemini 2.5 Flash Lite** — Ultra-lightweight variant

#### Gemini Legacy
- **Gemini 2.0 Flash Experimental** — Experimental next-gen model
- **Gemini 1.5 Pro** — 2M context window for massive documents
- **Gemini 1.5 Flash** — Speed-optimized with 1M context
- **Gemini 1.5 Flash 8B** — Compact variant

### xAI Models (Grok)

- **Grok 4** — Latest generation with 256K context window
- **Grok 3** — Powerful reasoning model with 131K context
- **Grok 3 Fast** — Speed-optimized Grok 3
- **Grok 3 Mini** — Compact Grok 3
- **Grok 3 Mini Fast** — Fastest Grok variant
- **Grok 2** — Previous generation
- **Grok 2 Vision** — Multimodal with image understanding

### Meta Llama Models (AWS Bedrock)

- **Llama 4 Maverick 17B Instruct** — Optimized for fast, efficient inference
- **Llama 4 Scout 17B Instruct** — Specialized for exploration and reasoning
- **Llama 3 Instruct 70B** — Powerful open-source model
- **Llama 3 Instruct 8B** — Compact model for high-volume tasks

### DeepSeek Models (AWS Bedrock)

- **DeepSeek R1** — Advanced reasoning model with 128K context
- **DeepSeek v3.1** — General-purpose model with 128K context

### Amazon Titan Models (AWS Bedrock)

- **Titan Text Express** — General-purpose text generation
- **Titan Text Lite** — Lightweight variant

### AI21 Labs Models (AWS Bedrock)

- **Jurassic-2 Ultra** — High-capability text generation
- **Jurassic-2 Mid** — Balanced performance

### Local Models (Ollama)

If your organization has Ollama configured, you can access locally-hosted models including:
- **LLaMA 3.3** — Meta's latest local model
- **DeepSeek R1** — Local reasoning model
- **TinyLlama** — Ultra-lightweight local model
- Any other models installed on your organization's Ollama instance

## Supported Image Models

### FLUX Models (Black Forest Labs)
- **FLUX Pro Ultra** — Highest quality, photorealistic output
- **FLUX Pro 1.1** — Professional quality generation
- **FLUX Pro (Legacy)** — Previous generation
- **FLUX Pro Fill** — Inpainting and fill operations
- **FLUX Kontext Pro** — Image-to-image transformations
- **FLUX Kontext Max** — Maximum quality transformations

### OpenAI Image Models
- **GPT-Image-1.5** — Latest generation image model
- **GPT-Image-1** — Previous generation
- **GPT-Image-1 Mini** — Cost-effective variant

### Google Gemini Image Models
- **Gemini 3 Pro Image Preview** — Google's latest image generation
- **Gemini 2.5 Flash Image** — Fast image generation

### xAI Image Models
- **Grok 2 Image** — Image generation via xAI

## Supported Video Models

### OpenAI Sora
- **Sora** — AI video generation (4s, 8s, or 12s clips)
- **Sora Pro** — Higher quality video generation

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
- Available for models flagged with thinking support — including O4 Mini, the GPT-5.4 family, Claude 3.7 Sonnet and all Claude 4.x models (Sonnet, Haiku, Opus, Fable), and Gemini 2.5 Pro/Flash plus all Gemini 3.x text models

## Model Selection Best Practices

### For General Use
- **GPT-4o Mini** or **Claude 4.5 Haiku**: Best balance of cost and performance
- **Gemini 2.5 Flash**: Fast responses for simple queries

### For Complex Tasks
- **Claude 4.8 Opus** or **GPT-5.5**: Deep analysis and reasoning
- **O3** or **O4 Mini**: Mathematical and logical problems
- **Gemini 2.5 Pro**: Massive document analysis (2M context)

### For Creative Writing
- **Claude 4.5 Sonnet**: Nuanced creative output
- **GPT-5**: Large context for long-form content
- Temperature: 0.8-1.2

### For Code Generation
- **Claude 4.5 Sonnet** or **GPT-4.1**: Excellent code comprehension
- **DeepSeek R1**: Strong reasoning for complex code tasks
- Temperature: 0.3-0.5

### For Image Generation
- **FLUX Pro Ultra**: Photorealistic images
- **GPT-Image-1.5**: Creative and artistic
- **FLUX Kontext Pro/Max**: Image transformations and editing

### For Video Generation
- **Sora Pro**: Highest quality AI video clips

## Context Windows

Different models support different context lengths:

| Model | Context Window | Best For |
|-------|---------------|----------|
| GPT-4.1 / 4.1 Mini / 4.1 Nano | 1M+ tokens | Massive codebases |
| GPT-5.5 | ~1M tokens | Long documents, latest flagship |
| GPT-5.4 | ~1M tokens | Long documents, deep analysis |
| GPT-5 / 5.1 / 5.2 (incl. GPT-5 Mini/Nano), GPT-5.4 Mini/Nano | 400K tokens | Long documents |
| Claude 4.6 Opus / Claude 4.7 Opus / Claude 4.8 Opus / Claude Fable 5 | 1M tokens | Largest Claude context |
| Claude (3.x–4.5, 4.6 Sonnet) | 200K tokens | Extensive analysis |
| Gemini 2.5 Pro | 2M tokens | Largest documents |
| Gemini 3.x / 2.5 Flash | 1M tokens | Large documents, fast |
| Grok 4 | 256K tokens | Long conversations |
| DeepSeek R1 / v3.1 | 128K tokens | Code repositories |

## Cost Optimization

### Tips for Managing Credits
1. **Start with smaller models** for initial drafts (Haiku, Mini, Flash variants)
2. **Use streaming** to stop generation early if needed
3. **Set appropriate max tokens** to avoid waste
4. **Choose the right model tier** for the task complexity

### Model Cost Tiers
- **Economy**: GPT-4o Mini, Claude 4.5 Haiku, Gemini Flash, Grok 3 Mini Fast
- **Standard**: GPT-4.1, Claude 4.5 Sonnet, Gemini 2.5 Flash, Grok 3
- **Premium**: GPT-5, Claude 4.5 Opus, Gemini 2.5 Pro, Grok 4
- **Ultra**: O3, Claude 4.6 Opus / Claude 4.7 Opus / Claude 4.8 Opus, GPT-5.5

## API Keys & Custom Models

### Bring Your Own Keys
- Use your own API keys for supported providers (OpenAI, Anthropic, Google, xAI, Black Forest Labs)
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
