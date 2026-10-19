---
sidebar_position: 1
title: "User Files"
content_type: ["conceptual", "how-to"]
feature_status: stable
audience: ["end-users", "developers"]
spiciness: mild
visibility: public
maturity: approved
related_features: ["files", "platform"]
tags: ["files", "security", "database", "react"]
last_reviewed: 2025-06-30
---

# User Files

This document explains how files are handled in the Bike4Mind application, including upload, storage, and viewing capabilities.

## Overview

The application supports various file types including:
- Documents (DOCX, PDF, TXT)
- Images (JPG, PNG, WEBP, GIF)
- Code files (TS, JS, PY, etc.)
- Data files (CSV, JSON)
- Markdown files (MD, MDX)

## File Upload Process

### Upload Methods

Files can be uploaded through two main methods:

1. **Direct Upload**
   - Users can drag and drop files or use the file picker
   - Files are processed through the `FilePond` component
   - Maximum file size is configurable through server settings

2. **URL Upload**
   - Users can provide a URL to a file
   - The system downloads and processes the file
   - Supports the same file types as direct upload

### Upload Flow

1. **Client-Side Processing**
   - Files are validated for type and size
   - Progress is shown to the user
   - Files are prepared for upload

2. **Server-Side Processing**
   - Files are stored in S3 buckets
   - File metadata is saved in the database
   - Processing queues handle different file types:
     - `fabFileChunkQueue`: Processes large files
     - `fabFileVectQueue`: Handles file vectorization
     - Specialized queues for specific file types

3. **Post-Upload Processing**
   - Files are indexed for search
   - Metadata is extracted
   - Thumbnails are generated for images
   - Documents are processed for text extraction

## File Storage

Files are stored in three main S3 buckets:

1. **Fab Files Bucket**
   - Primary storage for user-uploaded files
   - Versioning enabled for data safety
   - Retention policies based on environment

2. **Generated Images Bucket**
   - Stores processed images and thumbnails
   - Optimized for image delivery
   - CORS configured for web access

3. **App Files Bucket**
   - Stores application-specific files
   - Used for system-generated content
   - Managed by application processes

## File Viewing

### Document Viewers

The application includes specialized viewers for different file types:

1. **DOCX Viewer**
   - Converts DOCX to HTML for web viewing
   - Preserves formatting and structure
   - Supports embedded images and tables

2. **PDF Viewer**
   - Native PDF rendering
   - Supports zoom and navigation
   - Maintains document security

3. **Image Viewer**
   - Optimized image display
   - Supports zoom and pan
   - Handles various image formats

4. **Code Viewer**
   - Syntax highlighting
   - Line numbers
   - Code folding

5. **Markdown Viewer**
   - Renders markdown with extensions
   - Supports Mermaid diagrams
   - Handles embedded content

### Knowledge Viewer Integration

All file types are integrated into the Knowledge Viewer, which provides:
- Unified interface for all file types
- Tabbed navigation between files
- Layout options (vertical, horizontal, picture-in-picture)
- Search and filtering capabilities

## XLSX Support (Planned)

The application will soon support Microsoft Excel files (XLSX) with the following features:

### Upload Support
- Direct upload of XLSX files
- URL-based upload of XLSX files
- File size limits appropriate for spreadsheets
- Validation of spreadsheet integrity

### Processing Pipeline
1. **Initial Processing**
   - File validation
   - Basic metadata extraction
   - Storage in S3 buckets

2. **Advanced Processing**
   - Data extraction for search indexing
   - Formula validation
   - Chart and image extraction
   - Sheet metadata generation

### XLSX Viewer Features
The XLSX viewer will provide:
- Sheet navigation and switching
- Cell formatting preservation
- Formula support
- Chart rendering
- Data filtering and sorting
- Export capabilities
- Print support

### Technical Implementation
The XLSX support will be implemented using:
- `xlsx` library for file processing
- Custom React components for the viewer
- Integration with the Knowledge Viewer
- Specialized processing queues for spreadsheets

### Security Considerations
- Formula validation to prevent malicious content
- Data sanitization
- Access control for sensitive data
- Audit logging for spreadsheet access

## Security

The file system includes several security measures:

1. **Access Control**
   - Role-based permissions
   - File-level access control
   - Secure URL generation

2. **Data Protection**
   - Encrypted storage
   - Secure file transfer
   - Access logging

3. **Error Handling**
   - Graceful failure handling
   - User-friendly error messages
   - System logging and monitoring

## Best Practices

1. **File Management**
   - Keep files organized
   - Use descriptive names
   - Consider file size before upload

2. **Performance**
   - Optimize images before upload
   - Use appropriate file formats
   - Consider file size impact

3. **Security**
   - Only upload necessary files
   - Be mindful of sensitive data
   - Follow access control guidelines

## Troubleshooting

Common issues and solutions:

1. **Upload Failures**
   - Check file size limits
   - Verify file type support
   - Ensure network connectivity

2. **Viewing Issues**
   - Clear browser cache
   - Try different browser
   - Check file format compatibility

3. **Access Problems**
   - Verify permissions
   - Check file status
   - Contact support if needed
