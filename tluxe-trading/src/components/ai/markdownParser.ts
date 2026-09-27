/*
 * Minimal, SAFE Markdown parser for TLUXE AI answers. Produces a small AST rendered by <Markdown> as React elements —
 * never HTML strings, never dangerouslySetInnerHTML, so model output cannot inject markup or scripts.
 * Supported: fenced code (```lang), headings (#..######), bullet / numbered lists, block quotes, paragraphs,
 * inline code, **bold**, *italic* / _italic_, and http(s) links (anything else is plain text).
 */
export type Inline = { t: 'text'; v: string } | { t: 'code'; v: string } | { t: 'strong'; c: Inline[] } | { t: 'em'; c: Inline[] } | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'code'; lang: string | null; v: string }
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'para'; lines: Inline[][] };

const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] !== ch && src[i + 1] !== ' ') {
      const end = src.indexOf(ch, i + 1);
      if (end > i + 1 && src[end - 1] !== ' ' && (ch === '*' || !/\w/.test(src[end + 1] ?? ''))) {
        flush();
        out.push({ t: 'em', c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const close = src.indexOf('](', i + 1);
      const end = close > i ? src.indexOf(')', close + 2) : -1;
      if (close > i && end > close) {
        const href = src.slice(close + 2, end).trim();
        const label = src.slice(i + 1, close);
        flush();
        if (SAFE_URL.test(href)) out.push({ t: 'link', href, c: parseInline(label) });
        else out.push({ t: 'text', v: `${label} (${href})` }); // unsafe scheme (javascript:, data:, …): plain text only
        i = end + 1;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ t: 'para', lines: para.map(parseInline) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      endPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      blocks.push({ t: 'code', lang: fence[1] || null, v: body.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      endPara();
      blocks.push({ t: 'heading', level: h[1]!.length, c: parseInline(h[2]!.trim()) });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      endPara();
      const ordered = /\d/.test(li[1]!);
      const items: Inline[][] = [parseInline(li[2]!)];
      while (i + 1 < lines.length) {
        const next = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i + 1]!);
        if (!next || /\d/.test(next[1]!) !== ordered) break;
        items.push(parseInline(next[2]!));
        i++;
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      endPara();
      blocks.push({ t: 'quote', c: parseInline(q[1]!) });
      continue;
    }
    if (!line.trim()) {
      endPara();
      continue;
    }
    para.push(line);
  }
  endPara();
  return blocks;
}
