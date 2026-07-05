---
title: Chat History Import
description: Import your existing chat history from ChatGPT or Claude into Bike4Mind
sidebar_position: 12
tags: [import, chatgpt, claude, migration]
---

# Chat History Import

Bring your existing conversations from ChatGPT or Claude into Bike4Mind. Your chat history can be imported and continued as regular notebooks.

## Supported Sources

### OpenAI ChatGPT
- **Format**: OpenAI conversation export format
- **File Type**: ZIP file containing conversations.json
- **Import Method**: File upload or direct URL

### Anthropic Claude
- **Format**: Claude conversation export format  
- **File Type**: ZIP file containing conversation data
- **Import Method**: File upload or direct URL

## How to Import

### Accessing Import Feature
1. Open your user profile by clicking on your profile picture
2. Navigate to the **Settings** tab
3. Locate the **Import History** section
4. Click the **Import LLM History** button

### Import Process
1. **Select Source**: Choose between OpenAI or Claude using the toggle switch
2. **Upload Method**: Choose one of two options:
   - **File Upload**: Drag and drop your ZIP file or click to browse
   - **Direct URL**: Paste a direct link to your exported conversation file
3. **Validation**: The system validates the URL format for supported sources
4. **Processing**: Files are uploaded to secure storage and processed asynchronously
5. **Notification**: You'll receive an inbox notification when import completes or fails

## Data Handling

### Import Process
- Uploaded files are processed securely through AWS S3
- ZIP files are extracted and parsed according to source format
- Conversation data is validated before import
- Existing conversations are updated (upserted) to prevent duplicates

### Data Mapping

#### OpenAI Format
- Conversations mapped using `openaiConversationId`
- Messages linked via `openaiMessageId`
- Preserves parent-child message relationships
- Maintains conversation threading structure

#### Claude Format
- Conversations mapped using `claudeConversationId`
- Messages linked via `claudeMessageId`
- Consolidates alternating human/assistant messages
- Preserves conversation flow and context

### Data Storage
- All imported conversations become part of your session history
- Messages are stored with original source identifiers
- Conversation metadata is preserved
- Integration with existing chat functionality

## Limitations

### Current Restrictions
- **File Size**: Subject to upload limits
- **Format Support**: Only supports official export formats from OpenAI and Claude
- **Artifact Handling**: Claude artifacts (code, documents) are not yet fully processed

### Known Issues
- Claude artifact embeddings (`<antArtifact>` tags) require manual processing
- Large conversation histories may take time to process
- Network timeouts may affect URL-based imports

## Troubleshooting

### Common Issues
1. **Invalid File Format**: Ensure you're uploading the correct ZIP file from the AI service
2. **Upload Failure**: Check your internet connection and file size
3. **Processing Timeout**: Large files may require multiple attempts
4. **Missing Conversations**: Verify the export was complete from the source service

### Support
- Check your inbox notifications for import status updates
- Contact support if imports consistently fail
- Provide error messages and source service details when reporting issues

## Privacy and Security

- All uploads are encrypted in transit and at rest
- Files are processed in secure, isolated environments
- Original export files are not retained after processing
- Imported data follows the same privacy controls as native conversations

---

## Related Features

- [Notebooks](./notebooks.md) - Where imported chats appear
- [Notebook Export & Import](./notebook-export-import.md) - Export your notebooks
- [Profile & Settings](./profile-settings.md) - Access import settings