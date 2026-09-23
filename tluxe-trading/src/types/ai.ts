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
}
