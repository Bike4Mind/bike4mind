---
title: Mementos - Intelligent Memory System
description: How Bike4Mind remembers important information from your conversations
sidebar_position: 4
tags: [mementos, memory, ai, conversations]
---

# Mementos - Intelligent Memory System

*(Experimental Feature — enable in [Profile > Settings > Experimental Features](./profile-settings.md#experimental-features))*

> **Availability:** This feature may be enabled or disabled at the organizational level by your administrator. If the toggle is grayed out with "Disabled by administrator," contact your organization admin to request access.

Mementos is Bike4Mind's intelligent memory system that automatically captures, organizes, and recalls important information from your conversations. Like a personal assistant with perfect memory, it ensures that valuable insights, decisions, and context are never lost.

## How to Enable and Access

1. Click your **avatar** in the sidebar footer to open your Profile
2. Go to the **Settings** tab
3. Scroll to **Experimental Features** and toggle **Mementos** on

Once enabled, a **Mementos** tab appears in your Profile where you can view, manage, and delete individual memories. The AI will automatically start capturing and recalling mementos in your conversations.

## What are Mementos?

Mementos are AI-curated memories extracted from your conversations. They:
- **Capture** important facts, decisions, and insights automatically
- **Organize** information with smart tagging and relevance scoring
- **Recall** relevant memories when needed in future conversations
- **Evolve** over time based on usage and importance

## How Mementos Work

### Automatic Memory Creation
When you have conversations with Bike4Mind, the AI:
1. **Identifies** important information worth remembering
2. **Evaluates** the significance (scored 0-10)
3. **Summarizes** the key points concisely
4. **Tags** the memory for easy retrieval
5. **Stores** it in your personal memory bank

### Memory Tiers

Mementos are organized into three tiers based on relevance and recency:

#### 🔥 Hot Tier
- Most recent and frequently accessed memories
- Automatically injected into conversation context
- Highest priority for recall
- Limited capacity to maintain performance

#### 🌡️ Warm Tier
- Important but less frequently accessed
- Available for manual recall
- Medium priority
- Larger capacity than hot tier

#### ❄️ Cold Tier
- Archived memories for long-term storage
- Rarely accessed but preserved
- Lowest priority
- Unlimited capacity

### Intelligent Recall

Mementos are automatically recalled when:
- The current conversation relates to stored information
- You ask questions about past discussions
- Context would be helpful for the AI's response
- Patterns emerge across multiple conversations

## Types of Information Saved

### Automatically Captured
- **Key Decisions**: "We decided to use React for the frontend"
- **Important Facts**: "The project deadline is March 15th"
- **Personal Preferences**: "User prefers dark mode interfaces"
- **Technical Details**: "The API endpoint is https://api.example.com/v2"
- **Insights & Learnings**: "Performance improved 40% after optimization"

### Examples of Mementos
```
[Memory] Project Architecture Decision
Context: In our discussion about the new app, we decided to use a 
microservices architecture with Docker containers. The main services 
will be: auth-service, user-service, and payment-service.
Tags: #architecture #project #microservices #docker
Score: 8.5

[Memory] User Preference - Code Style
Context: User prefers TypeScript with strict mode enabled and uses 
ESLint with Airbnb configuration. They like explicit type annotations 
even when TypeScript can infer them.
Tags: #preferences #typescript #coding-style
Score: 7.0
```

## Managing Mementos

### Manual Controls
While Mementos work automatically, you can also:
- **Create**: Explicitly save important information
- **Edit**: Update or refine existing memories
- **Delete**: Remove outdated or incorrect memories
- **Search**: Find specific memories by content or tags

### Memory Limits
To maintain optimal performance:
- Hot tier: ~50 active memories
- Warm tier: ~200 memories
- Cold tier: Unlimited
- Automatic tier management based on usage

### Privacy & Security
- Mementos are private to your account
- End-to-end encrypted storage
- Never shared between users
- Full export/delete capabilities

## Best Practices

### Maximize Memento Value

1. **Be Explicit**: When making important decisions, state them clearly
2. **Provide Context**: Include why decisions were made
3. **Use Consistent Terms**: Helps with memory association
4. **Review Periodically**: Check and update memories as needed

### When to Create Manual Mementos

Create manual memories for:
- Project specifications
- Personal preferences
- Team decisions
- Important URLs or credentials (encrypted)
- Custom instructions for the AI

### Memory Hygiene

Regularly:
- Review hot tier memories
- Archive outdated information
- Update changed details
- Remove duplicate memories

## Advanced Features

### Smart Tagging
Mementos are automatically tagged with:
- Topic categories (#project, #personal, #technical)
- Entities mentioned (@john, @company-name)
- Technologies (#react, #python, #aws)
- Time references (#deadline, #milestone)

### Relevance Scoring
Each memory receives a score (0-10) based on:
- Explicit importance markers
- Frequency of related topics
- User interaction patterns
- Recency and context

### Cross-Session Learning
Mementos enable:
- Continuity across sessions
- Pattern recognition
- Preference learning
- Context accumulation

## Use Cases

### Project Management
- Track decisions across long projects
- Remember team member preferences
- Maintain context between meetings
- Document evolving requirements

### Learning & Research
- Build knowledge incrementally
- Connect insights across topics
- Track learning progress
- Create personal knowledge base

### Personal Assistant
- Remember your preferences
- Track important dates
- Maintain to-do context
- Store quick references

### Technical Documentation
- Capture code patterns
- Remember API details
- Track bug solutions
- Document system configurations

## Integration with Other Features

### With Quest Master
- Quest results saved as memories
- Context carried between quests
- Learning from quest patterns

### With Projects
- Project-specific memory contexts
- Shared team memories (coming soon)
- Project documentation building

### With Knowledge Base
- Memories reference uploaded documents
- Automatic linking between memories and files
- Enhanced context understanding

## Tips for Effective Use

1. **Trust the System**: Let automatic capture work
2. **Be Descriptive**: Clear communication helps memory creation
3. **Use Natural Language**: No special syntax required
4. **Iterate**: Memories improve with use
5. **Provide Feedback**: Correct inaccurate memories

## Memory Commands

While Mementos work automatically, you can use phrases like:
- "Remember that..." - Explicit memory creation
- "What do you remember about..." - Memory recall
- "Update the memory about..." - Memory modification
- "Forget about..." - Memory deletion
- "Show me memories about..." - Memory search

## Future Enhancements

- **Shared Team Memories**: Collaborative memory spaces
- **Memory Templates**: Structured memory formats
- **External Integration**: Sync with other tools
- **Advanced Analytics**: Memory usage insights
- **Voice Memories**: Audio note support

---

## Related Features

- [Notebooks](./notebooks.md) - Where memories are created
- [Profile & Settings](./profile-settings.md) - Manage your mementos
- [Quest Master](./quest-master.md) - Quest results saved as memories
- [Knowledge Management](./knowledge-management.md) - Link memories to documents