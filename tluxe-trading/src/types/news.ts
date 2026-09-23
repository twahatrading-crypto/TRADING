export type NewsCategory =
  | 'GOLD'
  | 'USD'
  | 'FED'
  | 'RATES'
  | 'INFLATION'
  | 'GEOPOLITICS'
  | 'COMEX'
  | 'SILVER'
  | 'FX'
  | 'CRYPTO'
  | 'EQUITIES';

export interface NewsItem {
  id: string;
  headline: string;
  source: string;
  url: string | null;
  publishedAt: number;
  categories: NewsCategory[];
  /** Canonical instrument ids the provider tagged, if any. */
  instruments?: string[];
}

export const NEWS_CATEGORIES: readonly NewsCategory[] = [
  'GOLD', 'SILVER', 'USD', 'FED', 'RATES', 'INFLATION', 'GEOPOLITICS', 'COMEX', 'FX', 'CRYPTO', 'EQUITIES',
];
