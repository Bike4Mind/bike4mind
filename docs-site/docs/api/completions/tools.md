---
title: Tools & Function Calling
description: Complete guide to using tools and function calling with the B4M Completions API
sidebar_position: 5
---

# Tools & Function Calling

Learn how to extend AI capabilities by providing tools (also known as function calling) that the model can use to access external data and perform actions.

## How Tool Calling Works

Tool calling allows the AI model to request execution of external functions when it needs additional capabilities.

**Flow:**

```
1. Client defines tools in request
2. Model decides if/when to call tools
3. API returns tool_use event with tool calls
4. Client executes tools locally
5. Client sends tool results in next request
6. Model processes results and responds
7. Repeat until model finishes (no more tool calls)
```

:::important
Tools are **NOT** executed server-side. The API only returns tool call requests for the client to execute. This design ensures security and flexibility.
:::

---

## Tool Definition Format

Each tool must be wrapped in a `toolSchema` object with three required components:

```typescript
{
  toolSchema: {
    name: string;           // Unique identifier (snake_case recommended)
    description: string;    // Clear description of what the tool does
    parameters: object;     // JSON Schema for parameters
  }
}
```

### `toolSchema.name`

**Type:** `string`

**Description:** Unique identifier for the tool. Use snake_case for consistency.

**Examples:** `get_weather`, `search_database`, `send_email`

### `toolSchema.description`

**Type:** `string`

**Description:** Clear, concise description of what the tool does and when to use it. This helps the model understand when to call the tool.

**Best practices:**
- Be specific about functionality
- Include relevant use cases
- Mention any limitations

**Example:**

```json
{
  "toolSchema": {
    "description": "Get current weather information for a specific location. Use this when the user asks about weather conditions, temperature, or forecasts."
  }
}
```

### `toolSchema.parameters`

**Type:** `object` (JSON Schema)

**Description:** JSON Schema definition of the tool's parameters.

**Required fields:**
- `type`: Must be `"object"`
- `properties`: Object defining each parameter
- `required`: Array of required parameter names

**Example:**

```json
{
  "toolSchema": {
    "parameters": {
      "type": "object",
      "properties": {
        "location": {
          "type": "string",
          "description": "City name (e.g., 'San Francisco', 'London')"
        },
        "unit": {
          "type": "string",
          "enum": ["celsius", "fahrenheit"],
          "description": "Temperature unit"
        }
      },
      "required": ["location"]
    }
  }
}
```

---

## Complete Example Tool Definition

Here's a complete tool definition for a weather API:

```json
{
  "toolSchema": {
    "name": "get_weather",
    "description": "Get current weather information for a specific location",
    "parameters": {
      "type": "object",
      "properties": {
        "location": {
          "type": "string",
          "description": "City name (e.g., 'San Francisco')"
        },
        "unit": {
          "type": "string",
          "enum": ["celsius", "fahrenheit"],
          "description": "Temperature unit (default: celsius)"
        }
      },
      "required": ["location"]
    }
  }
}
```

---

## Complete Tool Calling Workflow

Let's walk through a complete tool calling example.

### Step 1: Define Tools and Make Initial Request

```javascript
const tools = [
  {
    toolSchema: {
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'City name'
          }
        },
        required: ['location']
      }
    }
  }
];

const response = await fetch('https://app.bike4mind.com/api/ai/v1/completions', {
  method: 'POST',
  headers: {
    'X-API-Key': apiKey,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'claude-3-5-sonnet',
    messages: [
      {
        role: 'user',
        content: 'What is the weather in San Francisco?'
      }
    ],
    options: {
      tools: tools  // Include tools in request
    }
  })
});
```

### Step 2: Receive Tool Use Event

The model decides to use the weather tool:

```json
{
  "type": "tool_use",
  "text": "I'll check the weather for you.",
  "tools": [
    {
      "name": "get_weather",
      "arguments": "{\"location\":\"San Francisco\"}",
      "id": "toolu_01ABC123"
    }
  ],
  "usage": {
    "inputTokens": 120,
    "outputTokens": 65
  }
}
```

**Note:** The `arguments` field is a JSON string that must be parsed. The `id` is required for pairing with `tool_result`.

### Step 3: Execute Tool Locally

```javascript
function executeToolLocally(toolName, toolArguments) {
  // Parse the JSON string arguments
  const toolInput = JSON.parse(toolArguments);

  if (toolName === 'get_weather') {
    // Call your weather API
    const weatherData = callWeatherAPI(toolInput.location);

    return {
      location: toolInput.location,
      temperature: 72,
      condition: 'Sunny',
      humidity: 45,
      wind_speed: 5
    };
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

// Execute the tool
const toolResult = executeToolLocally('get_weather', { location: 'San Francisco' });
```

### Step 4: Send Tool Result Back

```javascript
const followUpResponse = await fetch('https://app.bike4mind.com/api/ai/v1/completions', {
  method: 'POST',
  headers: {
    'X-API-Key': apiKey,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'claude-3-5-sonnet',
    messages: [
      {
        role: 'user',
        content: 'What is the weather in San Francisco?'
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: "I'll check the weather for you."
          },
          {
            type: 'tool_use',
            id: 'toolu_01ABC123',  // Use the ID from the tool_use response
            name: 'get_weather',
            input: { location: 'San Francisco' }
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01ABC123',  // Must match the tool_use id
            content: JSON.stringify(toolResult)
          }
        ]
      }
    ],
    options: {
      tools: tools  // Include same tools array
    }
  })
});
```

### Step 5: Receive Final Response

```json
{
  "type": "content",
  "text": "The weather in San Francisco is currently sunny with a temperature of 72°F. The humidity is at 45% with light winds of 5 mph.",
  "usage": {
    "inputTokens": 180,
    "outputTokens": 42
  }
}
```

---

## Multiple Tools Example

You can define multiple tools for different capabilities:

```javascript
const tools = [
  {
    toolSchema: {
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name' }
        },
        required: ['location']
      }
    }
  },
  {
    toolSchema: {
      name: 'search_database',
      description: 'Search the knowledge database for information',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results', default: 10 }
        },
        required: ['query']
      }
    }
  },
  {
    toolSchema: {
      name: 'send_email',
      description: 'Send an email to a recipient',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Email address' },
          subject: { type: 'string', description: 'Email subject' },
          body: { type: 'string', description: 'Email body' }
        },
        required: ['to', 'subject', 'body']
      }
    }
  }
];
```

The model will choose the appropriate tool(s) based on the user's request.

---

## Best Practices

### 1. Clear Tool Descriptions

Help the model understand when to use each tool:

**❌ Bad:**

```json
{
  "name": "get_data",
  "description": "Gets data"
}
```

**✅ Good:**

```json
{
  "name": "get_weather",
  "description": "Get current weather information for a specific location. Use this when the user asks about weather conditions, temperature, or forecasts for any city."
}
```

### 2. Validate Tool Inputs

Always validate parameters before execution:

```javascript
function executeToolSafely(toolName, toolInput) {
  // Validate tool name
  const allowedTools = ['get_weather', 'search_database'];
  if (!allowedTools.includes(toolName)) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  // Validate input parameters
  if (toolName === 'get_weather') {
    if (typeof toolInput.location !== 'string') {
      throw new Error('Invalid location parameter');
    }
    if (toolInput.location.length === 0) {
      throw new Error('Location cannot be empty');
    }
  }

  // Execute tool
  return executeTool(toolName, toolInput);
}
```

### 3. Handle Tool Errors Gracefully

Return error messages to the model:

```javascript
function executeToolWithErrorHandling(toolName, toolInput) {
  try {
    return executeTool(toolName, toolInput);
  } catch (error) {
    // Return error to model
    return {
      error: true,
      message: `Tool execution failed: ${error.message}`,
      toolName: toolName
    };
  }
}
```

The model will see the error and can respond appropriately (e.g., apologize, try alternative approach).

### 4. Set Timeouts

Don't let tool execution hang indefinitely:

```javascript
async function executeToolWithTimeout(toolName, toolInput, timeoutMs = 5000) {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Tool execution timeout')), timeoutMs);
  });

  const executionPromise = executeTool(toolName, toolInput);

  try {
    return await Promise.race([executionPromise, timeoutPromise]);
  } catch (error) {
    return {
      error: true,
      message: `Tool timed out after ${timeoutMs}ms`
    };
  }
}
```

### 5. Never Execute Untrusted Code

**❌ NEVER DO THIS:**

```javascript
function executeTool(toolName, toolInput) {
  eval(toolInput.code);  // DANGEROUS! Never execute arbitrary code
}
```

**✅ Use Whitelisted Tools:**

```javascript
function executeTool(toolName, toolInput) {
  switch (toolName) {
    case 'get_weather':
      return getWeather(toolInput.location);
    case 'search_database':
      return searchDatabase(toolInput.query);
    case 'send_email':
      return sendEmail(toolInput.to, toolInput.subject, toolInput.body);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
```

### 6. Include Tools in Follow-up Requests

Always include the tools array in follow-up requests so the model has consistent tool availability:

```javascript
// Initial request
{ options: { tools: [...] } }

// Follow-up with tool results
{ options: { tools: [...] } }  // Same tools array

// Final request
{ options: { tools: [...] } }  // Same tools array
```

### 7. Limit Tool Execution Time

Prevent long-running operations from blocking:

```javascript
const MAX_EXECUTION_TIME = 10000; // 10 seconds

async function executeTool(toolName, toolInput) {
  const startTime = Date.now();

  const result = await performToolOperation(toolName, toolInput);

  const duration = Date.now() - startTime;
  if (duration > MAX_EXECUTION_TIME) {
    console.warn(`Tool ${toolName} took ${duration}ms (exceeds ${MAX_EXECUTION_TIME}ms)`);
  }

  return result;
}
```

---

## Tool Calling Patterns

### Pattern 1: Single Tool Call

User asks a question → Model calls one tool → Model responds with answer

```
User: "What's the weather in Paris?"
  ↓
Model: tool_use (get_weather)
  ↓
Client: Executes tool
  ↓
Model: "The weather in Paris is..."
```

### Pattern 2: Multiple Sequential Tool Calls

Model calls tools one at a time to gather information

```
User: "Compare weather in Paris and London"
  ↓
Model: tool_use (get_weather, Paris)
  ↓
Client: Returns Paris weather
  ↓
Model: tool_use (get_weather, London)
  ↓
Client: Returns London weather
  ↓
Model: "Paris is sunny at 72°F while London..."
```

### Pattern 3: Parallel Tool Calls

Model calls multiple tools at once

```
User: "Get weather and news for San Francisco"
  ↓
Model: tool_use ([get_weather, get_news])
  ↓
Client: Executes both tools in parallel
  ↓
Model: "The weather is sunny and in the news..."
```

---

## Error Handling

### Tool Not Found

If the client doesn't recognize a tool:

```javascript
function executeTool(toolName, toolInput) {
  const handlers = {
    'get_weather': getWeather,
    'search_database': searchDatabase,
  };

  if (!handlers[toolName]) {
    return {
      error: true,
      message: `Tool '${toolName}' not found. Available tools: ${Object.keys(handlers).join(', ')}`
    };
  }

  return handlers[toolName](toolInput);
}
```

### Tool Execution Failed

If a tool fails during execution:

```javascript
async function executeTool(toolName, toolInput) {
  try {
    return await performTool(toolName, toolInput);
  } catch (error) {
    return {
      error: true,
      message: `Tool execution failed: ${error.message}`,
      toolName: toolName,
      input: toolInput
    };
  }
}
```

The model will see the error and can respond appropriately.

---

## Security Considerations

### 1. Validate All Inputs

Never trust tool inputs from the model:

```javascript
function validateWeatherInput(input) {
  if (!input.location || typeof input.location !== 'string') {
    throw new Error('Invalid location');
  }

  // Sanitize input
  const location = input.location.trim();

  if (location.length === 0 || location.length > 100) {
    throw new Error('Invalid location length');
  }

  return location;
}
```

### 2. Whitelist Tools

Only allow execution of explicitly defined tools:

```javascript
const ALLOWED_TOOLS = new Set(['get_weather', 'search_database']);

function executeTool(toolName, toolInput) {
  if (!ALLOWED_TOOLS.has(toolName)) {
    throw new Error(`Tool ${toolName} not allowed`);
  }

  // Execute tool
}
```

### 3. Rate Limit Tool Executions

Prevent abuse by rate limiting tool calls:

```javascript
class ToolRateLimiter {
  constructor(maxCallsPerMinute = 60) {
    this.maxCalls = maxCallsPerMinute;
    this.calls = [];
  }

  async checkLimit() {
    const now = Date.now();
    this.calls = this.calls.filter(time => time > now - 60000);

    if (this.calls.length >= this.maxCalls) {
      throw new Error('Tool rate limit exceeded');
    }

    this.calls.push(now);
  }
}

const limiter = new ToolRateLimiter(60);

async function executeTool(toolName, toolInput) {
  await limiter.checkLimit();
  return performTool(toolName, toolInput);
}
```

### 4. Log Tool Usage

Monitor tool usage for security and debugging:

```javascript
function executeTool(toolName, toolInput) {
  console.log({
    timestamp: new Date().toISOString(),
    tool: toolName,
    input: toolInput,  // Be careful with sensitive data
  });

  const result = performTool(toolName, toolInput);

  console.log({
    timestamp: new Date().toISOString(),
    tool: toolName,
    success: true,
  });

  return result;
}
```

---

## Testing Tools

### Unit Test Example

```javascript
describe('Weather Tool', () => {
  it('should return weather for valid location', async () => {
    const result = await executeTool('get_weather', {
      location: 'San Francisco'
    });

    expect(result).toHaveProperty('temperature');
    expect(result).toHaveProperty('condition');
    expect(result.location).toBe('San Francisco');
  });

  it('should handle invalid location', async () => {
    const result = await executeTool('get_weather', {
      location: ''
    });

    expect(result).toHaveProperty('error');
    expect(result.error).toBe(true);
  });

  it('should timeout long-running tools', async () => {
    const result = await executeToolWithTimeout('slow_tool', {}, 1000);

    expect(result).toHaveProperty('error');
    expect(result.message).toContain('timeout');
  });
});
```

---

## Next Steps

- **[Extended Thinking](/api/completions/extended-thinking)** - Use reasoning with tool calls
- **[Code Examples](/api/completions/examples/javascript)** - See complete tool implementations
- **[Error Handling](/api/completions/errors)** - Handle tool errors
- **[Best Practices](/api/completions/best-practices)** - Production tool patterns
