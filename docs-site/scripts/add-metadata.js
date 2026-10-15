#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const METADATA_TEMPLATE = {
  content_type: ['tutorial', 'reference', 'conceptual', 'how-to', 'troubleshooting', 'architecture', 'roadmap'],
  feature_status: ['experimental', 'beta', 'stable', 'deprecated', 'legacy'],
  audience: ['developers', 'administrators', 'end-users', 'architects', 'security-team'],
  spiciness: ['mild', 'medium', 'hot', 'blazing'],
  visibility: ['public', 'internal', 'enterprise', 'partner'],
  maturity: ['draft', 'review', 'approved', 'needs-update'],
};

const SPICE_MAP = {
  mild: '🌶️',
  medium: '🌶️🌶️',
  hot: '🌶️🌶️🌶️',
  blazing: '🌶️🌶️🌶️🌶️',
};

const STATUS_MAP = {
  experimental: '🧪',
  beta: '🚧',
  stable: '✅',
  deprecated: '⚠️',
  legacy: '📦',
};

function prompt(question) {
  return new Promise(resolve => {
    rl.question(question, resolve);
  });
}

async function selectFromList(fieldName, options) {
  console.log(`\nSelect ${fieldName}:`);
  options.forEach((opt, idx) => {
    let display = opt;
    if (fieldName === 'spiciness' && SPICE_MAP[opt]) {
      display = `${opt} ${SPICE_MAP[opt]}`;
    }
    if (fieldName === 'feature_status' && STATUS_MAP[opt]) {
      display = `${opt} ${STATUS_MAP[opt]}`;
    }
    console.log(`  ${idx + 1}. ${display}`);
  });

  const selection = await prompt('Enter number (or multiple comma-separated for arrays): ');
  const indices = selection.split(',').map(s => parseInt(s.trim()) - 1);

  if (indices.length === 1) {
    return options[indices[0]];
  }
  return indices.map(idx => options[idx]).filter(Boolean);
}

async function addMetadataToFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Check if file already has frontmatter
  if (content.startsWith('---')) {
    console.log(`\n⚠️  File already has frontmatter: ${filePath}`);
    const overwrite = await prompt('Do you want to merge metadata? (y/n): ');
    if (overwrite.toLowerCase() !== 'y') {
      return;
    }
  }

  console.log(`\n📄 Adding metadata to: ${path.basename(filePath)}`);

  // Collect metadata
  const metadata = {
    sidebar_position: parseInt(await prompt('Sidebar position (number): ')) || 99,
    title: await prompt('Document title: '),
    content_type: await selectFromList('content_type', METADATA_TEMPLATE.content_type),
    feature_status: await selectFromList('feature_status', METADATA_TEMPLATE.feature_status),
    audience: await selectFromList('audience', METADATA_TEMPLATE.audience),
    spiciness: await selectFromList('spiciness', METADATA_TEMPLATE.spiciness),
    visibility: await selectFromList('visibility', METADATA_TEMPLATE.visibility),
    maturity: await selectFromList('maturity', METADATA_TEMPLATE.maturity),
    related_features: (await prompt('Related features (comma-separated): '))
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    tags: (await prompt('Tags (comma-separated): '))
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    last_reviewed: new Date().toISOString().split('T')[0],
  };

  // Add review cycle for certain types
  if (
    ['roadmap', 'architecture'].includes(metadata.content_type) ||
    ['experimental', 'beta'].includes(metadata.feature_status)
  ) {
    const cycles = ['weekly', 'monthly', 'quarterly', 'annually'];
    console.log('\nSelect review cycle:');
    cycles.forEach((cycle, idx) => console.log(`  ${idx + 1}. ${cycle}`));
    const cycleIdx = parseInt(await prompt('Enter number: ')) - 1;
    metadata.review_cycle = cycles[cycleIdx];
  }

  // Build frontmatter
  let frontmatter = '---\n';
  for (const [key, value] of Object.entries(metadata)) {
    if (Array.isArray(value) && value.length > 0) {
      frontmatter += `${key}: [${value.map(v => `"${v}"`).join(', ')}]\n`;
    } else if (typeof value === 'string' && value.includes(' ')) {
      frontmatter += `${key}: "${value}"\n`;
    } else if (value) {
      frontmatter += `${key}: ${value}\n`;
    }
  }
  frontmatter += '---\n\n';

  // Update file
  let newContent;
  if (content.startsWith('---')) {
    // Replace existing frontmatter
    const endIdx = content.indexOf('---', 3) + 3;
    newContent = frontmatter + content.substring(endIdx).trimStart();
  } else {
    newContent = frontmatter + content;
  }

  fs.writeFileSync(filePath, newContent);
  console.log(`\n✅ Metadata added successfully!`);

  // Show preview
  console.log('\nPreview:');
  console.log('─'.repeat(50));
  console.log(frontmatter);
  console.log('─'.repeat(50));
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node add-metadata.js <file.md> [file2.md ...]');
    console.log('\nThis tool helps add structured metadata to documentation files.');
    process.exit(1);
  }

  console.log('🚀 Bike4Mind Documentation Metadata Tool\n');

  for (const file of args) {
    const filePath = path.resolve(file);
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      continue;
    }

    if (!filePath.endsWith('.md') && !filePath.endsWith('.mdx')) {
      console.error(`❌ Not a markdown file: ${filePath}`);
      continue;
    }

    await addMetadataToFile(filePath);
  }

  rl.close();
}

main().catch(console.error);
