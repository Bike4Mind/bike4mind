---
title: Research Mode
description: Compare responses from multiple AI models simultaneously to find the best results for your needs
sidebar_position: 10
tags: [research, comparison, models, experimental]
---

# Research Mode

*(Experimental Feature — enable in [Profile > Settings > Experimental Features](./profile-settings.md#experimental-features))*

Research Mode lets you compare responses from multiple AI models side-by-side. Ask a question once and see how different models answer it, helping you choose the best model for your needs.

---

## Overview

### Why Use Research Mode?

- **Compare models**: See how Claude, GPT-4, Gemini, and others respond differently
- **Test parameters**: Try the same model with different temperature settings
- **Make informed choices**: Find which model works best for specific tasks
- **Save time**: No need to ask the same question multiple times

### How It Works

1. Enable Research Mode in your notebook settings
2. Configure up to 4 different model configurations
3. Send your prompt
4. All models respond simultaneously in a grid view
5. Compare results side-by-side

---

## Setting Up Research Mode

### Enabling the Feature

1. Open **AI Settings** in your notebook
2. Find the **Tools** section
3. Toggle **Research Mode** on
4. Configure your model selections

### Configuring Models

For each of the 4 slots, you can set:

| Setting | Description |
|---------|-------------|
| **Model** | Choose any available AI model |
| **Temperature** | Control response creativity (0.0 - 1.0+) |
| **Max Tokens** | Limit response length |

### Example Configurations

**Compare Model Families:**
- Slot 1: Claude 3.5 Sonnet
- Slot 2: GPT-4o
- Slot 3: Gemini 2.5 Pro
- Slot 4: Llama 3

**Test Temperature Settings:**
- Slot 1: Claude (temperature 0.0 - focused)
- Slot 2: Claude (temperature 0.5 - balanced)
- Slot 3: Claude (temperature 0.8 - creative)
- Slot 4: Claude (temperature 1.0 - very creative)

---

## Using Research Mode

### Sending Prompts

When Research Mode is active:
1. Type your prompt normally
2. Press Enter to send
3. All configured models receive the same prompt
4. Responses stream in simultaneously

### Viewing Results

Results appear in a grid layout:
- **Desktop**: 2x2 grid showing all 4 responses
- **Mobile**: Stacked cards you can scroll through
- Each response shows the model name and settings

### Comparing Responses

Look for differences in:
- **Tone and style**: How each model writes
- **Detail level**: Some models are more thorough
- **Accuracy**: Fact-checking across models
- **Creativity**: Unique approaches to problems
- **Speed**: Which models respond faster

---

## Best Practices

### When to Use Research Mode

**Good use cases:**
- Evaluating models for a new project
- Finding the best model for creative writing vs. technical tasks
- Testing how models handle specific domains
- Comparing cost vs. quality trade-offs

**Not ideal for:**
- Quick single questions (use normal mode)
- Very long conversations (uses 4x credits)
- Simple factual lookups

### Optimizing Your Comparisons

1. **Use consistent prompts**: Ask the exact same question to all models
2. **Test multiple times**: Run a few comparisons to see patterns
3. **Note the differences**: Keep track of which model excels at what
4. **Consider cost**: Research Mode uses credits for all 4 models

---

## Understanding Results

### What to Look For

| Aspect | What It Tells You |
|--------|-------------------|
| **Response time** | Model speed and efficiency |
| **Length** | Verbosity preferences |
| **Format** | How each structures answers |
| **Accuracy** | Factual correctness |
| **Helpfulness** | Practical usefulness |

### Making Decisions

After comparing:
- Note which model performed best for your use case
- Consider switching your default model
- Save preferred configurations for future use

---

## Cost Considerations

Research Mode uses significantly more credits:
- **4x credit usage** per prompt (one for each model)
- Higher costs for premium models
- Consider using smaller prompts for initial testing

**Tip**: Use Research Mode sparingly for evaluation, then switch to your preferred single model for regular use.

---

## Limitations

### Current Restrictions

- Maximum 4 model configurations
- All models receive identical context
- Some models may not be available depending on your plan
- Long conversations can become expensive

### Coming Soon

- Save and load configuration presets
- Export comparison results
- Automated quality scoring
- Team-shared configurations

---

## Related Features

- [Notebooks](./notebooks.md) - Where Research Mode is used
- [AI Settings](./notebooks.md#ai-settings) - Configure models
- [Profile & Settings](./profile-settings.md) - Manage API keys
