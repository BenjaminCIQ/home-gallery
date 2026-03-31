export interface Event {
  type: 'userAction';
  id: string;
  date?: string;
  targetIds: string[];
  targetHints?: EventTargetHint[];
  actions: EventAction[];
}

export interface EventAction {
  action: string;
  value?: string;
}

export interface EventTargetHint {
  id?: string;
  filepath?: string;
  hash?: string;
}

export type EventListener = (event: Event) => void;
