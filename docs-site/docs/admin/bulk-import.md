---
title: Bulk User Import
description: Import multiple users at once via CSV file upload or pasted CSV data with configurable credits and storage
sidebar_position: 13
tags: [admin, import, users, csv]
---

# Bulk User Import

The Bulk User Import tab allows administrators to create multiple user accounts in a single operation by uploading a CSV file or pasting CSV data directly into the interface. Each imported user can be assigned custom starting credits and storage allocations.

## CSV Format

User data must follow a positional CSV format. There is no header row -- the system uses column position to determine field mapping.

| Position | Column | Required | Description |
|----------|--------|----------|-------------|
| 1 | **email** | Yes | The user's email address. Must contain `@` and `.` characters. |
| 2 | **first** | No | The user's first name. |
| 3 | **last** | No | The user's last name. |
| 4 | **startingCredits** | No | Initial credit balance (integer). Defaults to 0 if omitted or invalid. |
| 5 | **startingStorage** | No | Initial storage allocation in MB (integer). Defaults to 0 if omitted or invalid. |

### Example CSV

```
johnsmith@gmail.com,John,Smith,100,100
janedoe@example.com,Jane,Doe,500,200
user@company.com,,,250,50
```

## Input Methods

Two methods are available for providing CSV data:

| Method | Description |
|--------|-------------|
| **Upload CSV** | Click the "Upload CSV" button to select a `.csv` file from your local filesystem. The file is read and parsed client-side. |
| **Paste CSV** | Click the "Paste CSV" button to focus the text area, then paste CSV data directly. Parsing occurs as you type or paste. |

Both methods feed into the same parser. The most recently provided data is used.

## Email Validation

The system performs basic email validation during CSV parsing:

- Each email must contain an `@` symbol and a `.` character.
- If an invalid email is encountered, parsing stops and an error message is displayed identifying the problematic email.
- The Import button is disabled if any parsed row has an invalid or missing email.

## Preview

After CSV data is parsed successfully, a preview card displays the data in a table format showing all five columns. The preview header shows the total count of parsed users (e.g., "Preview (15 users)"). This allows administrators to verify the data before submitting the import.

The preview table has a maximum height of 400px with scrolling for large datasets.

## Importing

Click the **Import Users** button to submit all parsed users to the server. The button shows a loading state during the import process and is disabled while the operation is in progress or if any emails are invalid.

The import sends all users in a single batch request to the `/api/admin/bulk-create-users` endpoint.

## Results

After the import completes, a results card displays the outcome for each user in a table:

| Column | Description |
|--------|-------------|
| **Email** | The email address that was processed. |
| **Status** | Either "Success" or "Failed". |
| **Message** | For successful imports: "User created successfully". For failures: the specific error message explaining what went wrong. |

The results table has a maximum height of 400px with scrolling to accommodate large batches.

## Error Handling

Errors are displayed in a soft red alert box below the import controls. Common error scenarios include:

- Invalid email format during CSV parsing
- Server-side validation failures (e.g., duplicate emails)
- Network or authentication errors
- Detailed server error messages including HTTP status codes

After a successful import, the parsed user list is cleared. If errors occur, the error message remains visible until new data is provided.

## Best Practices

- Always review the preview table before clicking Import to verify that columns were parsed correctly.
- Use the CSV paste feature for quick imports of a few users; use file upload for larger batches.
- Include starting credits and storage values appropriate for the user's expected tier or promotional offering.
- After importing, check the results table carefully for any individual failures that may require manual follow-up.
- Keep a copy of your CSV data in case any users need to be re-imported due to transient errors.

## Related Articles

- [Subscribers](./subscribers.md)
- [Invite Codes](./invite-codes.md)
- [Credit Analytics](./credit-analytics.md)
