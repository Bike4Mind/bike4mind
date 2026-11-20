---
title: Extended Thinking
description: Use Anthropic's extended thinking feature for complex reasoning tasks
sidebar_position: 6
---

# Extended Thinking

Learn how to use Anthropic Claude's extended thinking feature to see the model's reasoning process for complex tasks.

## What is Extended Thinking?

Extended thinking is an Anthropic Claude feature that allows the model to show its reasoning process before providing an answer. The model breaks down complex problems into steps and shows its work.

**When the model uses extended thinking:**
- Mathematical problem solving
- Code debugging and analysis
- Complex logical reasoning
- Multi-step planning tasks
- Philosophical questions

**Benefits:**
- **Transparency:** See how the model reached its conclusion
- **Accuracy:** Extended reasoning often leads to better answers
- **Educational:** Learn the model's thought process
- **Debugging:** Identify where reasoning may have gone wrong

:::info Opt in per request
Thinking defaults depend on the model: older Claude models require opt-in, while some adaptive Claude models reason by default. Send `options.thinking.enabled: true`, and optionally `options.thinking.budget_tokens` (integer; the in-app API reference lists the allowed range and default) and `options.reasoningEffort` (`none`, `minimal`, `low`, `medium`, `high` or `xhigh`). Models that cannot think ignore these fields. The in-app API reference lists the exact behavior per provider.
:::

---

## How It Works

Models may expose these two components when thinking metadata is available:

1. **Thinking blocks** - The model's internal reasoning and step-by-step analysis
2. **Response text** - The final answer based on the thinking

**Process:**

```
User asks complex question
  ↓
Model engages extended thinking
  ├─ Breaks down the problem
  ├─ Considers different approaches
  ├─ Works through steps
  └─ Arrives at conclusion
  ↓
Returns thinking + answer
```

---

## Response Format

On an Anthropic tool turn, the `tool_use` event can include an optional `thinking` array. Ordinary content events do not guarantee readable thinking blocks:

```typescript
{
  type: "tool_use";
  text: string;                    // The final answer
  thinking?: Array<{               // Optional thinking blocks
    type: "thinking";
    signature: string;
    thinking: string;                  // Reasoning text
  }>;
  usage: {
    inputTokens: number;
    outputTokens: number;          // Includes thinking tokens
  };
}
```

**Example response:**

```json
{
  "type": "tool_use",
  "text": "The answer is 9 sheep. The phrase 'all but 9 die' means that 9 survived.",
  "thinking": [
    {
      "type": "thinking",
      "signature": "provider-signature",
      "thinking": "This is a word problem that requires careful reading. Let me parse it:\n- Total sheep: 17\n- 'all but 9 die' means: everyone except 9 died\n- So 9 survived\n- The answer is 9 remaining sheep"
    }
  ],
  "usage": {
    "inputTokens": 28,
    "outputTokens": 95
  }
}
```

---

## Example Request & Response

### Request

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "Authorization: Bearer $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [
      {
        "role": "user",
        "content": "A farmer has 17 sheep, and all but 9 die. How many are left?"
      }
    ],
    "max_tokens": 4000,
    "options": { "thinking": { "enabled": true, "budget_tokens": 2048 } }
  }'
```

### Response

The stream carries answer text as `content` events. Thinking metadata is optional and is primarily used to preserve signed blocks on tool turns. A response may contain no readable `thinking` field even when the model reasons.

```
data: {"type":"content","text":"9 sheep are left.","usage":{"inputTokens":28,"outputTokens":95},"stopReason":"end_turn"}

data: [DONE]
```

---

## Displaying Thinking to Users

These display examples apply only to readable `thinking` blocks. A `redacted_thinking` block is opaque. Preserve all raw blocks, including signatures, when echoing an assistant tool turn; see [tool continuation](./tools.md#step-4-send-tool-result-back). Do not rebuild the blocks from displayed text.

The final event's `stopReason: "max_tokens"` means the answer was truncated even if `[DONE]` follows; increase or omit `max_tokens` to allow enough room for reasoning and answer text.

You have three options for handling thinking blocks in your UI:

### Option 1: Show Thinking

Display the reasoning process to users. **Best for:** Educational apps, research tools, debugging.

```javascript
function displayResponse(event) {
  // Display the answer
  console.log('Answer:', event.text);

  // Display thinking process
  if (event.thinking && event.thinking.length > 0) {
    console.log('\nReasoning process:');
    event.thinking.filter(block => block.type === 'thinking').forEach((block, index) => {
      console.log(`\nStep ${index + 1}:`);
      console.log(block.thinking);
    });
  }
}
```

### Option 2: Hide Thinking

Only show the final answer. **Best for:** Clean UX, simple applications, casual use.

```javascript
function displayResponse(event) {
  // Only display the answer
  console.log('Answer:', event.text);

  // Thinking is available but not displayed
}
```

### Option 3: Collapsible Thinking

Show answer first with option to view reasoning. **Best for:** Most applications, balanced approach.

```jsx
function ResponseComponent({ event }) {
  const [showThinking, setShowThinking] = useState(false);

  return (
    <div>
      <div className="answer">{event.text}</div>

      {event.thinking && event.thinking.length > 0 && (
        <div>
          <button onClick={() => setShowThinking(!showThinking)}>
            {showThinking ? 'Hide' : 'Show'} reasoning
          </button>

          {showThinking && (
            <div className="thinking">
              {event.thinking.filter(block => block.type === 'thinking').map((block, i) => (
                <div key={i} className="thinking-block">
                  {block.thinking}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

---

## Token Usage and Costs

:::warning Important
Thinking blocks count toward token usage and costs. Extended thinking can significantly increase output tokens for complex reasoning tasks.
:::

**Example token usage:**

```
Simple question without thinking:   50 output tokens
Same question with thinking:       200 output tokens
```

Thinking tokens count within output tokens. `usage` counters and `credits.used`, when present, are cumulative for the completion; use the last reported values rather than adding every event. `reasoningTokens`, when reported, is a subset of `outputTokens`, not an additional charge.

**Recommendations:**

1. **Budget accordingly** - Account for increased token usage when using models with extended thinking
2. **Set `max_tokens`** - Limit total output to control costs
3. **Monitor usage** - Track token consumption for optimization
4. **Use when valuable** - Extended thinking is most valuable for complex reasoning tasks

---

## When to Use Extended Thinking

### Excellent Use Cases

✅ **Mathematical problems**
```
User: "If f(x) = 2x + 3 and g(x) = x^2, what is f(g(3))?"

Model thinks: "First evaluate g(3) = 3^2 = 9, then f(9) = 2(9) + 3 = 21"
```

✅ **Code debugging**
```
User: "Why is this Python code not working?"

Model thinks: "Let me analyze the code... The issue is on line 5 where..."
```

✅ **Logic puzzles**
```
User: "Three people are wearing different colored hats..."

Model thinks: "Let me work through the possibilities systematically..."
```

✅ **Multi-step planning**
```
User: "Plan a trip from NYC to Tokyo with 2 stops"

Model thinks: "I need to consider: flights, layovers, costs, time zones..."
```

### Less Valuable Use Cases

❌ **Simple factual questions**
```
User: "What's the capital of France?"
(No complex reasoning needed - "Paris" is sufficient)
```

❌ **Creative writing**
```
User: "Write a short story"
(Thinking process not useful for creative output)
```

❌ **Quick responses**
```
User: "Hello!"
(No reasoning needed for greetings)
```

---

## Supported Models

Extended thinking is available on supported Anthropic Claude models; a Claude name alone does not establish support. Call `GET /api/v1/models` for the model ids available to you.

Check the model's capabilities in the API reference rather than inferring support from its name.

---

## Parsing Thinking in Code

### JavaScript Example

```javascript
async function streamWithThinking(messages) {
  const response = await fetch('https://app.bike4mind.com/api/ai/v1/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.B4M_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      messages: messages,
      max_tokens: 4000,
      options: { thinking: { enabled: true, budget_tokens: 2048 } },
    })
  });

  // Parse SSE stream...

  function handleEvent(event) {
    if (event.type === 'content') {
      // Display answer
      console.log('Answer:', event.text);

      // Check for thinking
      if (event.thinking && event.thinking.length > 0) {
        console.log('\nThinking process:');
        event.thinking.filter(block => block.type === 'thinking').forEach((block, index) => {
          console.log(`\n[Thought ${index + 1}]`);
          console.log(block.thinking);
        });
      }

      // Display token usage
      if (event.usage) {
        console.log('\nToken usage:');
        console.log(`  Input: ${event.usage.inputTokens}`);
        console.log(`  Output: ${event.usage.outputTokens}`);
      }
    }
  }
}
```

### Python Example

```python
def handle_event(event):
    if event.get('type') == 'content':
        # Display answer
        print(f"Answer: {event['text']}")

        # Check for thinking
        if 'thinking' in event and len(event['thinking']) > 0:
            print("\nThinking process:")
            for i, block in enumerate(event['thinking'], 1):
                print(f"\n[Thought {i}]")
                if block.get('type') == 'thinking':
                    print(block['thinking'])

        # Display token usage
        if 'usage' in event:
            usage = event['usage']
            print("\nToken usage:")
            print(f"  Input: {usage.get('inputTokens', 0)}")
            print(f"  Output: {usage.get('outputTokens', 0)}")
```

---

## Best Practices

### 1. Inform Users

Let users know when thinking is shown:

```jsx
<div className="response">
  <div className="answer">{event.text}</div>

  {event.thinking && (
    <div className="thinking-section">
      <span className="thinking-label">
        💭 Reasoning process
      </span>
      <div className="thinking-content">
        {event.thinking.filter(block => block.type === 'thinking').map(block => block.thinking).join('\n')}
      </div>
    </div>
  )}
</div>
```

### 2. Budget for Tokens

Account for increased token usage:

```javascript
// Without thinking estimate
const estimatedTokens = 100;

// With thinking estimate (2-5x multiplier)
const estimatedWithThinking = estimatedTokens * 3;

// Send as the top-level max_tokens field
const max_tokens = estimatedWithThinking;
```

### 3. Use for Complex Tasks

Reserve extended thinking for tasks that benefit from reasoning:

```javascript
function shouldUseExtendedThinking(userQuery) {
  const indicators = [
    'calculate',
    'solve',
    'analyze',
    'debug',
    'compare',
    'evaluate',
    'plan',
  ];

  return indicators.some(word =>
    userQuery.toLowerCase().includes(word)
  );
}
```

### 4. Consider UX

Decide based on your application:

- **Educational apps:** Show thinking by default
- **Consumer apps:** Hide thinking by default
- **Developer tools:** Make thinking toggleable

### 5. Monitor Costs

Track token usage to optimize costs:

```javascript
let totalOutputTokens = 0;
let thinkingTokens = 0;

function trackTokenUsage(event) {
  if (event.usage && event.usage.outputTokens) {
    totalOutputTokens = event.usage.outputTokens;

    // Estimate thinking tokens (rough approximation)
    if (event.thinking && event.thinking.length > 0) {
      const thinkingText = event.thinking.filter(block => block.type === 'thinking').map(b => b.thinking).join('');
      thinkingTokens = event.usage.reasoningTokens ?? Math.floor(thinkingText.length / 4);
    }

    console.log(`Total output tokens: ${totalOutputTokens}`);
    console.log(`Thinking tokens (est): ${thinkingTokens}`);
    console.log(`Percentage: ${(thinkingTokens / totalOutputTokens * 100).toFixed(1)}%`);
  }
}
```

---

## Troubleshooting

### Thinking Not Appearing

**Possible causes:**
1. **Not enabled** - On opt-in models, the request did not set `options.thinking.enabled: true`
2. **Wrong model** - The model cannot think, so the fields are ignored
3. **No exposed blocks** - Not every response returns readable thinking metadata

**Solutions:**
- Send `options.thinking.enabled: true` and use a model that can think (`claude-sonnet-5`, etc.)
- Try a more complex query that requires reasoning

### Too Much Thinking

**Possible causes:**
1. **Complex queries** - Model is being thorough
2. **Large token budget** - The model can spend more of its output budget reasoning

**Solutions:**
- Lower `options.thinking.budget_tokens` and set a reasonable `max_tokens`
- Simplify your queries if possible
- Accept that complex problems require more thinking

---

## Next Steps

- **[Tools & Function Calling](./tools.md)** - Use tools with extended thinking
- **[Code Examples](./examples/javascript.md)** - See complete implementations
- **[Error Handling](./errors.md)** - Handle response parsing
- **[Best Practices](./best-practices.md)** - Optimize token usage
