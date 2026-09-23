export type NewsCategory =
  | 'GOLD'
  | 'USD'
  | 'FED'
  | 'RATES'
  | 'INFLATION'
  | 'GEOPOLITICS'
  | 'COMEX';

export interface NewsItem {
  id: string;
  headline: string;
  source: string;
  url: string | null;
  publishedAt: number;
  categories: NewsCategory[];
}

export const NEWS_CATEGORIES: readonly NewsCategory[] = ['GOLD', 'USD', 'FED', 'RATES', 'INFLATION', 'GEOPOLITICS', 'COMEX'];
