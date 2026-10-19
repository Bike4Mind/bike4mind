---
title: Quick Start Guide
description: Get started with Bike4Mind agents in 5 minutes
sidebar_position: 1
---

# Quick Start Guide

Get up and running with Bike4Mind agents in just a few minutes! This guide will walk you through creating your first agent and using it in a conversation.

## What You'll Learn

- Create your first AI agent
- Customize agent personality and capabilities
- Attach agents to conversations
- Use agents in real conversations

## Prerequisites

- Active Bike4Mind account
- Basic familiarity with the platform

## Step 1: Create Your First Agent

### Navigate to Agents

1. Open Bike4Mind in your browser
2. Look for the **Agents** section in the sidebar
3. Click **"Create Agent"** or the **"+"** button

### Configure Basic Information

```json
{
  "name": "My Research Assistant",
  "description": "A helpful assistant for research and analysis tasks"
}
```

**Tips:**
- Choose a descriptive name that reflects the agent's purpose
- Write a clear description explaining what the agent does
- Keep names under 50 characters for best display

### Add Personality (Optional but Recommended)

Click the **"🎲 Roll Character"** button for a random personality, or customize manually:

- **Major Motivation**: Explorer (loves discovering new information)
- **Minor Motivation**: Analyzer (enjoys breaking down complex topics)
- **Character Flaw**: Perfectionist (sometimes over-researches)
- **Unique Quirk**: References Academic Papers (always cites sources)
- **Response Style**: Professional

### Set Capabilities

Add relevant capabilities to help with discovery:

```
research, analysis, fact-checking, academic_writing
```

### Configure Trigger Words

Set up @mention triggers:

```
@research, @analyze, @assistant
```

## Step 2: Test Your Agent

### Quick Test
1. Save your agent
2. Start a new conversation
3. Type: `@research Can you help me understand quantum computing?`
4. Your agent should be automatically attached and will respond with its unique personality!

## Step 3: Advanced Features

### Multi-Agent Collaboration

Try using multiple agents together:

```
@research @writing Can you help me write a research paper about AI ethics?
```

Both agents will collaborate on the response, each contributing their specialized perspective.

### Agent Management

**WorkBench Integration:**
- Attach agents before starting conversations
- Agents persist through session creation
- Manage multiple agents simultaneously

**Visual Attribution:**
- See which agents contributed to each response
- Agent chips show active contributors
- Click agent avatars for full profiles

## Common Use Cases

### 1. Content Creation
```markdown
Agent: "Content Creator"
Capabilities: writing, editing, seo, social_media
Trigger: @content, @write
Personality: Creative + Enthusiastic
```

### 2. Data Analysis
```markdown
Agent: "Data Analyst"
Capabilities: analysis, statistics, visualization
Trigger: @data, @analyze
Personality: Analytical + Detail-oriented
```

### 3. Customer Support
```markdown
Agent: "Support Agent"
Capabilities: customer_service, troubleshooting
Trigger: @support, @help
Personality: Helpful + Patient
```

### 4. Technical Documentation
```markdown
Agent: "Tech Writer"
Capabilities: documentation, technical_writing
Trigger: @docs, @technical
Personality: Precise + Clear
```

## Best Practices

### Agent Creation
✅ **Do:**
- Use specific, descriptive names
- Add relevant capabilities for better discovery
- Test different personality combinations
- Set appropriate public/private visibility

❌ **Don't:**
- Create generic "assistant" agents without specialization
- Use overly complex trigger words
- Duplicate capabilities across similar agents

### Conversation Management
✅ **Do:**
- Attach agents before starting complex conversations
- Use @mentions to explicitly call specific agents
- Limit to 3-5 concurrent agents for best performance

❌ **Don't:**
- Attach too many agents simultaneously
- Use agents for simple questions that don't need specialization

### Performance Tips
- **Cache frequently used agents** in your WorkBench
- **Use specific @mentions** for faster agent activation
- **Remove unused agents** from sessions to improve performance

## Troubleshooting

### Agent Not Responding
1. **Check @mentions**: Ensure you're using the correct trigger words
2. **Verify attachment**: Look for agent chips in the UI
3. **Check permissions**: Ensure you have access to the agent

### Poor Response Quality
1. **Review personality settings**: Ensure they match your use case
2. **Update capabilities**: Add more specific capabilities
3. **Try different combinations**: Some personality traits work better together

### Agent Not Found
1. **Check spelling**: Verify @mention spelling
2. **Check visibility**: Ensure the agent is public or you own it
3. **Refresh the page**: Sometimes a refresh resolves connection issues

## Next Steps

### Explore Advanced Features
- **[Architecture Overview](./architecture/overview.md)**: Understand how agents work
- **[Function Calling](./tools/function-calling.md)**: Learn about agent tools
- **[API Reference](./integration/api-reference.md)**: Integrate agents programmatically

### Join the Community
- Share your creative agent configurations
- Learn from other users' agent designs
- Report bugs or suggest improvements

## FAQ

**Q: How many agents can I create?**
A: Current limits depend on your subscription plan. Check your account settings for specific limits.

**Q: Can agents remember previous conversations?**
A: Yes! Agents have persistent memory and can reference past interactions.

**Q: Can I share my agents with others?**
A: Yes, you can make agents public for others to discover and use.

**Q: Do agents cost credits to use?**
A: Agent responses use the same credit system as regular AI interactions.

**Q: Can agents use external tools?**
A: Yes! Agents can use function calling to access external APIs, databases, and services.

---

**Ready to build something amazing?** Start creating your first agent and join the revolution in AI-powered assistance! 

For more advanced topics, continue to the [Architecture section](./architecture/) or explore the [Tools & Integration](./tools/) guides. 