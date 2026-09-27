import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AiPanel } from '../../components/ai/AiPanel';
import { Markdown } from '../../components/ai/Markdown';
import { AI_NOT_CONNECTED_NOTICE, AiService } from '../../services/ai/AiService';
import { NullAiProvider } from '../../services/ai/AiProvider';
import { AI_CONTEXT_LIMITS, boundedForAi, buildAiContext, compactForAi } from '../../services/ai/context/buildAiContext';
import { AI_ENGINE_IDS } from '../../services/ai/context/types';
import { connectServices, createServices, defaultProviders, type Services } from '../../services/registry';
import { ManualPriceProvider, memoryStorage } from '../../test/providers';
import { renderWithServices } from '../../test/renderWithServices';
import { TluxeAiClient } from './client';
import { DEFAULT_TLUXE_AI_CONFIG, sanitizeTluxeAiConfig, TLUXE_AI_CONFIG_KEY, type TluxeAiConfig } from './config';
import { FakeAiBackend, hanging, health } from './testing/FakeAiBackend';
import { boundHistory, TluxeAiProvider } from './TluxeAiProvider';

/* TEST DATA ONLY — FakeAiBackend stands in for the local TLUXE AI backend; nothing here reaches OpenAI. */

const TOKEN = 'b'.repeat(40);
const FAKE_OPENAI_KEY = 'sk-proj-TESTONLYabcdefghijklmnopqrstuvwxyz0123456789';

let teardown: (() => void) | null = null;
afterEach(() => {
  teardown?.();
  teardown = null;
});

function rig(o: { cfg?: Partial<TluxeAiConfig>; before?: (b: FakeAiBackend) => void } = {}) {
  const backend = new FakeAiBackend();
  o.before?.(backend);
  const cfg: TluxeAiConfig = { ...DEFAULT_TLUXE_AI_CONFIG, enabled: true, token: TOKEN, healthMs: 3_600_000, ...o.cfg };
  const provider = new TluxeAiProvider(cfg, { client: new TluxeAiClient(cfg.url, cfg.token, backend.fetch) });
  return { backend, provider, cfg };
}

async function connected(o: Parameters<typeof rig>[0] = {}) {
  const r = rig(o);
  await r.provider.checkHealth();
  const svc = new AiService(r.provider);
  const stop = svc.start();
  teardown = stop;
  return { ...r, svc };
}

const texts = (svc: AiService) => svc.store.getState().messages.map((m) => `${m.role}:${m.text}`);

describe('TLUXE AI — secrets never reach the browser', () => {
  it('no OpenAI key, OpenAI endpoint or OpenAI SDK anywhere in the frontend source', () => {
    const sources = import.meta.glob(['/src/**/*.{ts,tsx,css}', '!/src/**/*.test.{ts,tsx}', '!/src/**/testing/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    for (const [f, s] of Object.entries(sources)) {
      expect(s, f).not.toMatch(/sk-(proj-)?[A-Za-z0-9_-]{16,}/);
      expect(s, f).not.toMatch(/api\.openai\.com/);
      expect(s, f).not.toMatch(/from ['"]openai['"]/);
      expect(s, f).not.toMatch(/OPENAI_API_KEY\s*[:=]\s*['"][^'"]+['"]/);
      expect(s, f).not.toMatch(/import\.meta\.env\.[A-Z_]*OPENAI/);
    }
  });

  it('an OpenAI-shaped key is refused as the backend token and never stored', () => {
    expect(sanitizeTluxeAiConfig({ enabled: true, token: FAKE_OPENAI_KEY }).token).toBe('');
    const storage = memoryStorage({ [TLUXE_AI_CONFIG_KEY]: JSON.stringify({ enabled: true, token: FAKE_OPENAI_KEY }) });
    expect(defaultProviders(storage).ai).toBeInstanceOf(NullAiProvider);
  });

  it('requests carry ONLY the backend token (header), never a key, never in a URL; credentials omitted', async () => {
    const { backend, svc } = await connected();
    await svc.send('chat', 'hello');
    for (const c of backend.calls) {
      expect(c.url).toMatch(/^http:\/\/127\.0\.0\.1:8767\/api\/ai\/(health|chat)$/);
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.stringify(c)).not.toMatch(/sk-/);
    }
    expect(backend.chats()[0]!.body).not.toHaveProperty('model');
    expect(backend.chats()[0]!.body).not.toHaveProperty('tools');
  });
});

describe('TLUXE AI — truthful connection status', () => {
  it('backend running but OPENAI_API_KEY missing → Not Connected (with the reason)', async () => {
    const r = rig({ before: (b) => (b.healthBody = health({ status: 'NOT_CONFIGURED', connected: false, reason: 'OPENAI_API_KEY is not set on the TLUXE AI backend.' })) });
    await r.provider.checkHealth();
    expect(r.provider.status()).toBe('NOT_CONNECTED');
    expect(r.provider.statusReason()).toMatch(/OPENAI_API_KEY is not set/);
    expect(r.provider.name).toBeNull();
  });

  it('backend unreachable → Not Connected', async () => {
    const r = rig({ before: (b) => (b.down = true) });
    await r.provider.checkHealth();
    expect(r.provider.status()).toBe('NOT_CONNECTED');
    expect(r.provider.statusReason()).toMatch(/not reachable/);
  });

  it('wrong backend token / auth or model problems → Not Connected', async () => {
    for (const setup of [
      (b: FakeAiBackend) => {
        b.healthStatus = 401;
        b.healthBody = { error: { code: 'UNAUTHORIZED', message: 'x' } } as never;
      },
      (b: FakeAiBackend) => (b.healthBody = health({ status: 'AUTH_ERROR', connected: false, reason: 'OpenAI rejected the API key.' })),
      (b: FakeAiBackend) => (b.healthBody = health({ status: 'MODEL_UNAVAILABLE', connected: false, reason: 'model' })),
      (b: FakeAiBackend) => (b.healthBody = health({ status: 'CONNECTED', connected: false })), // inconsistent → not connected
    ]) {
      const r = rig({ before: setup });
      await r.provider.checkHealth();
      expect(r.provider.status()).toBe('NOT_CONNECTED');
    }
  });

  it('provider verified by the backend → Connected, name shows the server-selected model', async () => {
    const r = rig();
    await r.provider.checkHealth();
    expect(r.provider.status()).toBe('CONNECTED');
    expect(r.provider.name).toBe('OpenAI · gpt-5.5');
  });

  it('UI: Not Connected until verified; Connected afterwards; engine access Read Only', async () => {
    const r = rig({ before: (b) => (b.healthBody = health({ status: 'NOT_CONFIGURED', connected: false, reason: 'OPENAI_API_KEY is not set.' })) });
    const { services } = renderWithServices(<AiPanel />, { ai: r.provider });
    teardown = connectServices(services);
    await act(async () => {
      await r.provider.checkHealth();
    });
    expect(screen.getByText('Not Connected')).toBeInTheDocument();
    expect(screen.getByTestId('ai-provider-status').textContent).toBe('Not connected');
    expect(screen.getByTestId('ai-engine-access').textContent).toBe('Read Only');
    expect(screen.getByTestId('ai-market-status').textContent).toBe('Not connected'); // no market provider → never "Live"
    r.backend.healthBody = health();
    await act(async () => {
      await r.provider.checkHealth();
    });
    expect(screen.getByText('Connected', { selector: '.ai__ws dd' })).toBeInTheDocument();
    expect(screen.getByText(/Model: OpenAI · gpt-5\.5 · read-only/)).toBeInTheDocument();
  });
});

describe('TLUXE AI — chat', () => {
  it('real request / response path: answer from the backend, rendered as Markdown', async () => {
    const { backend, svc } = await connected({ before: (b) => (b.chat = async () => ({ status: 200, body: { text: '**Gold** is `GC`:\n\n- one\n- two\n\n```ts\nconst x = 1;\n```', model: 'gpt-5.5' } })) });
    await svc.send('chat', 'What is GC?');
    expect(texts(svc)[1]).toMatch(/^assistant:\*\*Gold\*\*/);
    expect(backend.chats()[0]!.body).toMatchObject({ mode: 'chat', messages: [{ role: 'user', content: 'What is GC?' }] });
    const { container } = render(<Markdown text={svc.store.getState().messages[1]!.text} />);
    expect(container.querySelector('strong')!.textContent).toBe('Gold');
    expect(container.querySelector('li')!.textContent).toBe('one');
    expect(container.querySelector('pre code')!.textContent).toBe('const x = 1;');
  });

  it('multi-turn: earlier answered turns are sent as history; failed turns are not', async () => {
    let fail = false;
    const { backend, svc } = await connected({
      before: (b) =>
        (b.chat = async (body) => (fail ? { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'OpenAI rate limit or quota reached - try again later.' } } } : { status: 200, body: { text: `A${body.messages.length}`, model: 'gpt-5.5' } })),
    });
    await svc.send('chat', 'Q1');
    await svc.send('chat', 'Q2');
    fail = true;
    await svc.send('chat', 'Q3');
    fail = false;
    await svc.send('chat', 'Q4');
    expect(backend.chats()[1]!.body).toMatchObject({ messages: [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }] });
    const last = backend.chats().at(-1)!.body as { messages: { content: string }[] };
    expect(last.messages.map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2', 'A3', 'Q4']); // Q3 (failed) excluded
  });

  it('Stop cancels the request: no answer is shown, Retry re-sends it', async () => {
    const { backend, svc } = await connected({ before: (b) => (b.chat = hanging) });
    const p = svc.send('chat', 'long question');
    await Promise.resolve();
    expect(svc.store.getState().pending).toBe(true);
    svc.cancel();
    await p;
    expect(svc.store.getState().pending).toBe(false);
    expect(texts(svc)).toEqual(['user:long question', 'system:Generation stopped.']);
    expect(svc.store.getState().messages[1]!.retryOf).toBeDefined();
    backend.chat = async () => ({ status: 200, body: { text: 'done', model: 'gpt-5.5' } });
    await svc.retry();
    expect(texts(svc)).toEqual(['user:long question', 'assistant:done']);
  });

  it('timeout → useful error with Retry; HTTP errors map to readable messages; no fake answer', async () => {
    const { svc } = await connected({ cfg: { requestTimeoutMs: 30 }, before: (b) => (b.chat = hanging) });
    await svc.send('chat', 'q');
    const err = svc.store.getState().messages.at(-1)!;
    expect(err.text).toMatch(/^Request failed: TLUXE AI did not answer within/);
    expect(err.retryOf).toBeDefined();
    expect(svc.store.getState().messages.some((m) => m.role === 'assistant')).toBe(false);

    const r2 = await connected({ before: (b) => (b.chat = async () => ({ status: 502, body: { error: { code: 'PROVIDER_AUTH', message: 'OpenAI rejected the API key (check OPENAI_API_KEY on the TLUXE AI backend).' } } })) });
    await r2.svc.send('chat', 'q');
    expect(texts(r2.svc).at(-1)).toMatch(/OpenAI rejected the API key/);
  });

  it('empty provider answer is an error, never a placeholder reply', async () => {
    const { svc } = await connected({ before: (b) => (b.chat = async () => ({ status: 200, body: { text: '   ', model: 'gpt-5.5' } })) });
    await svc.send('chat', 'q');
    expect(svc.store.getState().messages.some((m) => m.role === 'assistant')).toBe(false);
    expect(texts(svc).at(-1)).toMatch(/Request failed: The AI provider returned no answer/);
  });

  it('invalid payload rejected by the backend is surfaced without Retry', async () => {
    const { svc } = await connected({ before: (b) => (b.chat = async () => ({ status: 400, body: { error: { code: 'MESSAGE_TOO_LONG', message: 'A message may have at most 8000 characters.' } } })) });
    await svc.send('chat', 'x');
    const last = svc.store.getState().messages.at(-1)!;
    expect(last.text).toBe('Request failed: A message may have at most 8000 characters.');
    expect(last.retryOf).toBeUndefined();
  });

  it('no duplicate submissions: a second send while one is pending is ignored', async () => {
    const { backend, svc } = await connected({ before: (b) => (b.chat = hanging) });
    const a = svc.send('chat', 'one');
    const b = svc.send('chat', 'one');
    const c = svc.send('chat', 'two');
    await Promise.resolve();
    expect(backend.chats()).toHaveLength(1);
    svc.cancel();
    await Promise.all([a, b, c]);
    expect(texts(svc).filter((t) => t.startsWith('user:'))).toEqual(['user:one']);
  });

  it('UI: double click on Send sends once; Stop button while pending; Clear empties the conversation', async () => {
    const r = rig({ before: (b) => (b.chat = hanging) });
    await r.provider.checkHealth();
    const { services } = renderWithServices(<AiPanel />, { ai: r.provider });
    fireEvent.change(screen.getByLabelText('Message TLUXE AI'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.submit(screen.getByLabelText('Message TLUXE AI'));
    await act(async () => Promise.resolve());
    expect(r.backend.chats()).toHaveLength(1);
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await act(async () => Promise.resolve());
    expect(await screen.findByText('Generation stopped.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Clear conversation/ }));
    expect(services.ai.store.getState().messages).toEqual([]);
  });

  it('no provider configured → the existing safe notice, never an answer', async () => {
    const svc = new AiService(new NullAiProvider());
    await svc.send('chat', 'hello');
    expect(texts(svc)).toEqual(['user:hello', `system:${AI_NOT_CONNECTED_NOTICE}`]);
  });

  it('history is bounded (turns / characters) and starts on a user turn', () => {
    const turns = Array.from({ length: 60 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `t${i}` }));
    const h = boundHistory(turns);
    expect(h.length).toBeLessThanOrEqual(20);
    expect(h[0]!.role).toBe('user');
    expect(boundHistory([{ role: 'user', content: 'x'.repeat(50_000) }])).toEqual([]);
  });
});

describe('TLUXE AI — read-only permission boundary', () => {
  it('Research / Analysis / Tools and quick actions are not faked: refused by the provider, disabled in the UI', async () => {
    const { backend, svc } = await connected();
    await svc.send('research', 'find news');
    await svc.runAction('chat', 'analyze-market');
    expect(backend.chats()).toHaveLength(0);
    expect(svc.store.getState().messages.filter((m) => m.role === 'system').every((m) => /Only Chat is available/.test(m.text))).toBe(true);

    renderWithServices(<AiPanel />);
    for (const a of ['Analyze Market', 'Check My Engine', 'Find Problems', 'Deep Research', 'Build Feature']) expect(screen.getByRole('button', { name: a })).toBeDisabled();
    fireEvent.click(screen.getByRole('tab', { name: 'Research' }));
    expect(screen.getByLabelText('Message TLUXE AI')).toBeDisabled();
    expect(screen.getByTestId('ai-not-ready')).toHaveTextContent(/Chat only/);
  });

  it('the chat body is only {mode, messages, context}: no tools, no model, no instructions from the browser', async () => {
    const { backend, svc } = await connected();
    svc.setContextSource(() => ({ schema: 'tluxe.ai.context.v1' }) as never);
    await svc.send('chat', 'q');
    expect(Object.keys(backend.chats()[0]!.body as object).sort()).toEqual(['context', 'messages', 'mode']);
  });

  it('markdown from the model cannot inject HTML or script links', () => {
    const { container } = render(<Markdown text={'<img src=x onerror=alert(1)> [click](javascript:alert(1)) [ok](https://example.com)'} />);
    expect(container.querySelector('img')).toBeNull();
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com']);
    expect(links[0]!.getAttribute('rel')).toMatch(/noopener/);
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('TLUXE AI — read-only market / engine context', () => {
  function services(storage = memoryStorage({ 'tluxe.instrument.v1': 'GC' })): Services {
    const s = createServices(defaultProviders(), { storage });
    teardown = connectServices(s);
    return s;
  }

  it('no market data → every market / engine field is UNAVAILABLE with a reason, no values', () => {
    const s = services();
    const ctx = buildAiContext(s, 1_790_000_000_000);
    expect(ctx.readOnly).toBe(true);
    expect(ctx.instrument.id).toBe('GC');
    for (const f of [ctx.provider, ctx.freshness, ctx.quote, ctx.candles]) {
      expect(f.status).toBe('UNAVAILABLE');
      expect(f.value).toBeUndefined();
      expect(f.reason).toBeTruthy();
    }
    for (const k of AI_ENGINE_IDS) {
      expect(ctx.engines[k].status, k).toBe('UNAVAILABLE');
      expect(ctx.engines[k].value, k).toBeUndefined();
    }
    expect(ctx.timeframe).toEqual({ value: 'H1', source: 'dashboard chart default' });
  });

  it('live provider data → LIVE quote / candles with source; after the feed goes silent → STALE (never re-labelled LIVE)', () => {
    const futures = new ManualPriceProvider('futures-feed');
    const s = createServices({ ...defaultProviders(), price: [futures] }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'GC' }) });
    teardown = connectServices(s);
    const now = Date.now();
    act(() => {
      futures.sink.connection('GC', 'LIVE');
      futures.sink.quote('GC', { last: 2412.7, bid: 2412.6, ask: 2412.8, timestamp: now });
      futures.sink.candles('GC', 'H1', [{ time: 1_790_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }], 'replace');
    });
    const ctx = buildAiContext(s, now + 1000);
    expect(ctx.quote).toMatchObject({ status: 'LIVE', source: 'Test futures-feed', value: { last: 2412.7, bid: 2412.6, ask: 2412.8 } });
    expect(ctx.candles.status).toBe('LIVE');
    expect(ctx.candles.value!.bars[0]).toMatchObject({ o: 1, h: 2, l: 0.5, c: 1.5, v: 3 });
    expect(ctx.provider.value!.name).toBe('Test futures-feed');
    const later = buildAiContext(s, now + 10 * 60_000);
    expect(later.quote.status).toBe('STALE');
    expect(later.quote.reason).toMatch(/Last provider message/);
  });

  it('the service attaches the context to chat requests (read-only adapter available)', async () => {
    const backend = new FakeAiBackend();
    const cfg = { ...DEFAULT_TLUXE_AI_CONFIG, enabled: true, token: TOKEN, healthMs: 3_600_000 };
    const provider = new TluxeAiProvider(cfg, { client: new TluxeAiClient(cfg.url, TOKEN, backend.fetch) });
    const s = createServices({ ...defaultProviders(), ai: provider }, { storage: memoryStorage({ 'tluxe.instrument.v1': 'SI' }) });
    teardown = connectServices(s);
    await provider.checkHealth();
    expect(s.ai.store.getState().contextAvailable).toBe(true);
    await s.ai.send('chat', 'status?');
    const ctx = (backend.chats()[0]!.body as { context: { instrument: { id: string }; quote: { status: string } } }).context;
    expect(ctx.instrument.id).toBe('SI');
    expect(ctx.quote.status).toBe('UNAVAILABLE');
  });

  it('secrets are never included: credential-named fields dropped, key-shaped values masked, size bounded', () => {
    const dirty = { levels: [1, 2, 3], token: 'abc', bridgeToken: 'x', apiKey: FAKE_OPENAI_KEY, nested: { password: 'p', note: `uses ${FAKE_OPENAI_KEY} and db-ABCDEFGHIJKL` }, fn: () => 1 };
    const out = JSON.stringify(compactForAi(dirty));
    for (const bad of ['abc', '"x"', FAKE_OPENAI_KEY, 'db-ABCDEFGHIJKL', '"p"', 'fn']) expect(out).not.toContain(bad);
    expect(out).toContain('levels');
    const huge = { zones: Array.from({ length: 5000 }, (_, i) => ({ id: i, price: 2400 + i, meta: { a: { b: { c: { d: i } } } } })) };
    expect(JSON.stringify(boundedForAi(huge)).length).toBeLessThanOrEqual(AI_CONTEXT_LIMITS.engineChars);
    const s = services();
    const ctx = JSON.stringify(buildAiContext(s, Date.now(), memoryStorage({ 'tluxe.mt5.config.v1': JSON.stringify({ token: 'secret-token-value-123456789012345678' }) })));
    expect(ctx).not.toMatch(/secret-token-value|sk-|Bearer/);
    expect(ctx.length).toBeLessThanOrEqual(AI_CONTEXT_LIMITS.totalChars);
  });
});

describe('TLUXE AI — existing connections unaffected', () => {
  it('enabling TLUXE AI does not add / remove / change MT5 or Databento providers', () => {
    const base = { 'tluxe.databento.config.v1': JSON.stringify({ enabled: true, token: 'd'.repeat(40) }) };
    const without = defaultProviders(memoryStorage(base));
    const withAi = defaultProviders(memoryStorage({ ...base, [TLUXE_AI_CONFIG_KEY]: JSON.stringify({ enabled: true, token: TOKEN }) }));
    expect(withAi.ai).toBeInstanceOf(TluxeAiProvider);
    expect(without.ai).toBeInstanceOf(NullAiProvider);
    expect(withAi.price.map((p) => p.info.id)).toEqual(without.price.map((p) => p.info.id));
    expect(!!withAi.databento).toBe(!!without.databento);
    expect(withAi.orderFlow?.trade?.info.id).toBe(without.orderFlow?.trade?.info.id);
  });

  it('one health loop across HMR / repeated connectServices; teardown stops it', async () => {
    const r = rig();
    const s = createServices({ ...defaultProviders(), ai: r.provider }, { storage: memoryStorage() });
    const t1 = connectServices(s);
    const t2 = connectServices(s); // HMR / StrictMode: idempotent
    expect(t1).toBe(t2);
    await act(async () => new Promise<void>((res) => setTimeout(res, 10)));
    expect(r.backend.calls.filter((c) => c.url.endsWith('/health'))).toHaveLength(1);
    expect(r.provider.isRunning()).toBe(true);
    t1();
    expect(r.provider.isRunning()).toBe(false);
    expect(s.market.store('GC').getState().provider).toBeNull(); // no market provider was created by the AI wiring
  });
});
