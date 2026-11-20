---
title: Identity Providers
description: Admin tab for configuring SAML and Okta SSO identity providers with email domain mapping
sidebar_position: 25
tags: [admin, identity, saml, okta, sso]
---

# Identity Providers

The Identity Providers tab in the admin panel allows administrators to configure Single Sign-On (SSO) integrations using SAML or Okta. Each identity provider is mapped to an email domain, enabling automatic SSO routing based on the user's email address.

## Provider List

The main view displays a table of all configured identity providers:

| Column | Description |
|--------|-------------|
| **Name** | The display name of the provider (e.g., "My Company SSO") |
| **Email domain** | The email domain mapped to this provider (e.g., `company.com`) |
| **Type** | SAML or OKTA |
| **Status** | Active (green) or Inactive (neutral) |
| **Created** | The date the provider was created |

Each row has a **...** actions menu with **View SP metadata** (SAML only), **Edit provider** and **Delete provider**.

When no providers are configured, the page shows an empty state with an **Add identity provider** button.

## Adding a Provider

Click the "Add identity provider" button to open the configuration dialog. The form includes common fields and type-specific configuration sections.

### Common Fields

| Field | Description |
|-------|-------------|
| **Name** | A human-readable name for the provider |
| **Email Domain** | The email domain to associate with this provider (e.g., `company.com`). Users with this email domain will be routed to this SSO provider. |
| **Type** | Select between SAML and Okta |
| **Active** | Toggle to enable or disable the provider |

### SAML Configuration

When the type is set to SAML, the following fields are displayed:

| Field | Description |
|-------|-------------|
| **Entry Point (SSO URL)** | The Identity Provider's SSO URL where SAML authentication requests are sent (e.g., `https://idp.company.com/saml/sso`) |
| **Issuer** | The Entity ID of the Identity Provider (e.g., `https://idp.company.com`) |
| **Certificate** | The X.509 certificate from the Identity Provider, used to verify SAML response signatures. Paste the full PEM-encoded certificate including the BEGIN/END markers. |

The default identifier format is `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`. Default attribute mappings are:

| Attribute | Default Mapping |
|-----------|----------------|
| `email` | `email` |
| `firstName` | `firstName` |
| `lastName` | `lastName` |
| `name` | `name` |

### Okta Configuration

When the type is set to Okta, the following fields are displayed:

| Field | Description |
|-------|-------------|
| **Audience (Okta Domain)** | The Okta organization URL (e.g., `https://company.okta.com`) |
| **Client ID** | The OAuth client ID from the Okta application |
| **Client Secret** | The OAuth client secret (hidden by default; toggle visibility with the eye icon) |
| **Use Org-Level Authorization Server** | Checkbox to use the organization-level authorization server. When checked, the discovery URL uses `https://domain/.well-known/...` format. |
| **Authorization Server ID** | Optional. The custom authorization server ID (defaults to `default`). This field is disabled when "Use Org-Level Authorization Server" is checked. |

## Editing a Provider

Open the row's actions menu and choose **Edit provider** to reopen the configuration dialog pre-populated with the existing values. All fields can be modified. Click "Save changes" to save them.

## Deleting a Provider

Open the row's actions menu and choose **Delete provider**. A **Delete identity provider** dialog names the provider and warns that users whose email domain matches it lose single sign-on. To delete it:

1. Pick a reason or write one of at least 5 characters. The reason is not stored yet; the admin audit log records the deletion without it.
2. Type the provider's name exactly as shown.
3. Click **Delete provider**.

The deletion cannot be undone. If it fails, an error message appears and the dialog stays open so you can try again. To stop a provider without losing its configuration, open **Edit provider** and turn **Active** off instead.

## Service Provider (SP) Metadata

For SAML providers, open the row's actions menu and choose **View SP metadata** to view the Service Provider metadata. This dialog provides the values needed to configure the Identity Provider side of the integration:

| Field | Value | Description |
|-------|-------|-------------|
| **ACS URL** | `{origin}/api/auth/saml/callback` | Assertion Consumer Service URL where the IdP sends SAML responses |
| **Entity ID** | `{origin}/saml/metadata` | The Service Provider identifier |
| **Start URL** | `{origin}/new` | Optional post-login redirect URL |
| **SAML Initiation URL** | `{origin}/api/auth/saml?idp={id}` | Direct SAML authentication URL for testing |

Each field has a Copy button for easy clipboard access.

### IdP Configuration Instructions

The SP Metadata dialog includes step-by-step instructions:

1. Copy the ACS URL and paste it as the "ACS URL" in your IdP configuration
2. Copy the Entity ID and paste it as the "Entity ID" or "SP Identifier"
3. Optionally, set the Start URL for post-login redirects
4. Ensure the Name ID format is set to "Email Address" or "Persistent"
5. Configure attribute mappings if needed (email, firstName, lastName)
6. For testing, use the SAML Initiation URL instead of the generic callback URL
7. If your IdP supports RelayState, set it to `idp={providerId}` to help identify the provider

## Best Practices

- Map each identity provider to a specific email domain so that user authentication is routed automatically based on their email address.
- Keep the provider's Active toggle disabled while configuring a new integration. Enable it only after verifying the SAML or Okta configuration is correct.
- For SAML providers, use the SAML Initiation URL from the SP Metadata dialog for initial testing before relying on IdP-initiated flows.
- Store Okta client secrets securely. The admin panel masks the client secret by default; use the visibility toggle only when needed.
- When using Okta with a custom authorization server, ensure the Authorization Server ID matches the one configured in your Okta admin console. Leave it blank to use the "default" server.
- For organizations using the Okta Org-Level Authorization Server, check the corresponding checkbox -- this changes the discovery URL format and disables the Authorization Server ID field.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel layout and navigation
- [Secrets Management](./secrets-management.md) - Managing system secrets and rotation
