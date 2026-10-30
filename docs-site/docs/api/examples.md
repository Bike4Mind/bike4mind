# SDKs & Examples

Code examples for integrating with the Bike4Mind API across different programming languages and frameworks. The API is plain HTTPS + JSON - no SDK required.

## Basic API Client

### JavaScript/TypeScript

```typescript
class BikeForMindAPI {
  private token: string;
  private baseUrl: string;

  constructor(token: string, baseUrl: string = 'https://app.bike4mind.com') {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  private async request(endpoint: string, options: RequestInit = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        const body = JSON.parse(text);
        message = body.error?.message ?? (typeof body.error === 'string' ? body.error : text);
      } catch {
        // Not JSON: keep the raw text
      }
      throw Object.assign(new Error(`API Error: ${message}`), {
        status: response.status,
        retryAfter: Number(response.headers.get('Retry-After')) || undefined,
      });
    }

    if (response.status === 204) return undefined;
    return response.json();
  }

  async get(endpoint: string) {
    return this.request(endpoint);
  }

  async post(endpoint: string, data?: unknown) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async put(endpoint: string, data: unknown) {
    return this.request(endpoint, {
      method: 'PUT', 
      body: JSON.stringify(data)
    });
  }

  async delete(endpoint: string) {
    return this.request(endpoint, {
      method: 'DELETE'
    });
  }
}

// Usage
const api = new BikeForMindAPI('your-jwt-token');
const agents = await api.get('/api/agents');
```

### Python

```python
import requests
import json

class BikeForMindAPI:
    def __init__(self, token, base_url='https://app.bike4mind.com'):
        self.token = token
        self.base_url = base_url
        self.headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        }
    
    def _request(self, method, endpoint, data=None):
        url = f'{self.base_url}{endpoint}'
        
        response = requests.request(
            method, url, 
            headers=self.headers,
            json=data if data else None
        )
        
        if not response.ok:
            try:
                error = response.json().get('error')
                message = error.get('message') if isinstance(error, dict) else error
            except ValueError:
                message = None
            raise requests.HTTPError(f"API Error: {message or response.text}", response=response)
        
        if response.status_code == 204:
            return None
        return response.json()
    
    def get(self, endpoint):
        return self._request('GET', endpoint)
    
    def post(self, endpoint, data=None):
        return self._request('POST', endpoint, data)
    
    def put(self, endpoint, data):
        return self._request('PUT', endpoint, data)
    
    def delete(self, endpoint):
        return self._request('DELETE', endpoint)

# Usage
api = BikeForMindAPI('your-jwt-token')
agents = api.get('/api/agents')
```

## Common Use Cases

### Agent Management

```typescript
// List your agents
const agents = await api.get('/api/agents');

// Get one agent
const agent = await api.get('/api/agents/agent_123');
```

### Agent Operations

```typescript
// Create a custom agent
const agent = await api.post('/api/agents', {
  name: 'Code Review Assistant',
  description: 'Helps review code and suggest improvements',
  personality: {
    majorMotivation: 'Analyzer',
    minorMotivation: 'Teacher',
    flaw: 'None',
    quirk: 'None'
  },
  capabilities: [JSON.stringify({
    triggerWords: ['@review', '@code'],
    responseStyle: 'detailed',
    specialBehaviors: ['code_review', 'best_practices']
  })],
  triggerWords: ['@review', '@code'],
  isPublic: false
});

// List all available agents
const agents = await api.get('/api/agents'); // accessible agents

// Attach agent to a session
await api.post(`/api/sessions/${sessionId}/agents`, {
  agentId: agent.id
});

// Generate description using AI
const description = await api.post(`/api/agents/${agent.id}/generate-description`);
```

### File Upload Example

```typescript
// Upload and transcribe audio
async function transcribeAudio(audioFile: File) {
  const formData = new FormData();
  formData.append('file', audioFile);

  const response = await fetch('/api/ai/transcribe', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  });

  if (!response.ok) {
    throw new Error('Transcription failed');
  }

  return response.json();
}

// Usage
const audioFile = document.getElementById('audio-input').files[0];
const result = await transcribeAudio(audioFile);
console.log('Transcription:', result.text);
```

### WebSocket Integration

```typescript
class BikeForMindWebSocket {
  private ws: WebSocket;
  private token: string;

  constructor(token: string) {
    this.token = token;
    this.connect();
  }

  private connect() {
    this.ws = new WebSocket('wss://app.bike4mind.com/websocket');
    
    this.ws.onopen = () => {
      // Authenticate connection
      this.send({
        action: 'authenticate',
        token: this.token
      });
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };

    this.ws.onclose = () => {
      // Reconnect after delay
      setTimeout(() => this.connect(), 5000);
    };
  }

  private send(data: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private handleMessage(message: unknown) {
    if (typeof message !== 'object' || message === null || !('type' in message)) return;
    switch (message.type) {
      case 'agent_attached':
        console.log('Agent attached:', message);
        break;
      case 'agent_response':
        console.log('Agent response:', message);
        break;
      default:
        console.log('Unknown message:', message);
    }
  }

  subscribeToSession(sessionId: string) {
    this.send({
      action: 'subscribe_query',
      data: {
        query: 'sessions',
        filters: { sessionId }
      }
    });
  }
}

// Usage
const ws = new BikeForMindWebSocket('your-jwt-token');
ws.subscribeToSession('session_123');
```

### Error Handling with Retry Logic

Retry only 429, 500 and 503, wait the `Retry-After` seconds on a 429, and never retry 400, 401, 403, 413 or 422. The `request` method above attaches `status` and `retryAfter` to the error it throws, so the [retry helper](./completions/examples/javascript.md#retry-helper) works with it unchanged. The full retry table is in [Completions errors](./completions/errors.md#retry-guidance).

### Pagination Helper

```typescript
async function getAllPages<T>(
  api: BikeForMindAPI,
  endpoint: string,
  pageSize: number = 20
): Promise<T[]> {
  const allItems: T[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await api.get(`${endpoint}?page=${page}&limit=${pageSize}`);
    
    allItems.push(...response.data);
    
    hasMore = response.hasMore;
    page++;
  }

  return allItems;
}

// Usage
const allAgents = await getAllPages(api, '/api/agents');
```

## cURL Examples

### Basic Authentication
```bash
# List your agents
curl -X GET https://app.bike4mind.com/api/agents \
  -H "Authorization: Bearer $JWT_TOKEN"
```

### Create Agent
```bash
curl -X POST https://app.bike4mind.com/api/agents \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Research Assistant",
    "description": "Helps with research tasks",
    "personality": {
      "majorMotivation": "Explorer",
      "flaw": "None",
      "quirk": "None"
    },
    "capabilities": ["{\"responseStyle\":\"analytical\",\"specialBehaviors\":[\"research\",\"analysis\"]}"]
  }'
```

### File Upload
```bash
# Transcribe audio file
curl -X POST https://app.bike4mind.com/api/ai/transcribe \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -F "file=@audio.mp3"
```

### With Error Handling
```bash
# Using jq for JSON processing
response=$(curl -s -w "%{http_code}" \
  -X GET https://app.bike4mind.com/api/agents \
  -H "Authorization: Bearer $JWT_TOKEN")

http_code="${response: -3}"
body="${response%???}"

if [ "$http_code" -eq 200 ]; then
  printf '%s\n' "$body" | jq .
else
  printf '%s\n' "$body" | jq .error
fi
```

## Framework Integration

### React Hook

```typescript
import { useState, useEffect } from 'react';
import { BikeForMindAPI } from './api';

export function useAgents(searchTerm?: string) {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchAgents = async () => {
      try {
        setLoading(true);
        const api = new BikeForMindAPI(userToken);
        const response = await api.get(`/api/agents?query=${encodeURIComponent(searchTerm || '')}`);
        setAgents(response.data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchAgents();
  }, [searchTerm]);

  return { agents, loading, error };
}
```

### Vue Composable

```typescript
import { ref, computed } from 'vue';
import { BikeForMindAPI } from './api';

export function useAPI() {
  const loading = ref(false);
  const error = ref(null);

  const api = new BikeForMindAPI(userToken);

  const callAPI = async (apiCall: () => Promise<unknown>) => {
    try {
      loading.value = true;
      error.value = null;
      return await apiCall();
    } catch (err) {
      error.value = err.message;
      throw err;
    } finally {
      loading.value = false;
    }
  };

  return {
    api,
    loading: computed(() => loading.value),
    error: computed(() => error.value),
    callAPI
  };
}
```

## Testing

### Jest Test Example

```typescript
import { BikeForMindAPI } from '../api';

// Mock fetch
global.fetch = jest.fn();

describe('BikeForMindAPI', () => {
  let api: BikeForMindAPI;

  beforeEach(() => {
    api = new BikeForMindAPI('test-token');
    (fetch as jest.Mock).mockClear();
  });

  test('should create agent successfully', async () => {
    const mockAgent = {
      id: 'agent_123',
      name: 'Test Agent'
    };

    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockAgent)
    });

    const result = await api.post('/api/agents', {
      name: 'Test Agent'
    });

    expect(result).toEqual(mockAgent);
    expect(fetch).toHaveBeenCalledWith(
      'https://app.bike4mind.com/api/agents',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-token'
        })
      })
    );
  });
});
```

This comprehensive documentation provides developers with everything they need to integrate with the Bike4Mind API, from basic usage to advanced patterns and error handling.