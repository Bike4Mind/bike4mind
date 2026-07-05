# DocumentDB Compatibility Notes

## Registration Invites - Sparse Email Index

### Issue
When using DocumentDB instead of MongoDB, creating multiple registration invites without email addresses fails with:
```
E11000 duplicate key error collection: registrationinvites index: email_1
```

### Root Cause
- MongoDB allows multiple `null` values in a field with a unique index when using `sparse: true`
- **DocumentDB does NOT properly support sparse unique indexes** - it still enforces uniqueness on null values
- When bulk generating invite codes (without emails), multiple documents try to insert with `email: null/undefined`

### Solution
Remove the unique constraint from the email field entirely:

1. **Schema Update**: Removed `unique: true` from the email field
2. **No Index**: No index created on email field
3. **Migration**: Created migration `20250730000000-registration-invite-sparse-email-index.ts` to drop existing email index
4. **Application Logic**: Handle email uniqueness at application level when needed

### Implementation
```typescript
// In RegistrationInviteSchema
email: {
  type: String,
  required: false,
  // No unique constraint - DocumentDB doesn't handle sparse indexes like MongoDB
}

// No index on email field
// The 'code' field ensures uniqueness for each invite
```

### Why This Works
- Registration invites are uniquely identified by their `code` field
- Email is optional and only used for specific invitation flows
- Removing the unique constraint allows bulk creation of invites without emails
- Email uniqueness can be enforced at the application level when actually needed

### Testing
After deploying:
1. Run the migration: `pnpm migrate up`
2. Test bulk invite creation in admin panel
3. Verify individual invites with emails still work correctly
