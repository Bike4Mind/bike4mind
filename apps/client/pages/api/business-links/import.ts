// POST /api/business-links/import - Import research links from CSV

import { ResearchLink, ResearchLinkCategory } from '@bike4mind/database/content';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';

interface ICsvRow {
  name: string;
  ticker: string;
  url: string;
  type: string;
  categoryName: string;
  categoryDescription: string;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // End of field
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  // Push the last field
  result.push(current);

  return result;
}

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown>(async (req, res) => {
    ensureAdmin(req.user.isAdmin);
    const body = req.body as { csv?: string };
    const { csv } = body;

    if (!csv || typeof csv !== 'string') {
      return res.status(400).json({ message: 'CSV data is required' });
    }

    try {
      const lines = csv.split('\n').filter(line => line.trim());
      const rows = lines.slice(1);

      if (rows.length === 0) {
        return res.status(400).json({ message: 'CSV file is empty' });
      }

      // Track categories to avoid duplicate lookups
      const categoryCache = new Map<string, string>();

      const parsedRows: ICsvRow[] = rows.map(line => {
        const values = parseCsvLine(line);
        return {
          name: values[0] || '',
          ticker: values[1] || '',
          url: values[2] || '',
          type: values[3] || '',
          categoryName: values[4] || '',
          categoryDescription: values[5] || '',
        };
      });

      let created = 0;
      let updated = 0;
      let errors = 0;

      for (const row of parsedRows) {
        try {
          if (!row.name || !row.url) {
            errors++;
            continue;
          }

          let categoryId: string | null = null;

          // Create or find category if provided
          if (row.categoryName) {
            if (categoryCache.has(row.categoryName)) {
              categoryId = categoryCache.get(row.categoryName)!;
            } else {
              let category = await ResearchLinkCategory.findOne({ name: row.categoryName });

              if (!category) {
                category = await ResearchLinkCategory.create({
                  name: row.categoryName,
                  description: row.categoryDescription || row.categoryName,
                });
              }

              categoryId = category._id.toString();
              categoryCache.set(row.categoryName, categoryId);
            }
          }

          const existingLink = await ResearchLink.findOne({ url: row.url });

          if (existingLink) {
            await ResearchLink.findByIdAndUpdate(existingLink._id, {
              name: row.name,
              ticker: row.ticker,
              type: row.type,
              categoryId,
            });
            updated++;
          } else {
            await ResearchLink.create({
              name: row.name,
              url: row.url,
              ticker: row.ticker,
              type: row.type,
              categoryId,
            });
            created++;
          }
        } catch (error) {
          console.error('Error processing row:', error);
          errors++;
        }
      }

      return res.json({
        message: 'Import completed',
        stats: {
          created,
          updated,
          errors,
          total: parsedRows.length,
        },
      });
    } catch (error) {
      console.error('Import error:', error);
      return res.status(500).json({ message: 'Failed to import CSV', error: String(error) });
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
