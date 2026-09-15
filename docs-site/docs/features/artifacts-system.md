---
title: Artifacts
description: Create and manage interactive content like React components, diagrams, and code with version control
sidebar_position: 9
tags: [artifacts, code, components, creative, experimental]
---

# Artifacts

*(Experimental Feature — enable in [Profile > Settings > Experimental Features](./profile-settings.md#experimental-features))*

> **Availability:** This feature may be enabled or disabled at the organizational level by your administrator. If the toggle is grayed out with "Disabled by administrator," contact your organization admin to request access.

Artifacts are interactive pieces of content that AI can generate during your conversations. They go beyond simple code blocks to provide live previews, version history, and collaboration features.

## How to Enable

1. Click your **avatar** in the sidebar footer to open your Profile
2. Go to the **Settings** tab
3. Scroll to **Experimental Features** and toggle **Artifacts** on

Once enabled, artifacts render inline in your notebook conversations whenever the AI generates interactive content. No additional navigation is needed — just ask the AI to create a React component, diagram, or HTML page and the artifact will appear in the conversation.

**What makes Artifacts special:**
- **Interactive**: React components, diagrams, and HTML render live in your browser
- **Versioned**: Full history with the ability to roll back changes
- **Shareable**: Control who can view and edit your artifacts
- **Persistent**: Save artifacts to reuse across sessions

---

## Artifact Types

### React Components

Live, interactive React components that run in your browser:
- Buttons, forms, and interactive widgets
- Data visualizations and charts
- Mini-applications and tools
- Styled with CSS or component libraries

### HTML Pages

Complete HTML documents with:
- Styling and layout
- Embedded JavaScript
- Responsive design preview

### SVG Graphics

Vector graphics with:
- Zoom and pan controls
- Interactive elements
- Export to PNG or PDF

### Mermaid Diagrams

Create visual diagrams using simple text:
- Flowcharts and process diagrams
- Sequence diagrams
- Entity relationship diagrams
- Gantt charts for project timelines

### Code Snippets

Syntax-highlighted code in any language:
- Python, JavaScript, TypeScript
- SQL, JSON, YAML
- And many more

---

## Creating Artifacts

### During Conversations

AI can create artifacts automatically when you ask for:
- "Create a React component that..."
- "Draw a flowchart showing..."
- "Build an HTML page with..."
- "Write a diagram of..."

The artifact appears in a panel alongside your conversation.

### Manual Creation

1. Click **Create Artifact** in the artifacts gallery
2. Choose the artifact type
3. Enter a title and description
4. Write or paste your content
5. Click **Save**

---

## Working with Artifacts

### Viewing Artifacts

- **Preview panel**: See the rendered output
- **Code view**: View and edit the source
- **Full screen**: Expand for larger previews
- **Split view**: See code and preview side by side

### Editing Artifacts

1. Click **Edit** on any artifact
2. Modify the content in the code editor
3. See live preview updates
4. Click **Save** to create a new version

### Version History

Every change creates a new version:
- View all previous versions in the dropdown
- Compare versions to see changes
- Restore any previous version
- Track who made each change

---

## Artifact Gallery

Browse and manage your artifacts:

### Finding Artifacts

- **Search**: Find by title or content
- **Filter by type**: Show only React, HTML, etc.
- **Sort**: By date, name, or type
- **View modes**: Grid, list, or card view

### Organizing Artifacts

- **Tags**: Add custom tags for categorization
- **Projects**: Associate with specific projects
- **Status**: Draft, Published, or Archived

---

## Sharing Artifacts

### Visibility Options

| Level | Who Can Access |
|-------|----------------|
| **Private** | Only you |
| **Project** | Project team members |
| **Organization** | All organization members |
| **Public** | Anyone with the link |

### Sharing Actions

- **Copy link**: Share a direct link
- **Embed**: Get embed code for websites
- **Export**: Download as file

---

## Tips & Best Practices

### Getting Good Results

1. **Be specific**: Describe exactly what you want
2. **Iterate**: Ask AI to modify and improve
3. **Reference examples**: Mention styles or patterns you like
4. **Test interactivity**: Try buttons and inputs

### Organizing Your Work

1. **Use clear titles**: Make artifacts easy to find
2. **Add descriptions**: Document what each artifact does
3. **Tag consistently**: Use standard tags across your team
4. **Archive old versions**: Keep your gallery clean

### For Teams

1. **Share templates**: Create reusable starting points
2. **Set standards**: Agree on naming conventions
3. **Review before publishing**: Use draft status for work in progress

---

## Troubleshooting

### Artifact Not Rendering

- Check for syntax errors in the code
- Verify all dependencies are available
- Try refreshing the preview
- Check browser console for errors

### React Component Errors

- Ensure proper default export
- Check for missing imports
- Verify JSX syntax is correct
- Look for undefined variables

### Diagram Not Displaying

- Verify Mermaid syntax is correct
- Check for unsupported diagram types
- Try simpler diagrams first

---

## Related Features

- [Notebooks](./notebooks.md) - Where artifacts are created
- [Projects](./projects.md) - Organize artifacts in projects
- [Quest Master](./quest-master.md) - Artifacts in task workflows
