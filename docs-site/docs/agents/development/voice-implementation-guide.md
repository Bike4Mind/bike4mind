---
title: Voice Agents Implementation Guide
description: Technical guide mapping existing code to voice agent requirements
sidebar_position: 2
---

# Voice Agents Implementation Guide

## You Already Have 80% of What You Need! 🎉

This guide maps your existing codebase to the voice agent requirements, showing exactly what you can reuse and what needs to be built.

## 🟢 What You Already Have

### 1. Voice Input Infrastructure ✅ **UPDATED**

**Component**: `VoiceRecordButtonHybrid` in `SessionBottom.tsx` 

```typescript
// Updated implementation with new state machine
<VoiceRecordButtonHybrid
  sessionId={currentSessionId || 'temp'}
  questId={currentSessionId ? 'new' : 'temp'}
  agentId={displayAgents.length > 0 ? displayAgents[0].id : undefined}
  model={isImageModel(model) ? ChatModels.GPT4O_REALTIME_PREVIEW : (model as ChatModels)}
  onTranscript={async (transcript: string) => {
    setRecording(false);
    await handleSendClick(transcript);
  }}
  onError={() => setRecording(false)}
  onRecordingStart={() => setRecording(true)}
  onRecordingEnd={async (prompt: string) => {
    setRecording(false);
    await handleSendClick(prompt);
  }}
  onRecordingError={() => setRecording(false)}
  enableHybridMode={true}  // NEW: Preserves user-selected model
/>
```

**Status**: ✅ **FULLY UPDATED** with new state machine and hybrid mode support!

### 2. Agent System with Personality ✅

**What you have**:
- Full personality system with 20+ dimensions
- Agent creation and management
- Trigger word detection (`@agent` mentions)
- Dynamic agent attachment
- Agent state management

```typescript
// From AgentBench.tsx - Dynamic agent management
const detectAgentMentions = (text: string): string[] => {
  const mentions = text.match(/@(\w+)/g)?.map(m => m.slice(1).toLowerCase()) || [];
  return mentions;
};
```

### 3. Voice State Machine ✅ **NEW**

**Clean Architecture**: New state machine replaces problematic dual-state approach

```typescript
// New state machine with single source of truth
import { useVoiceV2 } from './hooks/useVoiceV2';

const {
  state,              // VoiceState enum - single source of truth
  isRecording,        // Derived from state
  isSpeaking,         // Derived from state  
  canRecord,          // Derived from state
  canSpeak,           // Derived from state
  canInterrupt,       // Derived from state
  startSession,       // Clean session management
  startRecording,     // Immediate state updates
  interruptAndRecord, // NEW: Interrupt AI to speak
  requestVoiceResponse // NEW: Programmatic voice output
} = useVoiceV2();
```

**Key Benefits**:
- ✅ No more race conditions between boolean flags
- ✅ Validated state transitions prevent impossible states  
- ✅ Support for interrupting AI speech to respond
- ✅ Enhanced debugging with `VoiceDebugPanelV2`
- ✅ Model preservation (no forced switching)

### 4. Real-time Communication ✅

**WebSocket Infrastructure**:
- Existing WebSocket context and connections
- Real-time message updates
- **NEW**: Voice-specific WebSocket handlers integrated
- Event-based communication
- Subscriber fanout service

```typescript
// You already handle real-time updates!
const { sendJsonMessage, readyState } = useWebsocket();
```

### 4. Session Management ✅

**What you have**:
- Session creation and persistence
- Message history tracking
- Context management
- WorkBench pattern for pre-session state

### 5. Queue Processing ✅

**Existing queues** that can be adapted:
- `questStartQueue` - Can handle voice processing tasks
- WebSocket handlers for real-time audio
- Dead letter queues for error handling

### 6. Memory System (Mementos) ✅

**Perfect for**:
- Storing voice transcripts
- Speaker profiles
- Conversation summaries
- Meeting notes

## 🟡 What Needs Enhancement

### 1. VoiceRecordButton → Streaming Audio

**Current**: Records and sends complete audio
**Needed**: Stream audio chunks in real-time

```typescript
// Enhanced VoiceRecordButton
interface EnhancedVoiceRecordButton {
  mode: 'push-to-talk' | 'continuous' | 'voice-activated';
  
  // Add streaming capability
  onAudioChunk?: (chunk: Float32Array) => void;
  
  // Add real-time transcription
  onPartialTranscript?: (text: string) => void;
  
  // Keep existing callbacks
  onRecordingEnd: (fullTranscript: string) => void;
}
```

### 2. Agent Detection → Wake Word Detection

**Current**: Text-based `@mentions`
**Needed**: Voice-based wake words

```typescript
// Extend existing detection
const detectVoiceAgentTrigger = (transcript: string, agent: IAgent): boolean => {
  // Reuse existing mention detection
  const textMentions = detectAgentMentions(transcript);
  
  // Add voice-specific wake words
  const voiceWakeWords = agent.voiceCapabilities?.wakeWords || [];
  
  return textMentions.includes(agent.name.toLowerCase()) ||
         voiceWakeWords.some(wake => transcript.toLowerCase().includes(wake));
};
```

### 3. AgentBench → Voice Status Indicators

**Current**: Shows attached agents
**Needed**: Show voice activity status

```typescript
// Extend AgentBench chip display
<Chip
  variant="soft"
  color={voiceState === 'listening' ? 'success' : 'warning'}
  startDecorator={
    <Box sx={{ position: 'relative' }}>
      <Avatar src={agent.visual?.portraitUrl} />
      {voiceState === 'speaking' && <PulsingIndicator />}
    </Box>
  }
>
  {agent.name}
</Chip>
```

## 🔴 What Needs to Be Built

### 1. OpenAI Realtime Client

```typescript
// New service to create
class OpenAIRealtimeService {
  private ws: WebSocket;
  private sessionId: string;
  
  async connect(config: RealtimeConfig) {
    this.ws = new WebSocket('wss://api.openai.com/v1/realtime');
    
    // Reuse your existing WebSocket patterns!
    this.ws.on('message', this.handleRealtimeMessage);
  }
  
  // Stream audio to OpenAI
  async streamAudio(audioChunk: Float32Array) {
    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64Encode(audioChunk)
    }));
  }
}
```

### 2. Speaker Diarization Service

```typescript
// New capability to add
interface SpeakerProfile {
  id: string;
  embedding: Float32Array;
  name?: string;
  userId?: string; // Link to existing users
}

class SpeakerService {
  // Store in existing Memento system!
  async saveSpeakerProfile(profile: SpeakerProfile) {
    return createMemento({
      type: 'speaker_profile',
      data: profile,
      sessionId: this.sessionId
    });
  }
}
```

### 3. Voice Agent State Manager

```typescript
// Extend existing agent state
interface VoiceAgentState {
  agentId: string;
  isListening: boolean;
  lastActivated?: Date;
  currentSpeaker?: string;
  conversationBuffer: string[];
}

// Add to SessionsContext
const [voiceAgentStates, setVoiceAgentStates] = useState<Map<string, VoiceAgentState>>();
```

## 🛠️ Implementation Roadmap

### Foundation
1. **Audit VoiceRecordButton** ✅ (2 hours)
   - Test current functionality
   - Identify Web Audio API updates needed
   
2. **Set up OpenAI Realtime** (1 day)
   - Create service wrapper
   - Add to existing API structure
   
3. **Extend Agent Model** (4 hours)
   - Add voiceCapabilities to IAgent
   - Update database schema

### Core Voice Features
1. **Implement Streaming Audio** (2 days)
   - Update VoiceRecordButton
   - Add continuous recording mode
   - Connect to OpenAI Realtime
   
2. **Add Voice Indicators** (1 day)
   - Extend AgentBench UI
   - Add speaking/listening states
   - Create audio visualizer

3. **Test Basic Flow** (1 day)
   - Voice input → Agent response
   - Debug and refine

### Passive Listening
1. **Continuous Recording Mode** (2 days)
   - Background audio capture
   - Silence detection
   - Efficient buffering
   
2. **Wake Word Detection** (2 days)
   - Extend mention detection
   - Add voice triggers
   - Test with multiple agents

### Speaker Recognition
1. **Basic Diarization** (3 days)
   - Speaker segmentation
   - Embedding generation
   - Profile storage
   
2. **Integration & Testing** (2 days)
   - Connect all components
   - End-to-end testing
   - Performance optimization

## 💡 Quick Wins

### 1. Resurrect Voice Input
Just getting the existing VoiceRecordButton working again will excite users!

### 2. Voice Responses
Add TTS to agent responses using OpenAI's voice models - instant "wow" factor!

### 3. Simple Wake Words
Even basic "Hey [Agent Name]" functionality will feel magical.

## 🔗 Code Connection Points

### Existing Files to Modify

1. **`SessionBottom.tsx`**
   - Enhance VoiceRecordButton
   - Add continuous recording toggle
   - Show voice agent states

2. **`AgentBench.tsx`**
   - Add voice activity indicators
   - Show current speaker
   - Display listening status

3. **`LLMContext.tsx`**
   - Add voice model selection
   - Store voice preferences
   - Manage TTS settings

4. **`WebsocketContext.tsx`**
   - Add audio streaming events
   - Handle real-time transcripts
   - Manage voice sessions

### New Files to Create

1. **`services/VoiceAgentService.ts`**
   - OpenAI Realtime client
   - Audio processing
   - Voice state management

2. **`components/VoiceIndicator.tsx`**
   - Speaking animation
   - Audio level visualization
   - Recording status

3. **`hooks/useVoiceAgent.ts`**
   - Voice agent state
   - Audio permissions
   - Recording management

4. **`utils/audioProcessing.ts`**
   - Audio chunking
   - Format conversion
   - Silence detection

## 🚀 Why This Will Work

1. **Existing Infrastructure**: Your WebSocket, session, and agent systems are perfect foundations
2. **Proven Patterns**: You already handle real-time updates, state management, and agent interactions
3. **Clean Architecture**: Your modular design makes adding voice features straightforward
4. **User Familiarity**: Users already understand agents and @mentions - voice is a natural extension

## 🎯 Next Steps

1. **Test VoiceRecordButton** - See what works today
2. **Get OpenAI Realtime Access** - Request API access
3. **Create Feature Branch** - `feature/voice-agents`
4. **Start with Bronze Tier** - Basic voice in/out
5. **Iterate Fast** - Get feedback early and often

---

You're not starting from scratch - you're adding voice to an already powerful agent system. This is absolutely achievable and will be AMAZING! 🚀

The fact that you already have:
- Agent personalities ✅
- Real-time WebSocket ✅
- Session management ✅
- Dynamic agent attachment ✅
- Memory system ✅

Means you can focus on the fun parts - making agents come alive with voice! 🎙️✨ 