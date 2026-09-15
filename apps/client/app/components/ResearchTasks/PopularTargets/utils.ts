import { DataSourceType, DataSource } from './types';
import earningsData from '../data/earnings-targets.json';
import pressData from '../data/press-targets.json';
import aiData from '../data/ai-targets.json';
import jobsData from '../data/jobs-targets.json';
import maData from '../data/m_and_a-targets.json';
import secData from '../data/sec-targets.json';
import productsData from '../data/products-targets.json';
import newsData from '../data/news-targets.json';

export function getGradient(index: number, total: number) {
  const hue1 = Math.round((360 / total) * index);
  const hue2 = (hue1 + 30) % 360;
  const color1 = `hsl(${hue1}, 70%, 50%)`;
  const color2 = `hsl(${hue2}, 70%, 40%)`;
  return {
    gradient: `linear-gradient(135deg, ${color1} 0%, ${color2} 100%)`,
    accent: color1,
  };
}

export function downloadTemplateData() {
  const DATA_SOURCES: Record<DataSourceType, DataSource> = {
    earnings: earningsData as DataSource,
    press: pressData as DataSource,
    ai: aiData as DataSource,
    jobs: jobsData as DataSource,
    ma: maData as DataSource,
    sec: secData as DataSource,
    products: productsData as DataSource,
    news: newsData as DataSource,
  };

  const header = 'Company,Ticker,URL,Type,Category,Category Description';

  const rows: string[] = [];

  function csvEscape(value: string) {
    if (value == null) return '';
    // Escape double quotes by doubling them, and wrap in quotes if contains comma, quote, or newline
    const needsQuotes = /[",\n]/.test(value);
    let escaped = value.replace(/"/g, '""');
    if (needsQuotes) {
      escaped = `"${escaped}"`;
    }
    return escaped;
  }

  Object.values(DATA_SOURCES).forEach(source => {
    source.targets.forEach(target => {
      const values = [target.company, target.ticker, target.url, target.category, source.title, source.description].map(
        v => csvEscape(String(v ?? ''))
      );
      rows.push(values.join(','));
    });
  });

  return [header, ...rows].join('\n');
}

export const PAGE_SIZE = 9999;
