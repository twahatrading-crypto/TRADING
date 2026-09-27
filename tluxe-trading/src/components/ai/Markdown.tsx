import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from './markdownParser';

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return <Fragment key={i}>{n.v}</Fragment>;
      case 'code':
        return <code key={i}>{n.v}</code>;
      case 'strong':
        return <strong key={i}>{inline(n.c)}</strong>;
      case 'em':
        return <em key={i}>{inline(n.c)}</em>;
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {inline(n.c)}
          </a>
        );
    }
  });
}

function block(b: Block, i: number): ReactNode {
  switch (b.t) {
    case 'code':
      return (
        <pre key={i} className="ai-md__pre" data-lang={b.lang ?? undefined}>
          <code>{b.v}</code>
        </pre>
      );
    case 'heading':
      return (
        <p key={i} className={`ai-md__h ai-md__h${Math.min(b.level, 3)}`} role="heading" aria-level={b.level}>
          {inline(b.c)}
        </p>
      );
    case 'list':
      return b.ordered ? (
        <ol key={i}>{b.items.map((it, k) => <li key={k}>{inline(it)}</li>)}</ol>
      ) : (
        <ul key={i}>{b.items.map((it, k) => <li key={k}>{inline(it)}</li>)}</ul>
      );
    case 'quote':
      return <blockquote key={i}>{inline(b.c)}</blockquote>;
    case 'para':
      return (
        <p key={i}>
          {b.lines.map((l, k) => (
            <Fragment key={k}>
              {k > 0 && <br />}
              {inline(l)}
            </Fragment>
          ))}
        </p>
      );
  }
}

/** Renders TLUXE AI Markdown as plain React elements (no raw HTML is ever interpreted). */
export function Markdown({ text }: { text: string }) {
  return <div className="ai-md">{parseMarkdown(text).map(block)}</div>;
}
