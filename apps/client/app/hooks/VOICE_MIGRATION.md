# Voice State Machine Migration Guide

## Overview

The voice system has been redesigned with a clean, maintainable state machine architecture. This replaces the previous dual-state approach (boolean flags + enum) with a single source of truth.

## Key Improvements

### 1. **Single Source of Truth**
- No more `isRecording` and `isSpeaking` boolean flags
- All UI state is derived from the main state machine
- Eliminates race conditions and synchronization issues

### 2. **Validated State Transitions**
- All transitions are explicitly defined and validated
- Prevents impossible states (e.g., recording while disconnected)
- Clear transition matrix makes behavior predictable

### 3. **Proper Error Handling**
- Comprehensive error recovery mechanisms
- State cleanup on errors
- Timeout handling for all async operations

### 4. **Better UX Patterns**
- Support for interrupting AI speech to speak
- Direct response during recording for real-time conversation
- Natural conversation flow

## State Comparison

### Old States (Problematic)
```typescript
// Multiple sources of truth
const [isRecording, setIsRecording] = useState(false);
const [isSpeaking, setIsSpeaking] = useState(false);
const [state, setState] = useState(VoiceSessionState.IDLE);

// Could become inconsistent:
// state = CONNECTED, isRecording = true, isSpeaking = true (impossible!)
```

### New States (Clean)
```typescript
// Single source of truth
enum VoiceState {
  IDLE = 'idle',           // No session
  CONNECTING = 'connecting', // Starting session
  READY = 'ready',         // Session active, ready for interaction
  LISTENING = 'listening',  // Recording user audio
  PROCESSING = 'processing', // Processing user input
  SPEAKING = 'speaking',   // AI is speaking
  DISCONNECTING = 'disconnecting', // Ending session
  ERROR = 'error',         // Error state
}

// UI state derived from main state:
const isRecording = state === VoiceState.LISTENING;
const isSpeaking = state === VoiceState.SPEAKING;
const canRecord = state === VoiceState.READY || state === VoiceState.SPEAKING;
```

## Valid Transitions

The new system only allows valid transitions:

```
IDLE → CONNECTING → READY → LISTENING → PROCESSING → SPEAKING → READY
  ↓                    ↓        ↑            ↓           ↓
ERROR ←──────────────────────────────────────────────────┘
  ↓
IDLE (recovery)

Special transitions:
- SPEAKING → LISTENING (interrupt AI to speak)
- LISTENING → SPEAKING (real-time response during recording)
```

## Migration Steps

### 1. **Replace the Hook**
```typescript
// Old
import { useVoice } from './useVoice';

// New  
import { useVoiceV2 } from './useVoiceV2';
```

### 2. **Update State Checks**
```typescript
// Old (problematic)
const { isRecording, isSpeaking, state } = useVoice();

if (state === VoiceSessionState.CONNECTED && !isRecording) {
  // Could be inconsistent
}

// New (reliable)
const { state, isRecording, isSpeaking, canRecord, canSpeak, canInterrupt } = useVoiceV2();

if (canRecord) {
  // Always reliable - derived from state machine
}
```

### 3. **Use New Actions**
```typescript
// Old (async state updates)
const { startRecording, stopRecording } = useVoice();

// New (immediate state updates + new features)
const { 
  startSession,
  endSession,
  startRecording, 
  stopRecording, 
  interruptAndRecord,
  requestVoiceResponse,
  stopSpeaking 
} = useVoiceV2();

// New feature: interrupt AI to speak
if (canInterrupt) {
  interruptAndRecord();
}

// New feature: programmatic voice responses
requestVoiceResponse("Hello! This will be spoken by the AI");
```

### 4. **Update Component Integration**
```typescript
// Old VoiceRecordButton usage (legacy mode)
<VoiceRecordButtonHybrid
  model={model}
  onModelSwitch={(newModel) => setModel(newModel)}
  // ... other props
/>

// New VoiceRecordButton usage (hybrid mode - preserves current model)
<VoiceRecordButtonHybrid
  model={model}
  enableHybridMode={true}  // KEY: Preserves user-selected model
  // onModelSwitch removed - no automatic switching
  // ... other props
/>
```

## Benefits

### 1. **Reliability**
- No more race conditions
- Predictable state transitions
- Proper error recovery

### 2. **Maintainability**
- Clear state machine definition
- Easy to add new features
- Comprehensive logging

### 3. **User Experience**
- Support for natural conversation patterns
- Better error handling
- Responsive state updates

## Testing

The new state machine can be easily tested:

```typescript
// Test valid transitions
expect(isValidTransition(VoiceState.READY, VoiceState.LISTENING, VoiceEvent.START_RECORDING)).toBe(true);

// Test invalid transitions are blocked
expect(isValidTransition(VoiceState.IDLE, VoiceState.LISTENING, VoiceEvent.START_RECORDING)).toBe(false);
```

## Current Implementation Status

### ✅ **Completed**
- ✅ New state machine architecture (`useVoiceV2`)
- ✅ Comprehensive state transitions with validation
- ✅ Enhanced debugging with `VoiceDebugPanelV2`
- ✅ Test component (`VoiceStateMachineTest`)
- ✅ SessionBottom integration with hybrid mode
- ✅ Model preservation in voice interactions
- ✅ TypeScript compilation and linting fixes

### ✅ **Completed**
- ✅ VoiceResponseManager integration (VoiceResponseManagerV2)

### 🔄 **In Progress**
- 🔄 Full integration testing

### 📋 **Pending**
- ⏳ Production voice testing with new state machine
- ⏳ Performance optimization and monitoring
- ⏳ Documentation updates for all voice components

## Key Files Updated

### Core State Machine
- `app/types/voiceStateMachine.ts` - State machine definition
- `app/hooks/useVoiceStateMachine.ts` - State machine logic
- `app/hooks/useVoiceV2.ts` - Main voice hook
- `app/hooks/useHybridVoice.ts` - Updated for new state machine

### Components
- `app/components/Session/SessionBottom.tsx` - Updated to use hybrid mode
- `app/components/Voice/VoiceDebugPanelV2.tsx` - Enhanced debugging
- `app/components/Voice/VoiceStateMachineTest.tsx` - Testing component
- `app/components/common/VoiceRecordButtonHybrid.tsx` - Hybrid mode support

## Rollback Plan

If issues arise, you can quickly rollback by:

1. Changing imports from `useVoiceV2` back to `useVoice`
2. Setting `enableHybridMode={false}` in VoiceRecordButtonHybrid
3. Reverting SessionBottom.tsx voice integration changes

The old `useVoice` hook remains available for emergency rollback.