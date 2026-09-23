import { Newspaper } from 'lucide-react';
import { useState } from 'react';
import { useServices } from '../../app/servicesContext';
import { useDisplayTimeZone } from '../../hooks/useDisplayTimeZone';
import { useStore } from '../../store/createStore';
import { NEWS_CATEGORIES, type NewsCategory, type NewsItem } from '../../types/news';
import { formatHm24 } from '../../utils/format';
import { EmptyState } from '../ui/EmptyState';
import { Panel } from '../ui/Panel';
import './news.css';

export function NewsList({ items, tz }: { items: NewsItem[]; tz: string }) {
  return (
    <ul className="news__list">
      {items.map((n) => (
        <li key={n.id} className="news__row">
          <span className="news__time num">{formatHm24(n.publishedAt, tz)}</span>
          <div className="news__body">
            {n.url ? (
              <a className="news__headline" href={n.url} target="_blank" rel="noreferrer noopener">{n.headline}</a>
            ) : (
              <span className="news__headline">{n.headline}</span>
            )}
            <span className="news__source">{n.source}</span>
          </div>
          {n.categories[0] && <span className="news__cat">{n.categories[0]}</span>}
        </li>
      ))}
    </ul>
  );
}

export function NewsPanel() {
  const { news } = useServices();
  const snap = useStore(news.store, (s) => s);
  const tz = useDisplayTimeZone();
  const [cat, setCat] = useState<NewsCategory | null>(null);
  const connected = snap.status === 'CONNECTED';
  const items = cat ? snap.items.filter((n) => n.categories.includes(cat)) : snap.items;

  return (
    <Panel
      id="news"
      title="Latest Market News"
      subtitle={connected ? `Source: ${snap.providerName}` : 'Provider: Not Connected'}
      icon={<Newspaper size={18} />}
      className="news-panel"
    >
      <div className="news__cats" role="group" aria-label="News categories">
        {NEWS_CATEGORIES.map((c) => (
          <button key={c} type="button" className="chip" aria-pressed={cat === c} disabled={!connected} onClick={() => setCat(cat === c ? null : c)}>
            {c}
          </button>
        ))}
      </div>
      {connected && items.length > 0 ? (
        <NewsList items={items} tz={tz} />
      ) : (
        <EmptyState
          icon={<Newspaper size={18} />}
          title={connected ? 'NO HEADLINES' : 'NEWS PROVIDER NOT CONNECTED'}
          message={connected ? 'No headlines in this category yet.' : 'Headlines appear here once a news provider is connected. No placeholder stories are shown.'}
        />
      )}
    </Panel>
  );
}
