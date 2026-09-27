/**
 * TEST DATA ONLY — an in-memory stand-in for the LOCAL TLUXE AI backend (bridge/ai) used by automated tests.
 * It never talks to OpenAI, is never imported by production code, and there is no setting that enables it.
 */
import type { TluxeAiHealth } from '../client';

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type ChatHandler = (body: { messages: { role: string; content: string }[]; context?: unknown }, signal: AbortSignal | undefined) => Promise<{ status: number; body: unknown }>;

export function health(over: Partial<TluxeAiHealth> = {}): TluxeAiHealth {
  return {
    service: 'tluxe-ai',
    version: '1.0.0',
    provider: 'openai',
    api: 'responses',
    model: 'gpt-5.5',
    status: 'CONNECTED',
    connected: true,
    reason: null,
    checkedAtMs: 1,
    permissions: { readOnly: true, tools: [] },
    capabilities: { chat: true, research: false, analysis: false, tools: false },
    limits: { maxMessages: 40, maxMessageChars: 8000, maxTotalChars: 64000, maxContextBytes: 24000, timeoutS: 60 },
    ...over,
  };
}

export class FakeAiBackend {
  calls: FakeCall[] = [];
  down = false;
  healthBody: TluxeAiHealth = health();
  healthStatus = 200;
  chat: ChatHandler = async (b) => ({ status: 200, body: { text: `answer to: ${b.messages.at(-1)!.content}`, model: 'gpt-5.5', responseId: 'r', incomplete: false, requestId: null } });

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = { ...(init.headers as Record<string, string>) };
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    this.calls.push({ url, method: init.method ?? 'GET', headers, body });
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (this.down) throw new TypeError('Failed to fetch');
    if (url.endsWith('/api/ai/health')) return new Response(JSON.stringify(this.healthBody), { status: this.healthStatus });
    if (url.endsWith('/api/ai/chat')) {
      const r = await this.chat(body, init.signal ?? undefined);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } }), { status: 404 });
  };

  chats(): FakeCall[] {
    return this.calls.filter((c) => c.url.endsWith('/api/ai/chat'));
  }
}

/** A chat handler that only settles when aborted (cancel / timeout tests). */
export const hanging: ChatHandler = (_b, signal) =>
  new Promise((_res, rej) => {
    signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
  });
