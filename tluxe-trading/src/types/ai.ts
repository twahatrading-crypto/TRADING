export type AiTab = 'chat' | 'research' | 'analysis' | 'tools';

export type AiActionId =
  | 'analyze-market'
  | 'check-engine'
  | 'find-problems'
  | 'deep-research'
  | 'build-feature';

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: number;
  /** user: lifecycle of the request · system: 'notice' | 'error' | 'cancelled' (Retry is offered on error / cancelled). */
  state?: 'pending' | 'answered' | 'failed' | 'cancelled' | 'notice' | 'error';
  /** system error / cancelled: the user message that can be retried. */
  retryOf?: string;
  /** assistant: the model that produced it (reported by the backend). */
  model?: string | null;
}
