# API Documentation

Welcome to the Bike4Mind API documentation. This section provides comprehensive information about our RESTful API, including authentication, endpoints, and integration examples.

## Overview

The Bike4Mind API is built with Next.js API routes and follows RESTful principles. It features:

- **JWT-based authentication** for secure access
- **CASL-based authorization** with fine-grained permissions
- **Comprehensive error handling** with standardized responses
- **Rate limiting** to ensure fair usage
- **WebSocket support** for real-time features

## Two API surfaces

Bike4Mind exposes two API surfaces - pick the one that fits your use case:

- **[Completions API](./completions/)** (recommended for programmatic access) - a standalone, API-key-authenticated endpoint (`b4m_live_...` keys, created from the Profile menu -> More -> API Keys) for chat completions, streaming, and tools. Start here if you want to call Bike4Mind from your own code.
- **Platform REST API** (documented below) - the same JWT-authenticated API the web app uses internally: agents, sessions, users, organizations. Useful for understanding the platform or extending it; tokens come from the app's login session.

## Getting Started

1. **Authentication**: Platform API requests require a valid JWT token; the [Completions API](./completions/) uses API keys
2. **Base URL**: `https://app.bike4mind.com/api` (or your own instance's domain)
3. **Content Type**: Most endpoints accept and return JSON
4. **Rate Limits**: Various limits apply per endpoint type

## API Sections

- [**Authentication & Authorization**](./auth) - JWT tokens, permissions, and security
- [**Core API Reference**](./reference) - Complete endpoint documentation
- [**Agent System**](./agents) - AI agent management and interaction
- [**Error Handling**](./errors) - Error codes and troubleshooting
- [**SDKs & Examples**](./examples) - Code samples and integration guides

## Quick Example

```bash
curl -N -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "Authorization: Bearer $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-5", "messages": [{"role": "user", "content": "Hello!"}]}'
```

The response is a stream of server-sent events. For every field and status code, see the [API reference](https://app.bike4mind.com/api/v1/docs).

For detailed examples and SDK usage, see our [Examples section](./examples).