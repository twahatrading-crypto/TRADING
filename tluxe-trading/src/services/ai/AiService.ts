import { createStore, type Store } from '../../store/createStore';
import type { AiActionId, AiMessage, AiTab } from '../../types/ai';
import type { ProviderStatus } from '../../types/providers';
import type { AiProvider } from './AiProvider';

export interface AiState {
  status: ProviderStatus;
  providerName: string | null;
  messages: AiMessage[];
  pending: boolean;
}

export const AI_ACTION_LABELS: Record<AiActionId, string> = {
  'analyze-market': 'Analyze Market',
  'check-engine': 'Check My Engine',
  'find-problems': 'Find Problems',
  'deep-research': 'Deep Research',
  'build-feature': 'Build Feature',
};

export const AI_NOT_CONNECTED_NOTICE =
  'Not sent — TLUXE AI is not connected. Configure an AI provider to enable responses.';

export class AiService {
  readonly store: Store<AiState>;
  private seq = 0;

  constructor(private readonly provider: AiProvider, private readonly clock: () => number = Date.now) {
    this.store = createStore<AiState>({
      status: provider.status(),
      providerName: provider.name,
      messages: [],
      pending: false,
    });
  }

  private push(role: AiMessage['role'], text: string) {
    const msg: AiMessage = { id: `m${++this.seq}`, role, text, createdAt: this.clock() };
    this.store.setState((s) => ({ ...s, messages: [...s.messages, msg] }));
  }

  async send(tab: AiTab, text: string, action: AiActionId | null = null): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.store.getState().pending) return;
    this.push('user', trimmed);
    const status = this.provider.status();
    this.store.setState({ status });
    if (status !== 'CONNECTED') {
      this.push('system', AI_NOT_CONNECTED_NOTICE);
      return;
    }
    this.store.setState({ pending: true });
    try {
      const res = await this.provider.send({ tab, action, text: trimmed });
      this.push('assistant', res.text);
    } catch (err) {
      this.push('system', `Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.store.setState({ pending: false, status: this.provider.status() });
    }
  }

  runAction(tab: AiTab, action: AiActionId): Promise<void> {
    return this.send(tab, AI_ACTION_LABELS[action], action);
  }
}
