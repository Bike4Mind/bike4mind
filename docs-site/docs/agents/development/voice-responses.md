---
sidebar_position: 6
---

# Voice Responses

Nova can now speak her responses! When you use voice input, Nova will automatically respond with voice in addition to text.

## How It Works

1. **Tap to Record**: Tap the microphone button and speak your question
2. **Automatic Model Switching**: If using a non-voice model, automatically switches to GPT-4O Realtime
3. **Automatic Transcription**: Your speech is transcribed in real-time
4. **Voice Response**: Nova responds with both text AND voice
5. **Smart Truncation**: Long responses are intelligently shortened for voice

## Model Compatibility

The microphone button is always visible, regardless of your selected model:

- **Voice-Enabled Models**: GPT-4O Realtime, GPT-4O Realtime Preview
- **Other Models**: Clicking the mic automatically switches to a voice-enabled model
- **Seamless Experience**: No need to manually change models for voice

## Smart Response Truncation

Nova intelligently adapts her voice responses based on content type:

### Standard Responses (&lt; 75 words)
- Spoken in full
- Natural, conversational tone

### Longer Responses (&gt; 75 words)
- First paragraph or 75 words spoken
- Adds "I've written more details below"
- Full response available in text

### Lists and Enumerations
- Announces total count: "I found 12 items"
- Speaks first few items
- Adds "I've listed all items in the text below"

### Code Blocks
- Says "I've written some code for you"
- Adds "Please review it in the text display"
- No code is spoken (avoids confusion)

## Voice Controls

### During Recording
- **Stop Button**: End recording manually
- **Auto-stop**: Coming soon - silence detection

### During Playback
- **Volume Control**: Adjust voice volume
- **Stop Speaking**: Cancel voice playback
- **Visual Indicators**: See when Nova is speaking

## Technical Details

### Supported Models
- GPT-4O Realtime Preview
- GPT-4O Realtime (when available)

### Voice Options
- Shimmer (default)
- Echo
- Alloy  
- Nova
- Fable

### Audio Format
- PCM16 encoding
- Real-time streaming
- Low latency response

## Best Practices

1. **Clear Speech**: Speak clearly for best transcription
2. **Natural Language**: Talk as you would to a person
3. **Context**: Provide context in your questions
4. **Interruption**: You can interrupt Nova's voice response

## Coming Soon

- Auto-stop after silence
- Voice mode preferences
- Custom voice settings per agent
- Background noise reduction
- Multi-language support 