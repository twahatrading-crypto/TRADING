import { describe, expect, it } from 'vitest';
import type { ProviderStatus } from '../../types/providers';
import { NullAiProvider, type AiProvider } from './AiProvider';
import { AI_NOT_CONNECTED_NOTICE, AiService } from './AiService';

describe('AiService with no provider', () => {
  it('reports NOT_CONNECTED', () => {
    expect(new AiService(new NullAiProvider()).store.getState().status).toBe('NOT_CONNECTED');
  });

  it('never fabricates an assistant reply', async () => {
    const svc = new AiService(new NullAiProvider());
    await svc.send('chat', 'What is gold doing?');
    await svc.runAction('chat', 'analyze-market');
    const msgs = svc.store.getState().messages;
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(0);
    expect(msgs.filter((m) => m.role === 'system').map((m) => m.text)).toEqual([AI_NOT_CONNECTED_NOTICE, AI_NOT_CONNECTED_NOTICE]);
  });

  it('ignores blank input', async () => {
    const svc = new AiService(new NullAiProvider());
    await svc.send('chat', '   ');
    expect(svc.store.getState().messages).toHaveLength(0);
  });
});

describe('AiService with a connected provider', () => {
  it('relays provider replies and surfaces failures', async () => {
    let fail = false;
    const provider: AiProvider = {
      name: 'Test',
      status: (): ProviderStatus => 'CONNECTED',
      send: async (r) => {
        if (fail) throw new Error('boom');
        return { text: `echo:${r.text}` };
      },
    };
    const svc = new AiService(provider);
    await svc.send('research', 'hi');
    fail = true;
    await svc.send('research', 'again');
    const msgs = svc.store.getState().messages.map((m) => `${m.role}:${m.text}`);
    expect(msgs).toEqual(['user:hi', 'assistant:echo:hi', 'user:again', 'system:Request failed: boom']);
  });
});
