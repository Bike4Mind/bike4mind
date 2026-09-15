---
sidebar_position: 99
title: "React Artifacts and Content Security Policy"
description: "How Bike4Mind renders React artifacts safely under a Content Security Policy, and what developers need to know about CSP constraints."
content_type: ["conceptual", "reference"]
feature_status: beta
audience: ["developers"]
spiciness: medium
visibility: public
maturity: approved
related_features: ["features"]
tags: ["features", "api", "security", "performance", "react", "artifacts"]
last_reviewed: 2025-06-30
---

# React Artifacts and Content Security Policy

## Overview

The React Artifact Viewer allows you to create and preview React components in real-time. However, in production environments with strict Content Security Policy (CSP), JSX transformation may be blocked for security reasons.

## Writing CSP-Safe React Components

If you encounter CSP errors when previewing React components, you can write components using `React.createElement()` instead of JSX syntax.

### Example: Counter Component

#### JSX Version (May be blocked by CSP)
```jsx
const Counter = () => {
  const [count, setCount] = React.useState(0);
  
  return (
    <div style={{ padding: '20px', textAlign: 'center' }}>
      <h1>Counter</h1>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
      <button onClick={() => setCount(0)}>Reset</button>
    </div>
  );
};

export default Counter;
```

#### CSP-Safe Version (Works everywhere)
```javascript
const Counter = () => {
  const [count, setCount] = React.useState(0);
  
  return React.createElement(
    'div',
    { style: { padding: '20px', textAlign: 'center' } },
    React.createElement('h1', null, 'Counter'),
    React.createElement('p', null, 'Count: ', count),
    React.createElement(
      'button',
      { onClick: () => setCount(count + 1) },
      'Increment'
    ),
    React.createElement(
      'button',
      { onClick: () => setCount(0) },
      'Reset'
    )
  );
};

export default Counter;
```

## React.createElement() Syntax

```javascript
React.createElement(type, props, ...children)
```

- **type**: Element type ('div', 'button', etc.) or React component
- **props**: Object with properties (or null)
- **children**: Child elements or text content

## Security Features

The React Artifact Viewer runs components in an isolated sandbox with:

- **No network access**: Cannot make API calls or fetch external resources
- **No cookie/storage access**: Cannot read user data or authentication
- **No parent window access**: Cannot interact with the main application
- **Restricted permissions**: Limited to script execution and modals only

## Edit Mode

When editing React artifacts, you must explicitly enable "Edit Mode" which:
1. Shows a security warning about potential risks
2. Allows you to modify the component code
3. Only affects your own browser session
4. Cannot harm other users or the backend

## Best Practices

1. **Test locally first**: Develop components in your local environment
2. **Use trusted code**: Only paste code from trusted sources
3. **Monitor performance**: Watch for infinite loops or excessive memory usage
4. **Keep it simple**: Complex components may be harder to debug in the sandbox 