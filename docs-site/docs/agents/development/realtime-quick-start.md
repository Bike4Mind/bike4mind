---
title: Real-time API Quick Start
description: Get started with OpenAI's real-time API in 10 minutes
sidebar_position: 4
---

# Real-time API Quick Start

This guide will get you up and running with OpenAI's real-time API for voice agents in just 10 minutes!

## ✅ What You Need

1. **OpenAI API Key** with access to `gpt-4o-realtime-preview`
2. **WebSocket library** (e.g., `ws` for Node.js)
3. **Audio handling** (Web Audio API for browser)

## 🚀 Minimal Implementation

### Step 1: Create the Real-time Backend

```typescript
// b4m-core/utils/src/llm/realtimeBackend.ts
import WebSocket from 'ws';
import { EventEmitter } from 'events';

export class OpenAIRealtimeBackend extends EventEmitter {
  private ws: WebSocket | null = null;
  private apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  async connect() {
    this.ws = new WebSocket('wss://api.openai.com/v1/realtime', {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    this.ws.on('open', () => {
      console.log('Connected to OpenAI Realtime API');
      this.emit('connected');
    });

    this.ws.on('message', (data) => {
      const event = JSON.parse(data.toString());
      this.handleServerEvent(event);
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      this.emit('error', error);
    });

    this.ws.on('close', () => {
      console.log('Disconnected from OpenAI Realtime API');
      this.emit('disconnected');
    });
  }

  private handleServerEvent(event: any) {
    switch (event.type) {
      case 'session.created':
        this.emit('session.created', event);
        break;
      case 'conversation.item.created':
        this.emit('conversation.item.created', event);
        break;
      case 'response.audio.delta':
        this.emit('audio', event.delta);
        break;
      case 'response.text.delta':
        this.emit('text', event.delta);
        break;
      case 'response.done':
        this.emit('response.done', event);
        break;
      default:
        this.emit('event', event);
    }
  }

  sendAudio(audioData: Buffer) {
    this.send({
      type: 'input_audio_buffer.append',
      audio: audioData.toString('base64')
    });
  }

  commitAudio() {
    this.send({
      type: 'input_audio_buffer.commit'
    });
  }

  updateSession(config: any) {
    this.send({
      type: 'session.update',
      session: config
    });
  }

  createResponse() {
    this.send({
      type: 'response.create'
    });
  }

  private send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
```

### Step 2: Integrate with Chat Completion

```typescript
// In ChatCompletion.ts
const REALTIME_MODELS = [
  ChatModels.GPT4O_REALTIME_PREVIEW,
  ChatModels.GPT4O_REALTIME
];

// Add to process() method
if (REALTIME_MODELS.includes(model as ChatModels)) {
  return this.processRealtimeSession(quest, model, params);
}

private async processRealtimeSession(
  quest: IChatHistoryItemDocument,
  model: string,
  params: any
) {
  const apiKey = await getEffectiveApiKey(
    this.user.id,
    { type: ApiKeyType.openai },
    { db: this.db }
  );

  const realtime = new OpenAIRealtimeBackend(apiKey);
  
  // Connect to WebSocket
  await realtime.connect();

  // Configure session with agent personality
  const agent = await this.db.agents.findById(quest.agentIds?.[0]);
  
  realtime.updateSession({
    model: 'gpt-4o-realtime-preview-2024-12-17',
    voice: agent?.voiceId || 'shimmer',
    instructions: agent?.systemPrompt || 'You are a helpful assistant.',
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16',
    turn_detection: {
      type: 'server_vad',
      threshold: 0.5,
      silence_duration_ms: 500
    }
  });

  // Handle responses
  realtime.on('audio', (audioData) => {
    // Send audio chunks to client
    this.sendAudioUpdate(quest, audioData);
  });

  realtime.on('text', (textDelta) => {
    // Update transcript
    quest.replies = quest.replies || [''];
    quest.replies[0] += textDelta;
    this.sendStatusUpdate(quest, null);
  });

  // Start conversation
  realtime.createResponse();
}
```

### Step 3: Update Voice Recording Component

```typescript
// VoiceRecordButton.tsx enhancement
interface VoiceRecordButtonProps {
  // ... existing props
  streamingMode?: boolean;
  onAudioChunk?: (chunk: ArrayBuffer) => void;
}

const VoiceRecordButton: React.FC<VoiceRecordButtonProps> = ({
  streamingMode = false,
  onAudioChunk,
  // ... other props
}) => {
  useEffect(() => {
    if (isRecording && streamingMode) {
      // Set up audio streaming
      const audioContext = new AudioContext({ sampleRate: 24000 });
      const source = audioContext.createMediaStreamSource(stream);
      
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = convertToPCM16(inputData);
        onAudioChunk?.(pcm16);
      };
      
      source.connect(processor);
      processor.connect(audioContext.destination);
    }
  }, [isRecording, streamingMode]);
  
  // ... rest of component
};
```

### Step 4: Client-Side Integration

```typescript
// In your session component
const [realtimeSession, setRealtimeSession] = useState<WebSocket | null>(null);

const handleRealtimeModel = (model: string) => {
  if (model.includes('realtime')) {
    // Connect to your WebSocket endpoint
    const ws = new WebSocket('/api/realtime/connect');
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'audio') {
        // Play audio using Web Audio API
        playAudioChunk(data.audio);
      }
      
      if (data.type === 'transcript') {
        // Update UI with text
        updateTranscript(data.text);
      }
    };
    
    setRealtimeSession(ws);
  }
};

// Voice recording with streaming
<VoiceRecordButton
  streamingMode={selectedModel.includes('realtime')}
  onAudioChunk={(chunk) => {
    if (realtimeSession?.readyState === WebSocket.OPEN) {
      realtimeSession.send(JSON.stringify({
        type: 'audio',
        data: Array.from(new Uint8Array(chunk))
      }));
    }
  }}
/>
```

## 🎯 Testing Your Implementation

1. **Select a real-time model** in your UI
2. **Click the voice button** to start streaming
3. **Speak naturally** - the model will respond in real-time
4. **Interrupt anytime** - just start speaking!

## 🔧 Next Steps

1. **Add error handling** for connection drops
2. **Implement reconnection** logic
3. **Add visual feedback** for voice activity
4. **Store conversations** in your database
5. **Add tool calling** support

## 💡 Pro Tips

1. **Use Server VAD** (Voice Activity Detection) for better UX
2. **Buffer audio chunks** to prevent choppy playback
3. **Show visual indicators** when AI is "thinking"
4. **Implement push-to-talk** as a fallback option
5. **Monitor WebSocket health** with heartbeats

## 🚨 Common Issues

### "Model not found"
```typescript
// Ensure you're using the exact model name
model: 'gpt-4o-realtime-preview-2024-12-17' // NOT just 'gpt-4o-realtime-preview'
```

### Audio Format Mismatch
```typescript
// Match your audio context sample rate
const audioContext = new AudioContext({ sampleRate: 24000 }); // Must match API config
```

### WebSocket Disconnects
```typescript
// Implement exponential backoff reconnection
let reconnectDelay = 1000;
const reconnect = () => {
  setTimeout(() => {
    connect().catch(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      reconnect();
    });
  }, reconnectDelay);
};
```

## 🎉 You're Ready!

With this minimal setup, you now have:
- ✅ Real-time voice input processing
- ✅ Streaming audio responses
- ✅ Live transcription
- ✅ Natural conversation flow

Start building your voice agents today! 🚀 