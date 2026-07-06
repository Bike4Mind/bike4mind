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

:::info Automatic Feature
Extended thinking is automatically available for supported Anthropic Claude models. You don't need to enable it explicitly.
:::

---

## How It Works

When extended thinking is used, the response includes two components:

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

When extended thinking is used, the `content` event includes a `thinking` array:

```typescript
{
  type: "content";
  text: string;                    // The final answer
  thinking?: Array<{               // Optional thinking blocks
    type: "thinking";
    text: string;                  // Reasoning text
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
  "type": "content",
  "text": "The answer is 9 sheep. The phrase 'all but 9 die' means that 9 survived.",
  "thinking": [
    {
      "type": "thinking",
      "text": "This is a word problem that requires careful reading. Let me parse it:\n- Total sheep: 17\n- 'all but 9 die' means: everyone except 9 died\n- So 9 survived\n- The answer is 9 remaining sheep"
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
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [
      {
        "role": "user",
        "content": "A farmer has 17 sheep, and all but 9 die. How many are left?"
      }
    ]
  }'
```

### Response (with extended thinking)

```
data: {"type":"content","text":"9 sheep are left. The phrase 'all but 9 die' means that 9 survived.","thinking":[{"type":"thinking","text":"This is a word problem that requires careful reading. Let me parse it:\n- Total sheep: 17\n- 'all but 9 die' means: everyone except 9 died\n- So 9 survived\n- The answer is 9 remaining sheep"}],"usage":{"inputTokens":28,"outputTokens":95}}

data: [DONE]
```

---

## Displaying Thinking to Users

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
    event.thinking.forEach((block, index) => {
      console.log(`\nStep ${index + 1}:`);
      console.log(block.text);
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
              {event.thinking.map((block, i) => (
                <div key={i} className="thinking-block">
                  {block.text}
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

**Cost impact:**

```
Claude 3.5 Sonnet: $15/1M output tokens

Without thinking: 50 tokens = $0.00075
With thinking:   200 tokens = $0.003

4x increase in cost
```

**Recommendations:**

1. **Budget accordingly** - Account for increased token usage when using models with extended thinking
2. **Set maxTokens** - Limit total output to control costs
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

Extended thinking is currently available for:

- **Claude 3.5 Sonnet**
- **Claude 3 Opus**
- **Other Anthropic Claude models** (check model capabilities)

**Check if a model supports extended thinking:**

```javascript
function supportsExtendedThinking(modelName) {
  const supportedModels = [
    'claude-3-5-sonnet',
    'claude-3-opus',
    'claude-3-sonnet',
  ];

  return supportedModels.some(model =>
    modelName.toLowerCase().includes(model)
  );
}
```

---

## Parsing Thinking in Code

### JavaScript Example

```javascript
async function streamWithThinking(messages) {
  const response = await fetch('https://app.bike4mind.com/api/ai/v1/completions', {
    method: 'POST',
    headers: {
      'X-API-Key': process.env.B4M_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: messages
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
        event.thinking.forEach((block, index) => {
          console.log(`\n[Thought ${index + 1}]`);
          console.log(block.text);
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
                print(block['text'])

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
        {event.thinking.map(block => block.text).join('\n')}
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

// Set appropriate maxTokens
const maxTokens = estimatedWithThinking;
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
    totalOutputTokens += event.usage.outputTokens;

    // Estimate thinking tokens (rough approximation)
    if (event.thinking && event.thinking.length > 0) {
      const thinkingText = event.thinking.map(b => b.text).join('');
      thinkingTokens += Math.floor(thinkingText.length / 4);
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
1. **Wrong model** - Extended thinking only works with Anthropic Claude models
2. **Simple query** - Model determined thinking wasn't needed
3. **Model decision** - Model chose not to use extended thinking

**Solutions:**
- Verify you're using a Claude model (`claude-3-5-sonnet`, etc.)
- Try a more complex query that requires reasoning
- Extended thinking is automatic and model-decided (cannot be forced)

### Too Much Thinking

**Possible causes:**
1. **Complex queries** - Model is being thorough
2. **No token limit** - Allowing unlimited output

**Solutions:**
- Set reasonable `maxTokens` limits
- Simplify your queries if possible
- Accept that complex problems require more thinking

---

## Next Steps

- **[Tools & Function Calling](/api/completions/tools)** - Use tools with extended thinking
- **[Code Examples](/api/completions/examples/javascript)** - See complete implementations
- **[Error Handling](/api/completions/errors)** - Handle response parsing
- **[Best Practices](/api/completions/best-practices)** - Optimize token usage
