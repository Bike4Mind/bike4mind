#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SidebarItem {
  type?: string;
  label?: string;
  items?: (string | SidebarItem)[];
}

interface SidebarsConfig {
  [key: string]: (string | SidebarItem)[];
}

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

class OrphanedDocsChecker {
  private docsDir: string;
  private sidebarPath: string;
  private allMdFiles: Set<string> = new Set();
  private referencedFiles: Set<string> = new Set();
  private nonExistentRefs: Set<string> = new Set();

  constructor() {
    this.docsDir = path.join(__dirname, '..', 'docs');
    this.sidebarPath = path.join(__dirname, '..', 'sidebars.ts');
  }

  // Find all .md files recursively
  private findAllMdFiles(dir: string, baseDir: string = ''): void {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        this.findAllMdFiles(filePath, path.join(baseDir, file));
      } else if (file.endsWith('.md') || file.endsWith('.mdx')) {
        // Store relative path without extension
        const relativePath = path.join(baseDir, file.replace(/\.(md|mdx)$/, ''));
        this.allMdFiles.add(relativePath);
      }
    }
  }

  // Extract referenced files from sidebar configuration
  private extractReferencedFiles(items: (string | SidebarItem)[]): void {
    for (const item of items) {
      if (typeof item === 'string') {
        this.referencedFiles.add(item);

        // Check if file actually exists
        const mdPath = path.join(this.docsDir, `${item}.md`);
        const mdxPath = path.join(this.docsDir, `${item}.mdx`);

        if (!fs.existsSync(mdPath) && !fs.existsSync(mdxPath)) {
          this.nonExistentRefs.add(item);
        }
      } else if (item.items) {
        this.extractReferencedFiles(item.items);
      }
    }
  }

  // Parse sidebars.ts file
  private parseSidebarsFile(): SidebarsConfig | null {
    try {
      // Read the TypeScript file
      const content = fs.readFileSync(this.sidebarPath, 'utf8');

      // Extract the sidebars object using regex
      // This is a simplified parser - for production, consider using a proper TS parser
      const match = content.match(/const\s+sidebars\s*:\s*SidebarsConfig\s*=\s*({[\s\S]*?});/);

      if (!match) {
        console.error(`${colors.red}Could not parse sidebars configuration${colors.reset}`);
        return null;
      }

      // Convert to valid JSON-like format for eval
      let sidebarContent = match[1];

      // Replace single quotes with double quotes
      sidebarContent = sidebarContent.replace(/'/g, '"');

      // Remove trailing commas
      sidebarContent = sidebarContent.replace(/,\s*}/g, '}');
      sidebarContent = sidebarContent.replace(/,\s*]/g, ']');

      // Remove comments
      sidebarContent = sidebarContent.replace(/\/\*[\s\S]*?\*\//g, '');
      sidebarContent = sidebarContent.replace(/\/\/.*/g, '');

      // Evaluate the object (Note: In production, use a proper parser)
      try {
        // eslint-disable-next-line no-eval
        const sidebars = eval(`(${sidebarContent})`);
        return sidebars;
      } catch (e) {
        console.error(`${colors.red}Error parsing sidebars object: ${e}${colors.reset}`);
        return null;
      }
    } catch (error) {
      console.error(`${colors.red}Error reading sidebars file: ${error}${colors.reset}`);
      return null;
    }
  }

  public check(): void {
    console.log(`${colors.cyan}${colors.bright}Checking for orphaned documentation files...${colors.reset}\n`);

    // Find all markdown files
    this.findAllMdFiles(this.docsDir);
    console.log(`${colors.blue}Found ${this.allMdFiles.size} total .md/.mdx files${colors.reset}`);

    // Parse sidebars configuration
    const sidebars = this.parseSidebarsFile();
    if (!sidebars) {
      return;
    }

    // Extract referenced files from all sidebars
    for (const sidebarKey of Object.keys(sidebars)) {
      this.extractReferencedFiles(sidebars[sidebarKey]);
    }
    console.log(`${colors.blue}Found ${this.referencedFiles.size} files referenced in sidebars${colors.reset}\n`);

    // Find orphaned files
    const orphanedFiles = Array.from(this.allMdFiles).filter(file => !this.referencedFiles.has(file));

    // Group orphaned files by directory
    const orphanedByDir: { [key: string]: string[] } = {};
    for (const file of orphanedFiles) {
      const dir = path.dirname(file);
      if (!orphanedByDir[dir]) {
        orphanedByDir[dir] = [];
      }
      orphanedByDir[dir].push(path.basename(file));
    }

    // Display results
    if (orphanedFiles.length === 0 && this.nonExistentRefs.size === 0) {
      console.log(`${colors.green}${colors.bright}✅ All documentation files are properly referenced!${colors.reset}`);
    } else {
      if (orphanedFiles.length > 0) {
        console.log(`${colors.red}${colors.bright}❌ Found ${orphanedFiles.length} orphaned files:${colors.reset}\n`);

        for (const [dir, files] of Object.entries(orphanedByDir)) {
          const dirName = dir === '.' ? 'root' : dir;
          console.log(`${colors.yellow}  ${dirName}/${colors.reset}`);
          for (const file of files) {
            console.log(`    - ${file}`);
          }
        }
      }

      if (this.nonExistentRefs.size > 0) {
        console.log(
          `\n${colors.red}${colors.bright}❌ Found ${this.nonExistentRefs.size} non-existent files referenced in sidebars:${colors.reset}\n`
        );
        for (const ref of this.nonExistentRefs) {
          console.log(`${colors.red}  - ${ref}${colors.reset}`);
        }
      }

      console.log(
        `\n${colors.cyan}💡 To fix this, update your sidebars.ts file to include these orphaned files.${colors.reset}`
      );
      process.exit(1);
    }
  }
}

// Run the checker
const checker = new OrphanedDocsChecker();
checker.check();
