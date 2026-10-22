# Error Handling

Comprehensive guide to error handling in the Bike4Mind API, including error codes, response formats, and troubleshooting.

## Error Response Format

All API errors follow a standardized format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error description",
    "details": {
      "field": "additional context",
      "timestamp": "2024-01-15T10:30:00Z"
    }
  }
}
```

## HTTP Status Codes

| Code | Description | Usage |
|------|-------------|--------|
| 200 | Success | Successful GET, PUT operations |
| 201 | Created | Successful POST operations |
| 204 | No Content | Successful DELETE operations |
| 400 | Bad Request | Invalid request format or parameters |
| 401 | Unauthorized | Invalid or missing authentication |
| 403 | Forbidden | Insufficient permissions |
| 404 | Not Found | Resource does not exist |
| 409 | Conflict | Resource already exists or state conflict |
| 422 | Validation Error | Request data validation failed |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Server-side error |

## Authentication Errors (401)

### Invalid Token
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid or expired token"
  }
}
```

### Missing Token
```json
{
  "error": {
    "code": "MISSING_TOKEN",
    "message": "Authorization header is required"
  }
}
```

### Token Expired
```json
{
  "error": {
    "code": "TOKEN_EXPIRED",
    "message": "JWT token has expired",
    "details": {
      "expiredAt": "2024-01-15T10:30:00Z"
    }
  }
}
```

## Authorization Errors (403)

### Insufficient Permissions
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Insufficient permissions for this operation",
    "details": {
      "required": "create:notebook",
      "userPermissions": ["read:notebook"]
    }
  }
}
```

### Organization Access Denied
```json
{
  "error": {
    "code": "ORG_ACCESS_DENIED",
    "message": "Access denied to organization resources",
    "details": {
      "organizationId": "org_123"
    }
  }
}
```

## Validation Errors (422)

### Single Field Error
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input parameters",
    "details": {
      "field": "email",
      "issue": "Invalid email format"
    }
  }
}
```

### Multiple Field Errors
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Multiple validation errors",
    "details": [
      {
        "field": "email",
        "message": "Email is required"
      },
      {
        "field": "password",
        "message": "Password must be at least 8 characters"
      }
    ]
  }
}
```

## Resource Errors (404)

### Resource Not Found
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "The requested resource was not found",
    "details": {
      "resource": "user",
      "id": "user_123"
    }
  }
}
```

### Endpoint Not Found
```json
{
  "error": {
    "code": "ENDPOINT_NOT_FOUND",
    "message": "API endpoint does not exist",
    "details": {
      "path": "/api/invalid-endpoint",
      "method": "GET"
    }
  }
}
```

## Rate Limiting Errors (429)

### Rate Limit Exceeded
```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests",
    "details": {
      "limit": 100,
      "window": "1 minute",
      "resetAt": "2024-01-15T10:31:00Z"
    }
  }
}
```

## Agent-Specific Errors

### Agent Not Found
```json
{
  "error": {
    "code": "AGENT_NOT_FOUND",
    "message": "The specified agent could not be found",
    "details": {
      "agentId": "agent_123"
    }
  }
}
```

### Agent Already Attached
```json
{
  "error": {
    "code": "AGENT_ALREADY_ATTACHED",
    "message": "Agent is already attached to this session",
    "details": {
      "agentId": "agent_123",
      "sessionId": "session_456"
    }
  }
}
```

### Agent Limit Exceeded
```json
{
  "error": {
    "code": "AGENT_LIMIT_EXCEEDED",
    "message": "Maximum number of agents exceeded",
    "details": {
      "limit": 5,
      "current": 5
    }
  }
}
```

## Subscription Errors

### Subscription Required
```json
{
  "error": {
    "code": "SUBSCRIPTION_REQUIRED",
    "message": "This feature requires an active subscription",
    "details": {
      "feature": "advanced_agents",
      "requiredTier": "pro"
    }
  }
}
```

### Credit Insufficient
```json
{
  "error": {
    "code": "INSUFFICIENT_CREDITS",
    "message": "Not enough credits to perform this operation",
    "details": {
      "required": 100,
      "available": 25
    }
  }
}
```

## Server Errors (500)

### Internal Server Error
```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An internal server error occurred",
    "details": {
      "requestId": "req_123456",
      "timestamp": "2024-01-15T10:30:00Z"
    }
  }
}
```

### Service Unavailable
```json
{
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "Service temporarily unavailable",
    "details": {
      "service": "ai_inference",
      "retryAfter": 30
    }
  }
}
```

## Rate Limit Headers

When rate limits are approached or exceeded, responses include these headers:

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 5
X-RateLimit-Reset: 1642284600
X-RateLimit-Retry-After: 60
```

## Error Handling Best Practices

### Client-Side Handling

```typescript
async function handleApiCall(endpoint: string, options: RequestInit) {
  try {
    const response = await fetch(endpoint, options);
    
    if (!response.ok) {
      const error = await response.json();
      
      switch (error.error.code) {
        case 'TOKEN_EXPIRED':
          // Refresh token and retry
          await refreshToken();
          return handleApiCall(endpoint, options);
          
        case 'RATE_LIMIT_EXCEEDED':
          // Wait and retry
          const retryAfter = error.details.retryAfter || 60;
          setTimeout(() => handleApiCall(endpoint, options), retryAfter * 1000);
          return;
          
        case 'INSUFFICIENT_CREDITS':
          // Redirect to billing
          window.location.href = '/billing';
          return;
          
        default:
          // Show error to user
          showErrorMessage(error.error.message);
          throw new Error(error.error.message);
      }
    }
    
    return response.json();
  } catch (error) {
    console.error('API call failed:', error);
    throw error;
  }
}
```

### Retry Logic

```typescript
async function apiCallWithRetry(
  endpoint: string, 
  options: RequestInit, 
  maxRetries: number = 3
) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await handleApiCall(endpoint, options);
    } catch (error) {
      if (attempt === maxRetries) throw error;
      
      // Exponential backoff
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

### Error Logging

```typescript
function logError(error: any, context: any) {
  const errorData = {
    message: error.error?.message || error.message,
    code: error.error?.code,
    details: error.error?.details,
    context,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    url: window.location.href
  };
  
  // Send to logging service
  console.error('API Error:', errorData);
  
  // Optional: Send to error tracking service
  // errorTracker.captureError(errorData);
}
```

## Troubleshooting Guide

### Common Issues

**401 Unauthorized**
- Check if JWT token is included in Authorization header
- Verify token hasn't expired
- Ensure token is properly formatted: `Bearer <token>`

**403 Forbidden**
- Verify user has required permissions
- Check organization membership
- Confirm subscription tier supports the feature

**422 Validation Error**
- Review request body format
- Check required fields are present
- Validate data types and formats

**429 Rate Limited**
- Implement exponential backoff
- Check rate limit headers
- Consider caching responses to reduce calls

**500 Internal Error**
- Retry the request after a delay
- Check API status page
- Contact support if persistent

### Getting Help

If you encounter persistent errors:

1. Check [GitHub Discussions](https://github.com/bike4mind/bike4mind/discussions) for known issues
2. Review your API usage patterns
3. Contact support with the error details and request ID
4. Include relevant request/response data (without sensitive information)