---
title: WebSocket Architecture Guide
description: Understanding the two-layer WebSocket architecture for voice agents
sidebar_position: 7
---

# WebSocket Architecture Guide for Voice Agents

## Quick Reference

### What You Have

| Component | Location | Purpose | WebSocket Type |
|-----------|----------|---------|----------------|
| `WebsocketContext.tsx` | Client | Connect to your backend | Browser native |
| Voice Lambda Functions | Server | Connect to OpenAI | `ws` package |
| AWS API Gateway | Cloud | Route messages | Managed by AWS |

### The Two Connections

```
1. Browser ↔ Your Backend (Already exists!)
   - Uses: WebsocketContext.tsx
   - URL: wss://your-api-gateway.amazonaws.com
   - Auth: JWT tokens

2. Your Backend ↔ OpenAI (New for voice)
   - Uses: ws npm package  
   - URL: wss://api.openai.com/v1/realtime
   - Auth: OpenAI API key
```

## Common Confusion Points

### ❓ "Why can't I reuse WebsocketContext.tsx?"

**WebsocketContext.tsx is**:
- A React Context (browser-only)
- Connected to YOUR backend
- Using browser's native WebSocket

**You need the `ws` package for**:
- Node.js/Lambda (no native WebSocket)
- Connecting to OpenAI's API
- Server-side WebSocket support

### ❓ "Why not connect directly to OpenAI from browser?"

```javascript
// ❌ BAD: Exposes API key to users
const ws = new WebSocket('wss://api.openai.com/v1/realtime', {
  headers: { 'Authorization': 'Bearer sk-...' } // EXPOSED!
});

// ✅ GOOD: Proxy through your backend
const ws = useWebsocket(); // Uses existing WebsocketContext
ws.send({ action: 'voice.session.start' }); // Your backend handles OpenAI
```

### ❓ "Do I need to modify WebsocketContext.tsx?"

**No!** It already handles:
- Authentication
- Reconnection
- Message routing
- Error handling

Just add new message types:
```typescript
// Already works with existing context
ws.sendJsonMessage({
  action: 'voice.session.start',
  model: 'gpt-4o-realtime-preview',
  agentId: agent.id
});
```

## Implementation Checklist

### ✅ Client Side (No changes needed!)
- [ ] Use existing `useWebsocket()` hook
- [ ] Send voice-specific actions
- [ ] Handle voice-specific responses

### ✅ Server Side (Add these)
- [ ] Install `ws` package in Lambda layer
- [ ] Create OpenAI WebSocket connection
- [ ] Proxy messages between client and OpenAI
- [ ] Handle authentication and rate limiting

## Code Examples

### Client: Starting Voice Session
```typescript
// This already works with existing infrastructure!
const { sendJsonMessage, subscribeToAction } = useWebsocket();

// Subscribe to voice events
useEffect(() => {
  return subscribeToAction('voice.audio.response', async (data) => {
    // Play audio response
    await audioPlayer.play(data.audio);
  });
}, []);

// Start voice session
const startVoice = () => {
  sendJsonMessage({
    action: 'voice.session.start',
    sessionId: currentSession.id,
    agentId: selectedAgent.id
  });
};
```

### Server: Lambda Handler
```typescript
// apps/client/server/websocket/voice/voiceSessionStart.ts
import WebSocket from 'ws'; // THIS is why we need the ws package!

export const handler = async (event) => {
  const { sessionId, agentId } = JSON.parse(event.body);
  
  // Create connection to OpenAI (needs ws package)
  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime', {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });
  
  // Store in memory for this Lambda instance
  activeVoiceSessions.set(sessionId, openaiWs);
  
  // Proxy OpenAI responses back to client
  openaiWs.on('message', (data) => {
    // Send back through AWS API Gateway
    await postToConnection({
      ConnectionId: event.requestContext.connectionId,
      Data: JSON.stringify({
        action: 'voice.audio.response',
        data: JSON.parse(data)
      })
    });
  });
};
```

## Debugging Tips

### WebSocket Connection Issues

1. **Client can't connect to your backend**
   ```bash
   # Check if SST is running
   ps aux | grep "sst dev"
   
   # Restart if needed
   ./dev
   ```

2. **Lambda can't connect to OpenAI**
   ```bash
   # Verify ws package is installed
   cd b4m-core/utils
   npm list ws
   
   # Check Lambda logs
   sst logs -f voice
   ```

3. **"This function is in live debug mode"**
   - Normal in development
   - Means Lambda cold start
   - Retry the connection

## Architecture Benefits

### Security
- API keys stay server-side
- User authentication verified
- Rate limiting enforced

### Flexibility  
- Pre-process audio (noise reduction)
- Post-process responses (filtering)
- Add custom analytics

### Reliability
- Handle disconnections gracefully
- Implement retry logic
- Queue messages during outages

## Next Steps

1. Review [Real-time API Integration](../architecture/realtime-api-integration.md)
2. Check [Voice Implementation Guide](./voice-implementation-guide.md)
3. Try the [Real-time Quick Start](./realtime-quick-start.md)

---

**Remember**: The two-layer architecture isn't a limitation—it's a feature that provides security, flexibility, and control over your voice agents! 