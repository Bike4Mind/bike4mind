---
title: File Management
description: Upload, view, tag, and delete platform files through the admin file management interface
sidebar_position: 32
tags: [admin, files, storage]
---

# File Management

The File Management tab (listed as "Files" in the admin sidebar) allows administrators to upload files to the platform, view all uploaded files, manage file tags, and delete files. It uses a drag-and-drop file upload interface and displays files in a searchable table.

## Uploading Files

The top of the tab features a FilePond drag-and-drop upload area. Files can be uploaded by:

- Dragging and dropping files onto the upload area
- Clicking the "Browse" link to open a file picker

Up to 3 files can be uploaded simultaneously. Each upload tracks progress and supports cancellation. Files are uploaded with the `FILE` knowledge type and are associated with the current user.

If an upload fails, an error toast notification is displayed with the error message. User-initiated cancellations are handled silently without error messages.

## File Table

Below the upload area, all platform files are displayed in a table with real-time updates (the table auto-refreshes when file updates are detected via collection subscriptions).

| Column | Description |
|--------|-------------|
| **File Name** | The original name of the uploaded file |
| **File Path** | The storage path of the file |
| **File Size** | Human-readable file size (e.g., "1.2 MB") |
| **Tags** | Tag chips associated with the file, with an edit button to modify tags |
| **Uploaded By** | The name and email of the user who uploaded the file |
| **Uploaded At** | The upload date in localized format |
| **Upload Status** | Current processing status (shows a spinner for "pending" status) |
| **Actions** | Delete button for the file |

A file count is displayed above the table showing the total number of files.

A linear progress bar appears at the top of the table when data is being fetched.

## Managing Tags

Each file row displays its current tags as chips. Click the edit (pencil) icon next to the tags to open the Edit Tag modal, which allows adding, removing, or modifying tags associated with the file.

## Deleting Files

Click the **Delete** button on any file row. A confirmation modal appears asking "Are you sure you want to delete this file?" with options to confirm or cancel. The delete button shows a loading state while the deletion is in progress. A success toast notification appears after successful deletion.

## Best Practices

- Use descriptive tags on uploaded files to make them easier to find and categorize.
- Monitor the Upload Status column for files stuck in "pending" state, which may indicate processing issues.
- Clean up unused files periodically to manage storage usage.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Navigation and layout
