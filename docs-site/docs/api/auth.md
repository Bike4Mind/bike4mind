# Authentication & Authorization

The Bike4Mind API uses JWT (JSON Web Tokens) for authentication and CASL (Condition Accessible Subject List) for fine-grained authorization.

## Authentication

### JWT Token Authentication

All API requests require a valid JWT token in the Authorization header:

```http
Authorization: Bearer <your-jwt-token>
```

### Getting a Token

Tokens are obtained through the authentication flow in the main application. The token contains:

- User identity and permissions
- Organization membership
- Subscription tier information
- Expiration timestamp

### Token Validation

The API middleware automatically:
1. Validates the JWT signature
2. Checks token expiration
3. Extracts user context (`req.user`)
4. Builds permission context (`req.ability`)

## Authorization

### Permission System

Bike4Mind uses CASL for authorization, providing granular control over what users can access:

```typescript
// Example permission check in API handler
if (!req.ability.can('create', 'Notebook')) {
  throw new ForbiddenError('Insufficient permissions');
}
```

### Permission Levels

- **Admin**: Full system access
- **Organization Owner**: Full access within organization
- **Member**: Standard user permissions
- **Viewer**: Read-only access

### Resource-Based Permissions

Permissions are evaluated against specific resources:

- **Users**: Profile management, organization membership
- **Organizations**: CRUD operations, member management
- **Content**: Notebooks, files, sessions
- **API Keys**: Service integrations
- **Subscriptions**: Billing and plan management

## Optional Authentication

Some endpoints support optional authentication for public content:

```typescript
// Disable authentication for public endpoints
const handler = baseApi({ auth: false }).get(async (req, res) => {
  // Public endpoint logic
});
```

## Error Responses

### Authentication Errors (401)

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid or expired token"
  }
}
```

### Authorization Errors (403)

```json
{
  "error": {
    "code": "FORBIDDEN", 
    "message": "Insufficient permissions"
  }
}
```

## Best Practices

### Token Management
- Store tokens securely (httpOnly cookies recommended)
- Implement automatic token refresh
- Handle token expiration gracefully
- Never log or expose tokens in client-side code

### Permission Handling
- Always check permissions before operations
- Use specific permission checks (avoid broad access)
- Provide meaningful error messages
- Implement role-based fallbacks

### Security Considerations
- Use HTTPS for all API requests
- Implement rate limiting
- Monitor for suspicious activity
- Rotate tokens regularly