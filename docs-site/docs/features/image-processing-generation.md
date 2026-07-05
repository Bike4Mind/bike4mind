---
title: Image Generation & Editing
description: Create and edit images using AI with support for multiple providers including OpenAI and Flux
sidebar_position: 8
tags: [images, ai-generation, editing, creative]
---

# Image Generation & Editing

Create stunning images and edit existing ones using AI-powered tools. Bike4Mind integrates multiple image generation providers to give you flexibility and creative control.

## Generating Images

### How to Generate

**Using the Model Picker (Recommended):**

1. Click the **model picker** in the chat input area
2. Select **Image Models** from the dropdown filter
3. Choose an image model (e.g., FLUX PRO, GPT-Image-1)
4. Type a description of the image you want
5. Press Enter to generate

**Using the Command:**

You can also use the `/gen_image` command followed by your prompt:
```
/gen_image A serene mountain landscape at sunset with a lake reflection
```

Once the model generates your image, you can view, download, or edit the result.

### Available Models

#### OpenAI (DALL-E / GPT-Image)
- **GPT-Image-1**: Latest OpenAI image generation
- **Quality options**: Standard or HD
- **Sizes**: 1024x1024, 1024x1536, 1536x1024

#### Flux (BlackForest Labs)
- **FLUX PRO**: High-quality standard generation
- **FLUX PRO Ultra**: Premium quality with custom aspect ratios
- **FLUX Kontext**: Transform existing images based on prompts

### Generation Settings

| Setting | Description |
|---------|-------------|
| **Quality** | Standard or HD (affects detail and credits) |
| **Size/Aspect Ratio** | Choose dimensions for your image |
| **Number of Images** | Generate 1-4 images per request |
| **Safety Level** | Content moderation sensitivity (Flux models) |

---

## Editing Images

### Inpainting (Edit Parts of an Image)

Edit specific areas of an existing image while keeping the rest intact:

1. Click **Edit** on any generated image
2. Use the brush tool to paint over areas you want to change
3. Describe what you want in those areas
4. Click **Generate** to apply the edit

### Image-to-Image Transformation

Transform an entire image based on a new prompt:

1. Upload or select an existing image
2. Describe how you want it transformed
3. The AI will create a new version based on your description

### Masking Tools

- **Brush size**: Adjust from 1-100 pixels
- **Undo/Redo**: Fix mistakes easily
- **Clear mask**: Start over if needed
- **Preview**: See your mask before generating

---

## Working with Generated Images

### Image Actions

Every generated image includes these options:

| Action | Description |
|--------|-------------|
| **Download** | Save to your device |
| **Copy** | Copy to clipboard |
| **Edit** | Open in the image editor |
| **Zoom** | View at full resolution |
| **Gallery** | Browse multiple images |

### Image Gallery

When multiple images are generated:
- Use arrow keys or buttons to navigate
- Click thumbnails for quick selection
- Download individual or all images

---

## Tips for Better Results

### Writing Effective Prompts

1. **Be specific**: "A golden retriever playing in autumn leaves at sunset" works better than "a dog"
2. **Include style**: Mention artistic styles like "watercolor," "photorealistic," or "digital art"
3. **Describe composition**: Specify "close-up," "wide shot," or "from above"
4. **Add atmosphere**: Include lighting, mood, and environment details

### Common Prompt Elements

- **Subject**: What's the main focus?
- **Style**: Photorealistic, cartoon, oil painting, etc.
- **Lighting**: Dramatic, soft, golden hour, studio
- **Mood**: Peaceful, energetic, mysterious
- **Details**: Colors, textures, specific features

---

## Credit Usage

Image generation uses credits based on:
- **Model**: Different models have different costs
- **Quality**: HD images cost more than standard
- **Size**: Larger images use more credits
- **Quantity**: Each image in a batch counts separately

Check your credit balance in Profile > Credit Analytics.

---

## Troubleshooting

### Image Not Generating

- Make sure you have an image model selected (use the model picker and filter by Image Models)
- Check you have sufficient credits
- Verify you have API keys configured for the image provider (OpenAI or BlackForest Labs)
- Try a simpler prompt first

### Poor Quality Results

- Add more detail to your prompt
- Try a different model
- Use HD quality setting
- Specify the style you want

### Edit Not Working as Expected

- Make sure your mask covers the right areas
- Be specific about what should appear in masked areas
- Try a smaller edit area first

---

## Related Features

- [Notebooks](./notebooks.md) - Where images are generated
- [Artifacts](./artifacts-system.md) - Save images as artifacts
- [Knowledge Management](./knowledge-management.md) - Organize generated images
