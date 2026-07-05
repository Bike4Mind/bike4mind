# Format Selection Feature Demo

This file contains various code snippets to test the format selection feature. Each snippet has more than 30 lines to trigger the format selection dialog.

## How to Test

1. Copy any code block below (make sure it's >30 lines)
2. Open a notebook session in Lumina5
3. Paste into the chat input
4. A dialog will appear asking you to select the format
5. The system should auto-detect the correct format
6. You can also change the format manually

---

## Test 1: Python Code (Should detect as Python)

```python
import os
import sys
from typing import List, Optional, Dict, Any
from dataclasses import dataclass
from datetime import datetime

@dataclass
class UserProfile:
    """Represents a user profile with various attributes."""
    id: str
    username: str
    email: str
    created_at: datetime
    preferences: Dict[str, Any]

    def __post_init__(self):
        if not self.email or '@' not in self.email:
            raise ValueError("Invalid email address")

    def to_dict(self) -> Dict[str, Any]:
        """Convert the profile to a dictionary."""
        return {
            'id': self.id,
            'username': self.username,
            'email': self.email,
            'created_at': self.created_at.isoformat(),
            'preferences': self.preferences
        }

class UserService:
    """Service for managing user profiles."""

    def __init__(self, database_url: str):
        self.database_url = database_url
        self.users: Dict[str, UserProfile] = {}

    def create_user(self, username: str, email: str) -> UserProfile:
        """Create a new user profile."""
        user_id = f"user_{len(self.users) + 1}"
        profile = UserProfile(
            id=user_id,
            username=username,
            email=email,
            created_at=datetime.now(),
            preferences={}
        )
        self.users[user_id] = profile
        return profile

    def get_user(self, user_id: str) -> Optional[UserProfile]:
        """Retrieve a user by ID."""
        return self.users.get(user_id)

    def update_preferences(self, user_id: str, preferences: Dict[str, Any]) -> bool:
        """Update user preferences."""
        user = self.get_user(user_id)
        if user:
            user.preferences.update(preferences)
            return True
        return False

def main():
    service = UserService("postgresql://localhost/users")
    user = service.create_user("alice", "alice@example.com")
    print(f"Created user: {user.username}")
```

---

## Test 2: TypeScript/React Code (Should detect as TypeScript)

```typescript
import React, { useState, useEffect, useCallback } from 'react';
import { Box, Button, TextField, Typography, Alert } from '@mui/material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

interface Task {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface TaskFormProps {
  onSubmit: (task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>) => void;
  initialValues?: Partial<Task>;
  isLoading?: boolean;
}

export const TaskForm: React.FC<TaskFormProps> = ({
  onSubmit,
  initialValues,
  isLoading = false,
}) => {
  const [title, setTitle] = useState(initialValues?.title || '');
  const [description, setDescription] = useState(initialValues?.description || '');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      if (!title.trim()) {
        setError('Title is required');
        return;
      }

      onSubmit({
        title: title.trim(),
        description: description.trim(),
        completed: initialValues?.completed || false,
      });

      setTitle('');
      setDescription('');
      setError(null);
    },
    [title, description, initialValues?.completed, onSubmit]
  );

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ maxWidth: 600, mx: 'auto', p: 3 }}>
      <Typography variant="h5" gutterBottom>
        {initialValues ? 'Edit Task' : 'Create New Task'}
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <TextField
        fullWidth
        label="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={isLoading}
        margin="normal"
        required
      />

      <TextField
        fullWidth
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={isLoading}
        margin="normal"
        multiline
        rows={4}
      />

      <Button
        type="submit"
        variant="contained"
        disabled={isLoading}
        sx={{ mt: 2 }}
      >
        {isLoading ? 'Saving...' : 'Save Task'}
      </Button>
    </Box>
  );
};
```

---

## Test 3: JSON Data (Should detect as JSON)

```json
{
  "users": [
    {
      "id": "user_001",
      "username": "alice_developer",
      "email": "alice@example.com",
      "profile": {
        "firstName": "Alice",
        "lastName": "Johnson",
        "avatar": "https://example.com/avatars/alice.png",
        "bio": "Full-stack developer passionate about open source",
        "location": "San Francisco, CA",
        "website": "https://alicejohnson.dev"
      },
      "preferences": {
        "theme": "dark",
        "notifications": {
          "email": true,
          "push": false,
          "inApp": true
        },
        "language": "en-US",
        "timezone": "America/Los_Angeles"
      },
      "roles": ["developer", "admin"],
      "createdAt": "2024-01-15T10:30:00Z",
      "lastLogin": "2024-10-24T08:45:22Z"
    },
    {
      "id": "user_002",
      "username": "bob_designer",
      "email": "bob@example.com",
      "profile": {
        "firstName": "Bob",
        "lastName": "Smith",
        "avatar": "https://example.com/avatars/bob.png",
        "bio": "UI/UX designer creating beautiful experiences",
        "location": "New York, NY",
        "website": "https://bobsmith.design"
      },
      "preferences": {
        "theme": "light",
        "notifications": {
          "email": true,
          "push": true,
          "inApp": true
        },
        "language": "en-US",
        "timezone": "America/New_York"
      },
      "roles": ["designer"],
      "createdAt": "2024-02-20T14:15:00Z",
      "lastLogin": "2024-10-23T16:20:10Z"
    }
  ],
  "metadata": {
    "version": "1.0.0",
    "generatedAt": "2024-10-24T12:00:00Z",
    "totalUsers": 2,
    "apiEndpoint": "https://api.example.com/v1"
  }
}
```

---

## Test 4: Markdown Documentation (Should detect as Markdown)

```markdown
# API Documentation

## Overview

This API provides comprehensive endpoints for managing user data, authentication, and content delivery.

### Base URL
```

https://api.example.com/v1

````

### Authentication

All API requests require authentication using Bearer tokens:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://api.example.com/v1/users
````

## Endpoints

### Users

#### GET /users

Retrieve a list of users.

**Query Parameters:**

- `page` (integer, optional): Page number (default: 1)
- `limit` (integer, optional): Items per page (default: 20)
- `sort` (string, optional): Sort field (default: 'createdAt')

**Response:**

```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100
  }
}
```

#### POST /users

Create a new user.

**Request Body:**

```json
{
  "username": "newuser",
  "email": "user@example.com",
  "password": "securepassword123"
}
```

**Response:**

```json
{
  "id": "user_123",
  "username": "newuser",
  "email": "user@example.com",
  "createdAt": "2024-10-24T12:00:00Z"
}
```

### Authentication

#### POST /auth/login

Authenticate a user and receive a token.

**Important:** Tokens expire after 24 hours.

## Rate Limiting

- **Free Tier:** 100 requests per hour
- **Pro Tier:** 1000 requests per hour
- **Enterprise:** Unlimited

## Error Codes

| Code | Description           |
| ---- | --------------------- |
| 400  | Bad Request           |
| 401  | Unauthorized          |
| 403  | Forbidden             |
| 404  | Not Found             |
| 500  | Internal Server Error |

````

---

## Test 5: CSS Styles (Should detect as CSS)

```css
/* Modern Component Styles */
:root {
  --primary-color: #3b82f6;
  --secondary-color: #8b5cf6;
  --success-color: #10b981;
  --danger-color: #ef4444;
  --warning-color: #f59e0b;
  --dark-bg: #1f2937;
  --light-bg: #f9fafb;
  --border-radius: 8px;
  --transition-speed: 0.3s;
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.75rem 1.5rem;
  font-size: 1rem;
  font-weight: 500;
  border: none;
  border-radius: var(--border-radius);
  cursor: pointer;
  transition: all var(--transition-speed) ease;
  box-shadow: var(--shadow-sm);
}

.button:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.button:active {
  transform: translateY(0);
  box-shadow: var(--shadow-sm);
}

.button--primary {
  background-color: var(--primary-color);
  color: white;
}

.button--primary:hover {
  background-color: #2563eb;
}

.card {
  background: white;
  border-radius: var(--border-radius);
  box-shadow: var(--shadow-md);
  padding: 1.5rem;
  margin-bottom: 1rem;
  transition: all var(--transition-speed) ease;
}

.card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-4px);
}

.card__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid #e5e7eb;
}

.card__title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--dark-bg);
}

.card__content {
  color: #6b7280;
  line-height: 1.6;
}

@media (max-width: 768px) {
  .card {
    padding: 1rem;
  }

  .button {
    width: 100%;
  }
}
````

---

## Test 6: Shell Script (Should detect as Shell Script)

```bash
#!/bin/bash

# Deployment script for web application
# Author: DevOps Team
# Version: 2.0.0

set -euo pipefail

# Configuration
ENVIRONMENT="${1:-staging}"
APP_NAME="my-web-app"
DOCKER_REGISTRY="registry.example.com"
DEPLOYMENT_DIR="/var/www/${APP_NAME}"
BACKUP_DIR="/var/backups/${APP_NAME}"
LOG_FILE="/var/log/${APP_NAME}/deploy.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "$LOG_FILE"
    exit 1
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1" | tee -a "$LOG_FILE"
}

# Pre-deployment checks
pre_deployment_checks() {
    log "Running pre-deployment checks..."

    # Check if Docker is running
    if ! docker info > /dev/null 2>&1; then
        error "Docker is not running"
    fi

    # Check disk space
    available_space=$(df -h / | awk 'NR==2 {print $4}' | sed 's/G//')
    if (( $(echo "$available_space < 10" | bc -l) )); then
        warning "Low disk space: ${available_space}GB available"
    fi

    log "Pre-deployment checks passed"
}

# Create backup
create_backup() {
    log "Creating backup..."

    timestamp=$(date +%Y%m%d_%H%M%S)
    backup_file="${BACKUP_DIR}/backup_${timestamp}.tar.gz"

    mkdir -p "$BACKUP_DIR"
    tar -czf "$backup_file" -C "$DEPLOYMENT_DIR" . || error "Backup failed"

    log "Backup created: $backup_file"
}

# Deploy application
deploy() {
    log "Starting deployment to ${ENVIRONMENT}..."

    # Pull latest image
    docker pull "${DOCKER_REGISTRY}/${APP_NAME}:${ENVIRONMENT}" || error "Failed to pull image"

    # Stop old container
    docker stop "${APP_NAME}" 2>/dev/null || true
    docker rm "${APP_NAME}" 2>/dev/null || true

    # Start new container
    docker run -d \
        --name "${APP_NAME}" \
        --restart always \
        -p 80:3000 \
        -v "${DEPLOYMENT_DIR}/data:/app/data" \
        "${DOCKER_REGISTRY}/${APP_NAME}:${ENVIRONMENT}" || error "Failed to start container"

    log "Deployment completed successfully"
}

# Health check
health_check() {
    log "Running health check..."

    max_attempts=30
    attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -f http://localhost/health > /dev/null 2>&1; then
            log "Health check passed"
            return 0
        fi

        attempt=$((attempt + 1))
        sleep 2
    done

    error "Health check failed after ${max_attempts} attempts"
}

# Main execution
main() {
    log "=== Starting deployment process ==="

    pre_deployment_checks
    create_backup
    deploy
    health_check

    log "=== Deployment completed successfully ==="
}

main "$@"
```

---

## Instructions

1. **Copy any code block above** (select the code inside the triple backticks)
2. **Paste into Lumina5 chat input**
3. **Observe the Format Selection Dialog** appearing
4. **Check the auto-detected format** - it should match the code type
5. **Try changing the format** to see the filename extension update
6. **Test the KnowledgeModal**: After creating a file, click on it to view/edit and change its format

## Expected Behavior

- Python code → Detects as "Python" (.py)
- TypeScript/React → Detects as "TypeScript" (.ts)
- JSON → Detects as "JSON" (.json)
- Markdown → Detects as "Markdown" (.md)
- CSS → Detects as "CSS" (.css)
- Shell Script → Detects as "Shell Script" (.sh)

You can also test changing formats manually to see how the file extension and syntax highlighting adapt!
