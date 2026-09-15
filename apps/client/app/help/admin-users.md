# Admin Users Help Guide

## Overview
The Admin Users dashboard provides comprehensive management capabilities for user accounts, permissions, and subscriptions in the Bike4Mind platform.

---

## User Details Section

### Basic Information
- **Name**: The user's display name shown throughout the platform
- **Username**: Unique identifier for login and system references
- **Email**: Primary contact email for notifications and password resets
- **Organization**: The organization the user belongs to (affects access to shared resources)

### Quick Actions
- **Reset Password**: Send a password reset link to the user's email
- **Grant Subscription**: Manually grant subscription access with custom duration

---

## Permissions Section

### User Level
Controls the user's access tier in the system. Click to cycle through levels:

| Level | Description | Permissions |
|-------|-------------|------------|
| **Demo User** | Trial account with limited features | Basic access, limited credits |
| **Paid User** | Standard subscription | Full feature access, standard credits |
| **VIP User** | Premium subscription | Priority support, increased limits |
| **Manager User** | Team management capabilities | Can manage team members |
| **Admin User** | Full administrative access | All system permissions |

### Super Admin
- **When enabled**: Grants system-wide administrative privileges
- **Use with caution**: Super Admins can modify all system settings and user data

### User Tags
Tags provide fine-grained permission control and user categorization:

#### Predefined Tags
- **Developer**: Access to API keys and development tools
- **Analyst**: Access to analytics and reporting features
- **Customer**: Standard customer features and support

#### Custom Tags
- Add custom tags for specialized access control
- Tags can be used for feature flags and conditional access
- Separate multiple tags with commas when adding

---

## Subscription Status

### User Credits
- **Current Credits**: Available credits for AI operations
- **19,999**: Default allocation for new users
- Credits are consumed by AI model usage and operations

### Subscription Types

#### Individual Subscriptions
- Personal subscription tied to the user account
- Shows active plan, billing cycle, and expiration date

#### Team Subscriptions
- Shared subscription through organization membership
- Inherits benefits from organization's subscription plan

---

## B4M Settings

### Storage Limits
- **Storage Limit**: Maximum storage allocation in MB
- **Current Usage**: Real-time storage consumption

### Date Fields
- **Format**: mm/dd/yyyy for all date inputs
- Used for subscription management and tracking

### Credits Management
- **User Credits**: Manual credit adjustment for the user
- **Credit Purchase Date**: Last time credits were purchased

---

## Activity & Profile

### Login Information
- **Last Login**: Most recent successful authentication
- **Last Active**: Latest platform activity timestamp
- **Login Records**: Historical login data with device/location info

### Activity Metrics
- **Created**: Account creation date
- **Updated**: Last profile modification

### Profile Actions
- **View Profile**: Open detailed user profile modal
- **Admin Profile**: Access advanced administrative settings

---

## Admin Actions

### User Moderation

#### Ban User
- **Effect**: Immediately blocks all access to the platform
- **Reversible**: Can be undone by unchecking the ban status
- **Use for**: Terms of Service violations, security concerns

#### Moderate User
- **Effect**: Restricts certain platform features
- **Purpose**: Temporary limitation for policy review
- **Common uses**: Content moderation, behavior warnings

### Delete User
- **Warning**: This action is **PERMANENT** and cannot be undone
- **Process**: Requires typing "DELETE" to confirm
- **Effects**: 
  - Removes all user data
  - Cancels active subscriptions
  - Deletes associated content

---

## Quick Actions Bar

### Login as User
- Temporarily access the platform as the selected user
- Useful for debugging user-reported issues
- Your admin session remains active in the background

### Send Message
- Send system notifications directly to the user
- Messages appear in the user's inbox
- Useful for:
  - Important announcements
  - Account notifications
  - Support communications

### Save Changes
- Appears when fields have been modified
- Saves all pending changes at once
- Changes are applied immediately upon save

---

## Best Practices

1. **Regular Audits**: Review user permissions quarterly
2. **Principle of Least Privilege**: Grant only necessary permissions
3. **Documentation**: Use user notes to track administrative actions
4. **Communication**: Notify users before major account changes
5. **Security**: Never share or expose user credentials

---

## Common Tasks

### Upgrading a User
1. Click the User Level button to cycle through levels
2. Or manually set specific permissions with tags
3. Click "Save Changes" to apply

### Handling Support Requests
1. Use "Login as User" to reproduce issues
2. Document findings in user notes
3. Communicate resolution via System Message

### Managing Subscriptions
1. Use "Grant Subscription" for manual extensions
2. Check both Individual and Team subscription status
3. Monitor credit usage for unusual patterns

---

## Troubleshooting

### User Can't Login
- Check if account is banned or moderated
- Verify email is correct
- Use "Reset Password" if needed

### Missing Features
- Verify user level is appropriate
- Check organization membership
- Review user tags for required permissions

### Credit Issues
- Check current credit balance
- Review credit purchase history
- Manually adjust if necessary

---

## Security Notes

- All administrative actions are logged
- Password resets generate secure tokens
- Login history tracks suspicious activity
- Regular security audits recommended

---

## Need More Help?

Contact the system administrator or refer to the complete platform documentation for additional assistance.