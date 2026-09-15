/**
 * uploadTavernIcons - upload Craftpix icon zips to the tavern S3 bucket
 * and regenerate the icon manifest TS file.
 *
 * Usage (from repo root):
 *   pnpm tavern:upload-icons -- --bucket <appFilesBucket-name> [--region us-east-2]
 *     [--zips-dir ./craftpix-zips] [--dry-run]
 *
 * The script:
 *   1. Reads every *.zip in --zips-dir (default: ./craftpix-zips/, gitignored)
 *   2. For each zip, derives a pack slug from the filename, extracts to a
 *      temp dir, walks PNG/Background and PNG/without\\ background subdirs
 *   3. Uploads each PNG to S3 with key:
 *        tavern-icons/<pack-slug>/<bg|nobg>/<n>.png
 *      Existing keys are skipped (HeadObject probe).
 *   4. Regenerates apps/client/app/utils/tavern/iconManifest.generated.ts
 *      with the full per-pack icon list, including A1-H8 slot coordinates.
 *
 * Bucket name discovery:
 *   --bucket flag (preferred), else $APP_FILES_BUCKET env var.
 *   Find it once with: `aws s3 ls --profile groktool | grep app-files`
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface CliArgs {
  bucket: string;
  region: string;
  zipsDir: string;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const map: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
    map[key] = val;
    if (val !== 'true') i++;
  }
  const bucket = map['bucket'] || process.env.APP_FILES_BUCKET || '';
  if (!bucket) {
    console.error(
      'Missing bucket name. Pass --bucket <name> or set APP_FILES_BUCKET env.\n' +
        '  Find it with: aws s3 ls --profile groktool | grep app-files'
    );
    process.exit(1);
  }
  return {
    bucket,
    region: map['region'] || 'us-east-2',
    zipsDir: path.resolve(map['zips-dir'] || './craftpix-zips'),
    dryRun: map['dry-run'] === 'true',
  };
}

const args = parseArgs();
const s3 = new S3Client({ region: args.region });

interface IconEntry {
  number: number;
  /** Letter+digit grid coordinate (8 cols x 8 rows = A1..H8 covers up to 64). */
  slot: string;
  variant: 'bg' | 'nobg';
  s3Key: string;
}

interface PackEntry {
  slug: string;
  name: string;
  variants: ('bg' | 'nobg')[];
  icons: IconEntry[];
}

/** "craftpix-net-398448-50-rpg-mining-icons.zip" -> "rpg-mining-icons" */
function packSlugFromZip(filename: string): string {
  const stripped = filename
    .replace(/\.zip$/i, '')
    .replace(/\s*\(\d+\)$/, '') // " (1)" duplicate suffix
    .replace(/^craftpix-net-\d+-/i, '')
    .replace(/^free-/i, '')
    .replace(/^\d+-/, ''); // "50-rpg-mining-icons" → "rpg-mining-icons"
  return stripped.toLowerCase().replace(/[_\s]+/g, '-');
}

function packNameFromSlug(slug: string): string {
  return slug
    .split('-')
    .map(s => (s === 'rpg' ? 'RPG' : s.charAt(0).toUpperCase() + s.slice(1)))
    .join(' ');
}

/** Map icon number -> "A1" through "H8" (8 cols x 8 rows). For >64, wraps to I, J... */
function computeSlot(n: number): string {
  const idx = n - 1;
  const row = String.fromCharCode(65 + Math.floor(idx / 8)); // A, B, C, ...
  const col = (idx % 8) + 1;
  return `${row}${col}`;
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: args.bucket, Key: key }));
    return true;
  } catch (e: unknown) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

async function uploadOne(localPath: string, key: string): Promise<'uploaded' | 'skipped'> {
  if (await objectExists(key)) return 'skipped';
  if (args.dryRun) {
    console.log(`  [dry-run] PUT ${key}`);
    return 'uploaded';
  }
  const Body = fs.readFileSync(localPath);
  await s3.send(
    new PutObjectCommand({
      Bucket: args.bucket,
      Key: key,
      Body,
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
  return 'uploaded';
}

async function processZip(zipPath: string): Promise<PackEntry | null> {
  const filename = path.basename(zipPath);
  const slug = packSlugFromZip(filename);
  console.log(`\n• ${filename}`);
  console.log(`  slug: ${slug}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'craftpix-'));
  try {
    execSync(`unzip -qq -o ${JSON.stringify(zipPath)} -d ${JSON.stringify(tmp)}`, { stdio: 'pipe' });

    // PNG/ may or may not be present as a wrapper dir.
    const pngRoot = fs.existsSync(path.join(tmp, 'PNG')) ? path.join(tmp, 'PNG') : tmp;
    const subdirs = fs.readdirSync(pngRoot).filter(n => fs.statSync(path.join(pngRoot, n)).isDirectory());

    const variantDirs: { variant: 'bg' | 'nobg'; subdir: string }[] = [];
    for (const sd of subdirs) {
      const lc = sd.toLowerCase();
      if (lc === 'background') variantDirs.push({ variant: 'bg', subdir: sd });
      else if (lc === 'without background' || lc === 'without_background' || lc === 'no-background') {
        variantDirs.push({ variant: 'nobg', subdir: sd });
      }
    }
    if (variantDirs.length === 0) {
      // Some packs ship a flat PNG/ directory with numbered files directly
      // and no Background/without-background subdirs (e.g., the gems and
      // cooking-skill packs). Treat the whole PNG dir as a single 'bg'
      // variant when this layout is detected.
      const flatPngs = fs.existsSync(pngRoot) ? fs.readdirSync(pngRoot).filter(n => /^\d+\.png$/i.test(n)) : [];
      if (flatPngs.length > 0) {
        console.log(`  flat PNG layout detected (${flatPngs.length} files); treating as 'bg' variant`);
        variantDirs.push({ variant: 'bg', subdir: '' });
      } else {
        console.log('  ⚠️  no Background / without-background subdirs found, skipping');
        return null;
      }
    }

    const icons: IconEntry[] = [];
    const variantsSeen: ('bg' | 'nobg')[] = [];
    for (const { variant, subdir } of variantDirs) {
      const dir = path.join(pngRoot, subdir);
      const pngs = fs
        .readdirSync(dir)
        .filter(n => /^\d+\.png$/i.test(n))
        .sort((a, b) => parseInt(a) - parseInt(b));
      console.log(`  ${variant}: ${pngs.length} icons`);
      variantsSeen.push(variant);
      let uploaded = 0;
      let skipped = 0;
      for (const png of pngs) {
        const num = parseInt(png);
        const s3Key = `tavern-icons/${slug}/${variant}/${num}.png`;
        const result = await uploadOne(path.join(dir, png), s3Key);
        if (result === 'uploaded') uploaded++;
        else skipped++;
        icons.push({ number: num, slot: computeSlot(num), variant, s3Key });
      }
      console.log(`    uploaded ${uploaded}, skipped ${skipped}`);
    }

    return {
      slug,
      name: packNameFromSlug(slug),
      variants: [...new Set(variantsSeen)],
      icons,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function generateManifestTs(packs: PackEntry[]): string {
  return `/**
 * iconManifest.generated.ts — DO NOT EDIT BY HAND.
 *
 * Generated by packages/scripts/src/uploadTavernIcons.ts
 *
 * Each entry references an icon uploaded to S3 with key:
 *   tavern-icons/<pack-slug>/<bg|nobg>/<n>.png
 *
 * Slot coordinates are A1–H8 (8 cols × 8 rows). The IconBrowser uses
 * these so Erik can refer to specific icons by slot when curating
 * mappings ("B14 looks more like Mithril Ore").
 */

export interface IconEntry {
  /** 1-based icon number from the original Craftpix pack. */
  number: number;
  /** Grid coordinate, e.g. "A1" through "H8". */
  slot: string;
  /** Background-frame variant or transparent. */
  variant: 'bg' | 'nobg';
  /** S3 key — convert to a URL with useGetAppFileUrl({ key }). */
  s3Key: string;
  /** Human-curated or LLM-inferred semantic name (filled by future flow). */
  inferredName?: string;
}

export interface IconPack {
  slug: string;
  name: string;
  variants: ('bg' | 'nobg')[];
  icons: IconEntry[];
}

export const ICON_MANIFEST: Record<string, IconPack> = ${JSON.stringify(
    Object.fromEntries(packs.map(p => [p.slug, p])),
    null,
    2
  )};

export const ICON_PACK_SLUGS: string[] = ${JSON.stringify(
    packs.map(p => p.slug),
    null,
    2
  )};
`;
}

async function main() {
  if (!fs.existsSync(args.zipsDir)) {
    console.error(`Zips dir not found: ${args.zipsDir}`);
    console.error(`Create the dir and drop your craftpix-net-*.zip files there.`);
    process.exit(1);
  }

  const zips = fs
    .readdirSync(args.zipsDir)
    .filter(n => n.toLowerCase().endsWith('.zip'))
    .sort();
  console.log(`Found ${zips.length} zip(s) in ${args.zipsDir}`);
  console.log(`Bucket: ${args.bucket} (${args.region})`);
  if (args.dryRun) console.log('(DRY RUN — no S3 writes, no manifest write)');

  const packs: PackEntry[] = [];
  for (const zip of zips) {
    const pack = await processZip(path.join(args.zipsDir, zip));
    if (pack) {
      // Dedupe by slug - newest wins (e.g., "(1)" suffixed copies)
      const idx = packs.findIndex(p => p.slug === pack.slug);
      if (idx >= 0) packs[idx] = pack;
      else packs.push(pack);
    }
  }

  // Sort packs alphabetically for deterministic output.
  packs.sort((a, b) => a.slug.localeCompare(b.slug));

  // Manifest path - relative to packages/scripts/src/uploadTavernIcons.ts
  const manifestPath = path.resolve(__dirname, '../../../apps/client/app/utils/tavern/iconManifest.generated.ts');
  const manifestSrc = generateManifestTs(packs);

  if (args.dryRun) {
    console.log(`\n[dry-run] would write manifest to ${manifestPath} (${manifestSrc.length} bytes)`);
  } else {
    fs.writeFileSync(manifestPath, manifestSrc);
    const totalIcons = packs.reduce((n, p) => n + p.icons.length, 0);
    console.log(`\nWrote ${manifestPath}`);
    console.log(`  ${packs.length} packs, ${totalIcons} icons`);
  }
}

main().catch(err => {
  console.error('\nUpload failed:', err);
  process.exit(1);
});
