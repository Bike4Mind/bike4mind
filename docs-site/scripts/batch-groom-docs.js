#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Metadata inference rules based on file location and content
const METADATA_RULES = {
  // By directory
  security: {
    content_type: ['reference', 'how-to'],
    audience: ['security-team', 'administrators'],
    spiciness: 'hot',
    visibility: 'internal',
    related_features: ['security'],
  },
  databases: {
    content_type: ['reference', 'how-to'],
    audience: ['administrators', 'developers'],
    spiciness: 'medium',
    visibility: 'internal',
    related_features: ['databases', 'infrastructure'],
  },
  features: {
    content_type: ['conceptual', 'reference'],
    audience: ['developers'],
    spiciness: 'medium',
    visibility: 'public',
    related_features: ['features'],
  },
  'tutorial-basics': {
    content_type: ['tutorial'],
    audience: ['developers', 'end-users'],
    spiciness: 'mild',
    visibility: 'public',
    maturity: 'approved',
    related_features: ['documentation'],
  },
  'tutorial-extras': {
    content_type: ['tutorial', 'how-to'],
    audience: ['developers'],
    spiciness: 'medium',
    visibility: 'public',
    maturity: 'approved',
    related_features: ['documentation'],
  },
  Artifacts: {
    content_type: ['architecture', 'reference'],
    audience: ['developers', 'architects'],
    spiciness: 'hot',
    feature_status: 'stable',
    related_features: ['artifacts'],
  },
  'dev-sided': {
    content_type: ['how-to', 'reference'],
    audience: ['developers'],
    spiciness: 'medium',
    visibility: 'internal',
    related_features: ['development'],
  },
  'client-sided': {
    content_type: ['conceptual', 'reference'],
    audience: ['administrators', 'end-users'],
    spiciness: 'medium',
    visibility: 'public',
    related_features: ['platform'],
  },
  aws: {
    content_type: ['how-to', 'reference'],
    audience: ['administrators', 'developers'],
    spiciness: 'medium',
    visibility: 'internal',
    related_features: ['infrastructure', 'aws'],
  },
  documentation: {
    content_type: ['how-to', 'reference'],
    audience: ['developers'],
    spiciness: 'mild',
    visibility: 'internal',
    related_features: ['documentation'],
  },
  testing: {
    content_type: ['how-to', 'reference'],
    audience: ['developers'],
    spiciness: 'medium',
    visibility: 'public',
    related_features: ['testing', 'quality'],
  },
  'new-customers': {
    content_type: ['how-to', 'conceptual'],
    audience: ['administrators', 'end-users'],
    spiciness: 'mild',
    visibility: 'public',
    related_features: ['onboarding'],
  },
  files: {
    content_type: ['conceptual', 'how-to'],
    audience: ['end-users', 'developers'],
    spiciness: 'mild',
    visibility: 'public',
    related_features: ['files', 'platform'],
  },
};

// Special file rules
const FILE_SPECIFIC_RULES = {
  'intro.md': {
    content_type: ['conceptual'],
    spiciness: 'mild',
    maturity: 'approved',
    sidebar_position: 1,
  },
  'index.md': {
    content_type: ['conceptual'],
    spiciness: 'mild',
    maturity: 'approved',
  },
  roadmap: {
    content_type: ['roadmap'],
    feature_status: 'experimental',
    spiciness: 'blazing',
    review_cycle: 'monthly',
  },
  architecture: {
    content_type: ['architecture'],
    spiciness: 'hot',
    review_cycle: 'quarterly',
  },
  api: {
    content_type: ['reference'],
    spiciness: 'medium',
  },
  implementation: {
    content_type: ['how-to', 'reference'],
    spiciness: 'hot',
  },
  'quest-': {
    content_type: ['tutorial', 'how-to'],
    feature_status: 'stable',
    spiciness: 'hot',
    related_features: ['artifacts', 'implementation'],
  },
  performance: {
    spiciness: 'hot',
    related_features: ['performance'],
  },
  optimization: {
    spiciness: 'hot',
    related_features: ['performance'],
  },
  troubleshooting: {
    content_type: ['troubleshooting'],
    spiciness: 'medium',
  },
  setup: {
    content_type: ['how-to'],
    spiciness: 'medium',
  },
  guide: {
    content_type: ['how-to'],
    spiciness: 'medium',
  },
};

function inferMetadata(filePath) {
  const fileName = path.basename(filePath);
  const dirName = path.basename(path.dirname(filePath));
  const content = fs.readFileSync(filePath, 'utf8');

  // Start with defaults
  let metadata = {
    sidebar_position: 99,
    content_type: ['conceptual'],
    feature_status: 'stable',
    audience: ['developers'],
    spiciness: 'medium',
    visibility: 'public',
    maturity: 'approved',
    related_features: [],
    tags: [],
    last_reviewed: new Date().toISOString().split('T')[0],
  };

  // Apply directory rules
  if (METADATA_RULES[dirName]) {
    metadata = { ...metadata, ...METADATA_RULES[dirName] };
  }

  // Apply file-specific rules
  for (const [pattern, rules] of Object.entries(FILE_SPECIFIC_RULES)) {
    if (fileName.includes(pattern)) {
      metadata = { ...metadata, ...rules };
    }
  }

  // Extract title from content
  const titleMatch = content.match(/^#\s+(.+)$/m);
  if (titleMatch) {
    metadata.title = titleMatch[1].trim();
  } else {
    metadata.title = fileName.replace(/\.mdx?$/, '').replace(/-/g, ' ');
  }

  // Infer tags from content
  const tags = new Set();

  // Add directory as tag
  tags.add(dirName.toLowerCase());

  // Add feature-related tags
  if (content.includes('API') || content.includes('endpoint')) tags.add('api');
  if (content.includes('security') || content.includes('authentication')) tags.add('security');
  if (content.includes('performance')) tags.add('performance');
  if (content.includes('AWS') || content.includes('Amazon')) tags.add('aws');
  if (content.includes('database') || content.includes('MongoDB')) tags.add('database');
  if (content.includes('React')) tags.add('react');
  if (content.includes('TypeScript')) tags.add('typescript');
  if (content.includes('test')) tags.add('testing');
  if (content.includes('deploy')) tags.add('deployment');
  if (content.includes('artifact')) tags.add('artifacts');
  if (content.includes('agent')) tags.add('agents');
  if (content.includes('AI') || content.includes('LLM')) tags.add('ai');

  metadata.tags = Array.from(tags);

  // Adjust spiciness based on content complexity
  const codeBlockCount = (content.match(/```/g) || []).length / 2;
  const wordCount = content.split(/\s+/).length;

  if (codeBlockCount > 10 || wordCount > 2000) {
    metadata.spiciness = 'hot';
  }
  if (content.includes('advanced') || content.includes('expert')) {
    metadata.spiciness = 'blazing';
  }
  if (content.includes('beginner') || content.includes('getting started')) {
    metadata.spiciness = 'mild';
  }

  // Set feature status based on keywords
  if (content.includes('experimental') || content.includes('alpha')) {
    metadata.feature_status = 'experimental';
  } else if (content.includes('beta') || content.includes('preview')) {
    metadata.feature_status = 'beta';
  } else if (content.includes('deprecated')) {
    metadata.feature_status = 'deprecated';
  } else if (content.includes('legacy')) {
    metadata.feature_status = 'legacy';
  }

  // Set maturity based on content
  if (content.includes('TODO') || content.includes('FIXME')) {
    metadata.maturity = 'draft';
  } else if (content.includes('WIP') || content.includes('work in progress')) {
    metadata.maturity = 'review';
  }

  // Extract sidebar position from existing frontmatter if present
  const sidebarMatch = content.match(/sidebar_position:\s*(\d+)/);
  if (sidebarMatch) {
    metadata.sidebar_position = parseInt(sidebarMatch[1]);
  }

  return metadata;
}

function addMetadataToFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Skip if already has our metadata
  if (content.includes('content_type:') && content.includes('spiciness:')) {
    console.log(`⏭️  Skipping (already groomed): ${filePath}`);
    return false;
  }

  const metadata = inferMetadata(filePath);

  // Build frontmatter
  let frontmatter = '---\n';

  // Order matters for readability
  const orderedKeys = [
    'sidebar_position',
    'title',
    'content_type',
    'feature_status',
    'audience',
    'spiciness',
    'visibility',
    'maturity',
    'related_features',
    'tags',
    'last_reviewed',
    'review_cycle',
  ];

  for (const key of orderedKeys) {
    if (!metadata[key]) continue;

    const value = metadata[key];
    if (Array.isArray(value) && value.length > 0) {
      frontmatter += `${key}: [${value.map(v => (typeof v === 'string' ? `"${v}"` : v)).join(', ')}]\n`;
    } else if (typeof value === 'string' && (value.includes(' ') || value.includes(':'))) {
      frontmatter += `${key}: "${value}"\n`;
    } else if (value !== undefined && value !== null && value !== '') {
      frontmatter += `${key}: ${value}\n`;
    }
  }

  frontmatter += '---\n\n';

  // Handle existing frontmatter
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx !== -1) {
      // Preserve some existing frontmatter fields
      const existingFrontmatter = content.substring(3, endIdx);
      const preserveFields = ['id', 'slug', 'hide_title', 'hide_table_of_contents'];

      for (const field of preserveFields) {
        const match = existingFrontmatter.match(new RegExp(`${field}:\\s*(.+)`));
        if (match) {
          frontmatter = frontmatter.replace('---\n\n', `${field}: ${match[1]}\n---\n\n`);
        }
      }

      content = content.substring(endIdx + 3).trimStart();
    }
  }

  // Write updated content
  fs.writeFileSync(filePath, frontmatter + content);
  console.log(`✅ Groomed: ${filePath}`);

  return true;
}

function processDirectory(dirPath, stats = { processed: 0, skipped: 0 }) {
  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      // Skip node_modules and build directories
      if (file !== 'node_modules' && file !== 'build') {
        processDirectory(filePath, stats);
      }
    } else if (file.endsWith('.md') || file.endsWith('.mdx')) {
      if (addMetadataToFile(filePath)) {
        stats.processed++;
      } else {
        stats.skipped++;
      }
    }
  }

  return stats;
}

// Main execution
console.log('🚀 Starting batch documentation grooming...\n');

const docsDir = path.join(__dirname, '..', 'docs');
const stats = processDirectory(docsDir);

console.log('\n📊 Grooming Complete!');
console.log(`   ✅ Processed: ${stats.processed} files`);
console.log(`   ⏭️  Skipped: ${stats.skipped} files`);
console.log(`   📄 Total: ${stats.processed + stats.skipped} files\n`);

console.log('💡 Next steps:');
console.log('   1. Review the changes with: git diff');
console.log('   2. Adjust any incorrect metadata manually');
console.log('   3. Run "npm run check:docs" to ensure no orphaned files');
console.log('   4. Commit the changes\n');
