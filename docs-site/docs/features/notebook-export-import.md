---
title: Notebook Export & Import
description: Export and import your notebooks for backup, migration, and data portability
sidebar_position: 11
tags: [export, import, backup, data-portability]
---

# Notebook Export & Import

Export and import your notebooks for backup, migration, and data portability.

## Overview

**Export**: Download your notebooks in a standardized JSON format
**Import**: Upload and restore notebooks from exported files
**Use Cases**: Data backup, environment migration, no vendor lock-in, developer workflows

## Export Features

### Accessing Export
1. Open your user profile
2. Navigate to the **Settings** tab
3. Find the **AI Features** section
4. Click **Export Notebooks**

### Export Options

#### Content Selection
- **Knowledge Files**: Include attached documents and files
- **Artifacts**: Include generated code, documents, and other artifacts
- **Tools**: Include custom tools and configurations
- **Agents**: Include AI agents and their settings
- **Images**: Include embedded images (as base64)

#### Privacy & Metadata
- **Include Usage Metadata**: Export token usage, costs, model information
- **Anonymize Export**: Remove user-identifying information
- **Maximum File Size**: Set limit for embedded files (larger files referenced by URL)

#### Filtering Options
- **Date Range**: Export only notebooks from specific time periods
- **Specific Notebooks**: Choose individual notebooks to export (coming soon)

### Export Process
1. Configure your export options
2. Click **Export Notebooks**
3. System processes all selected notebooks and attachments
4. Download link provided when complete
5. File downloaded as `notebooks-[user]-[date].json`

### Export Format
The export creates a JSON file with this structure:
```json
{
  "exportVersion": "1.0.0",
  "exportedAt": "2024-01-15T10:30:00Z",
  "platform": "lumina5",
  "notebooks": [
    {
      "id": "notebook-123",
      "name": "My Notebook",
      "chatHistory": [...],
      "knowledge": [...],
      "artifacts": [...],
      "tools": [...],
      "agents": [...]
    }
  ]
}
```

## Import Features

### Accessing Import
1. Open your user profile
2. Navigate to the **Settings** tab  
3. Find the **AI Features** section
4. Click **Import Notebooks**

### Import Methods

#### File Upload
- Drag and drop exported JSON files
- Click to browse and select files
- Supports files up to 50MB

#### JSON Data
- Paste exported JSON data directly
- Useful for copying between browsers/sessions
- Validates JSON format before import

### Import Options

#### Conflict Resolution
- **Skip**: Ignore notebooks with existing names
- **Rename**: Add suffix to duplicate names (e.g., "Notebook (2)")
- **Overwrite**: Replace existing notebooks completely
- **Merge**: Append chat history to existing notebooks

#### Content Selection
- **Knowledge Files**: Import attached documents
- **Artifacts**: Import generated content
- **Tools**: Import custom tools
- **Agents**: Import AI agents

#### Advanced Options
- **Preserve Original IDs**: Keep source IDs (useful for developers)
- **Name Prefix**: Add prefix to all imported notebooks
- **Target User**: Import to different user (admin only)

### Import Process
1. Select import method (file or JSON)
2. Configure import options
3. Upload file or paste JSON data
4. Click **Import Notebooks**
5. System processes and validates data
6. Notebooks added to your account
7. Summary report shows results

## Developer Use Cases

### Environment Migration
```bash
# Export from staging
curl -X POST /api/notebooks/export \
  -H "Authorization: Bearer $STAGING_TOKEN" \
  -d '{"includeKnowledge": true}' \
  > staging-notebooks.json

# Import to production  
curl -X POST /api/notebooks/import \
  -H "Authorization: Bearer $PROD_TOKEN" \
  -F "file=@staging-notebooks.json" \
  -F "conflictResolution=rename"
```

### Cross-Account Testing
- Export notebooks from production account
- Import to test account with `preserveIds: false`
- Test features without affecting production data
- Clean separation of environments

### Backup & Restore
- Schedule regular exports for backup
- Store export files in version control or cloud storage
- Quick restore capability for disaster recovery
- Maintain data history and versioning

## Data Handling

### Security
- Exports include full chat history and attachments
- Sensitive data (API keys, tokens) should be reviewed before sharing
- Anonymization option removes user-identifying information
- Files encrypted in transit and at rest

### Performance
- Large notebooks may take time to export/import
- Progress indicators show processing status
- Bulk operations optimized for efficiency
- Asynchronous processing prevents timeouts

### Compatibility
- **Format Version**: Current version 1.0.0
- **Backward Compatibility**: Newer versions support older formats
- **Cross-Platform**: Works between different platform instances
- **Future-Proof**: Extensible format for new features

## Limitations

### Current Restrictions
- Export file size limited by browser memory
- Very large attachments may be referenced rather than embedded
- Some system-generated content may not be portable
- Real-time collaboration data not included

### Known Issues
- Image exports may be large due to base64 encoding
- Tool configurations may need adjustment in target environment
- Agent settings might reference unavailable resources
- Date/time zones preserved as UTC

## Troubleshooting

### Export Issues
- **Out of Memory**: Reduce date range or exclude large attachments
- **Missing Content**: Check export options are enabled
- **Slow Performance**: Large notebooks take time to process
- **Failed Download**: Check browser download settings

### Import Issues
- **Invalid Format**: Verify JSON structure and version
- **Conflict Errors**: Adjust conflict resolution settings
- **Missing Attachments**: Check if files exist in source system
- **Permission Denied**: Verify user has import permissions

### Data Validation
- JSON format validation during import
- Checks for required fields and data types
- Warns about missing or invalid content
- Provides detailed error messages

## Best Practices

### For Users
- Regular exports for backup purposes
- Test imports in non-production environments first
- Review exported data before sharing
- Use anonymization for public sharing

### For Developers
- Use `preserveIds: true` for same-platform migrations
- Include all content types for complete backups
- Version control export files for tracking changes
- Document import procedures for team members

### For Administrators
- Monitor export/import activity
- Set appropriate file size limits
- Review cross-user import requests
- Maintain backup schedules

## API Reference

### Export Endpoint
```
POST /api/notebooks/export
```

**Request Body:**
```json
{
  "notebookIds": ["id1", "id2"],
  "includeKnowledge": true,
  "includeArtifacts": true,
  "includeTools": true,
  "includeAgents": true,
  "anonymize": false,
  "includeMetadata": true,
  "includeImages": true,
  "maxFileSize": 10485760,
  "fromDate": "2024-01-01T00:00:00Z",
  "toDate": "2024-12-31T23:59:59Z"
}
```

### Import Endpoint
```
POST /api/notebooks/import
```

**Form Data:**
- `file`: JSON export file
- `conflictResolution`: "skip" | "overwrite" | "rename" | "merge"
- `preserveIds`: boolean
- `importKnowledge`: boolean
- `importArtifacts`: boolean
- `importTools`: boolean
- `importAgents`: boolean
- `namePrefix`: string (optional)

**Alternative JSON Data:**
```json
{
  "jsonData": "...",
  "conflictResolution": "rename",
  "preserveIds": false,
  "importKnowledge": true
}
```

---

## Related Features

- [Notebooks](./notebooks.md) - The sessions you're exporting
- [Chat History Import](./chat-history-import.md) - Import from ChatGPT or Claude
- [Profile & Settings](./profile-settings.md) - Access export/import settings
- [Knowledge Management](./knowledge-management.md) - Manage exported files