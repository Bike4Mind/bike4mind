---
title: Knowledge Management
description: Upload, organize, and intelligently search your documents
sidebar_position: 5
tags: [knowledge, documents, search, upload]
---

# Knowledge Management

Bike4Mind's Knowledge Management system transforms your documents into an intelligent, searchable knowledge base. Upload any document format, and our AI will understand, chunk, and make it available for semantic search and contextual retrieval.

## Supported File Formats

### Documents
- **PDF** - Full text extraction and formatting preservation
- **DOCX/DOC** - Microsoft Word documents
- **TXT** - Plain text files
- **Markdown** - Technical documentation
- **RTF** - Rich text format

### Data Files
- **CSV** - Spreadsheet data with smart table rendering
- **XLSX/XLS** - Excel files with multi-sheet support
- **JSON** - Structured data visualization
- **XML** - Hierarchical data parsing

### Code Files
- **All programming languages** - Syntax highlighting
- **Jupyter Notebooks** - Cell-by-cell rendering
- **Configuration files** - YAML, TOML, INI

### Web Content
- **HTML** - Web page content extraction
- **URL Import** - Direct import from any public URL
- **Google Drive** - Direct integration

## Smart Document Processing

### Intelligent Chunking
Our AI automatically:
- **Preserves Context** - Keeps related information together
- **Respects Structure** - Maintains document hierarchy
- **Optimizes Size** - Balances detail with performance
- **Handles Tables** - Special processing for structured data

### Chunk Policy (passage size)
The passage target - how large each chunk is, in tokens - is a configurable lever, not a fixed
constant:
- **Resolved at the file owner's altitude** - the effective target is the owner's configured
  `Default Chunk Size` (an individual or organization may pin their own default), falling back to the
  platform default. It is always capped to the embedding model's context window, so a value larger
  than the model can embed is reduced automatically rather than failing vectorization.
- **A data lake is a constraint, not an override** - chunks are shared by every consumer of a file,
  so a lake never rewrites a file's chunks to its own size. A lake may declare a *required* passage
  target; a file whose chunks do not meet it (including a file in two lakes whose requirements
  disagree) is flagged with a **chunk-policy conflict** instead of being silently re-chunked. Resolve
  a conflict by aligning the owner's chunk policy, or by removing the file from the conflicting lake.

### Vector Embeddings
Every chunk is:
- **Semantically Indexed** - Meaning-based search
- **Cross-Referenced** - Links between related content
- **Ranked by Relevance** - Best matches first
- **Context-Aware** - Understands surrounding information

### Lake Health (retrievability)
A data lake reports **how much of its content can actually be found**, not just how much was
uploaded. Every processing counter can read "complete" while a large share of a lake is unreachable -
so health is *computed* from four checkable rules, and shown on the lake in the manager panel:

- **One headline metric: reachable content.** The share of the lake's stored text that a search can
  actually deliver to the model. This is the number to watch - it accounts for content that was
  stored but is clipped at serve time or was never embedded.
- **A three-state badge** - healthy, degraded, or unhealthy - derived from that share and the rules
  below.
- **A drill-down** naming which files are affected and why.

The four rules, per file:
1. **No oversized chunk** - no chunk is larger than the policy passage size.
2. **Chunk count fits the chunked text** - a document split into too few chunks for its size (in the
   extreme, a whole document in one oversized chunk) is flagged, because most of it can never rank in
   search. This rule is measured against the text that was actually chunked, so in practice it moves
   together with rule 1 (an under-chunked file is an oversized-chunk file); it is reported separately
   so the drill-down still names the shape explicitly.
3. **Fully vectorized** - every chunk carries a vector; a chunk with no vector is invisible to
   semantic search even though it was "processed".
4. **Serve cap meets policy** - the retrieval serve limit is at least the policy passage size, so an
   in-policy chunk is never clipped before the model sees it.

Health is **advisory** - it never blocks a search. A degraded lake still answers; the model is simply
told the results may be incomplete, so it does not assert completeness over content it cannot see.

:::note Not yet measured
A lake shows **"Health: not measured"** until the one-time indexing backfill has run for its content -
the reachable-content figure needs a per-chunk character measurement that older content predates.
This is not the same as unhealthy: it means the measurement, not the content, is missing. New and
re-ingested content is measured automatically. If a lake stays unmeasured, re-run indexing (or ask an
administrator to run the char-length backfill) to populate it.
:::

## Organization Features

### Collections
Group related documents:
- **Thematic Organization** - By topic or project
- **Visual Collections** - Cover images for easy recognition
- **Quick Access** - Pin frequently used collections
- **Bulk Operations** - Manage multiple files at once

### Tagging System
Flexible categorization:
- **Auto-Tagging** - AI suggests relevant tags
- **Custom Tags** - Create your own taxonomy
- **Tag Hierarchies** - Parent/child relationships
- **Smart Filters** - Combine tags for precise search

### Knowledge Artifacts
Special document types:
- **Code Snippets** - Reusable code blocks
- **Templates** - Document templates
- **Cheat Sheets** - Quick reference guides
- **Glossaries** - Term definitions

## Search Capabilities

### Semantic Search
Find information by meaning:
- **Natural Language** - Ask questions in plain English
- **Concept Matching** - Find related ideas
- **Multi-Language** - Search across languages
- **Fuzzy Matching** - Handles typos and variations

### Advanced Filters
Refine your search:
- **File Type** - Filter by format
- **Date Range** - When uploaded or modified
- **Size** - Find large or small files
- **Tags** - Combine multiple tags
- **Collections** - Search within groups

### Search Operators
Power user features:
- **Exact Match** - "quoted phrases"
- **Exclusions** - -unwanted terms
- **Wildcards** - partial* matches
- **Boolean** - AND, OR, NOT logic

## File Management

### Upload Methods
Multiple ways to add content:
- **Drag & Drop** - Direct file upload
- **URL Import** - Paste any web link
- **Google Drive** - Browse and import
- **Bulk Upload** - Multiple files at once
- **API Upload** - Programmatic access

### File Operations
Complete control:
- **Preview** - View without downloading
- **Edit Metadata** - Update titles and descriptions
- **Move/Copy** - Organize between collections
- **Version History** - Track changes
- **Export** - Download originals

### Storage Management
Efficient use of space:
- **Compression** - Automatic optimization
- **Deduplication** - Avoid duplicate storage
- **Usage Analytics** - Track storage by type
- **Cleanup Tools** - Find and remove unused files

## Integration with AI Features

### Contextual Retrieval
Documents enhance AI responses:
- **Automatic Inclusion** - Relevant docs in context
- **Citation Support** - AI cites sources
- **Fact Checking** - Verify against documents
- **Knowledge Synthesis** - Combine multiple sources

### With Quest Master
Enhance autonomous tasks:
- **Research Tasks** - Access all documents
- **Fact Verification** - Cross-reference information
- **Report Generation** - Pull from knowledge base
- **Data Analysis** - Process uploaded datasets

### With Mementos
Knowledge becomes memory:
- **Document Insights** - Key points saved as memories
- **Learning Tracking** - Remember what you've read
- **Connection Building** - Link memories to documents
- **Progressive Understanding** - Build on previous knowledge

## Use Cases

### Research & Analysis
- Upload research papers
- Extract key findings
- Cross-reference sources
- Build literature reviews

### Technical Documentation
- API documentation
- Code repositories
- Configuration guides
- Troubleshooting resources

### Business Intelligence
- Market reports
- Competitor analysis
- Financial documents
- Strategic plans

### Personal Knowledge Base
- Book notes
- Course materials
- Reference documents
- Personal archives

## Best Practices

### Document Preparation
1. **Use Clear Titles** - Descriptive filenames help
2. **Add Metadata** - Include dates, authors, versions
3. **Organize Early** - Create collections before bulk upload
4. **Clean PDFs** - OCR scanned documents first

### Optimal Usage
1. **Regular Uploads** - Keep knowledge current
2. **Consistent Tagging** - Develop a system
3. **Periodic Review** - Clean up outdated files
4. **Share Knowledge** - Use in projects

### Performance Tips
1. **Chunk Large Files** - Split very large documents
2. **Use Collections** - Don't rely only on search
3. **Archive Old Files** - Move inactive content
4. **Monitor Usage** - Track what's being accessed

## Security & Privacy

### Data Protection
- **Encryption** - At rest and in transit
- **Access Control** - File-level permissions
- **Audit Trail** - Track all access
- **Secure Sharing** - Time-limited links

### Compliance
- **GDPR Ready** - Data export and deletion
- **SOC 2** - Security controls
- **HIPAA Compatible** - Healthcare data (Enterprise)
- **Data Residency** - Choose storage location

### Data lake access and membership view

If you can manage a data lake, its manager view has an **Access** button (next to Settings) that
opens a compliance surface answering the two questions a lake owner is asked first:

- **Who can see this?**
  - **Members and grants** - every explicit grant on the lake (owner / curator / reader), who
    granted it and when, and its expiry. A grant past its expiry is shown as **expired**, resolved
    live at the moment you open the view - never as if it were still live.
  - **Access channels** - the gate-based ways in that are not explicit grants: a required tag, a
    required entitlement, an organization (shown with the number of its members that can actually
    reach the lake), or public. These are resolved live on every request, so they are shown as
    channels rather than as member rows.
- **Who actually has?**
  - **Access history** - who has read the lake, how many times, when they last read it, and through
    which surface, aggregated from the access-audit trail. Read this as a **lower bound**: an entry
    exists only for a retrieval surface that emits access events, the audit write is best-effort by
    design, and events age out on their own retention window. An empty history means "no reads
    recorded", not "nobody read this lake".

Use **Export CSV** for a downloadable artifact suitable for a compliance review; it contains the
same three sections plus a note when the history was truncated.

### Transferring a data lake to someone else

The Access view is where you hand a lake on. **Transfer ownership**, next to *Members and grants*,
appears only if you are the lake's owner, an admin of the organization that owns it, or a platform
admin - being able to *manage* a lake (a curator, for instance) is not enough to give it away.

What happens when you transfer:

- The person you choose becomes the owner, and the lake's owner grant moves to them.
- **You stay on as a curator.** You keep managing the lake - adding files, editing settings,
  reprocessing - but only the new owner can transfer it again or change how it is shared. Reversing a
  transfer is therefore the new owner's call, which is why it asks you to confirm.
- The lake's creator never changes. Ownership rides on the grant, so the audit trail of who
  originally created the lake stays intact.

Who you can choose is resolved by the server from the membership of the organization that owns the
lake - the billing owner, appointed admins, and everyone on the member list - minus the current
owner. An organization admin acting only in that capacity cannot name **themselves**: succession is a
reassignment to another member, not a way to take a colleague's lake and then publish it.

**A personal lake has no one to transfer to.** With no organization behind it there is no member list
to choose from, and the picker says so rather than showing an empty list. Move the lake into an
organization first: switch to your team account using the profile card at the bottom left, then open
the lake's **Settings -> Visibility** and choose **Organization**. After that the transfer picker
lists your teammates.

### Troubleshooting the access view

- **"You must be able to manage this data lake to view its access."** The view is manager-only
  (owner, curator, org admin, or platform admin). Someone who can only read the lake will see this
  message - it is not an error.
- **A channel shows no holder count.** Only the organization channel carries a member count. Tag and
  entitlement channels deliberately show none: counting their holders would mean scanning every user
  in the install, which this feature is designed to avoid. A missing count means "not counted", not
  "zero".
- **"Showing the most recent reads only".** The history read is capped for performance. When you see
  this banner, the on-screen list is the most recent window, not the whole trail. The CSV export
  carries that **same** window, so it is not a way around the cap; the banner and the export both
  state the instant the window starts.
- **Access history is empty after someone read the lake.** A read appears here only if it went
  through a retrieval surface that emits access events, and the audit write is deliberately
  best-effort - it never fails a user's request, so a transient write failure drops the row rather
  than the answer. Entries also age out on the audit retention window. The empty state says "no
  reads recorded" rather than "nobody read this lake" for exactly these reasons.
- **An organization's member count here is lower than on the organization page.** This count is the
  members the read gate would actually admit. Members who have not accepted their invitation, or who
  hold share-only permissions, are counted by the organization page but cannot read the lake, so they
  are excluded here on purpose - an over-stated count would be the more dangerous error.
- **There is no Transfer ownership button.** It is gated more tightly than the rest of the view: only
  the lake's owner, an admin of the owning organization, or a platform admin sees it. A curator can
  read the whole access view without being able to hand the lake on.
- **The transfer picker is empty.** Two different causes, and it tells you which. On a **personal**
  lake there is no organization membership to list, so move the lake into an organization first. On an
  organization lake it means the organization has no other eligible member yet - add them to the
  organization, then transfer.
- **A teammate is missing from the transfer picker.** The picker excludes the current owner (handing a
  lake to whoever already owns it does nothing) and, if you are acting purely as an organization
  admin, yourself. It also drops anyone whose user account no longer resolves. Note that this list is
  deliberately **wider** than the organization channel's member count above it: a new owner does not
  need pre-existing read access, since owning the lake grants it.
- **A reader you expected is missing from Members.** Reader-role and organization grants only take
  effect once the platform enables read-time grant enforcement; until then they are recorded but do
  not yet open the lake. Tag/entitlement/org access appears under Access channels, not as grants.

## Coming Soon

- **OCR Enhancement** - Better text extraction
- **Audio/Video** - Transcription support
- **Real-time Sync** - Live document updates
- **Advanced Analytics** - Usage insights
- **Team Libraries** - Shared knowledge bases

---

## Related Features

- [Notebooks](./notebooks.md) - Use knowledge in conversations
- [Projects](./projects.md) - Organize files by project
- [Mementos](./mementos.md) - AI memory system
- [Quest Master](./quest-master.md) - Leverage documents in tasks