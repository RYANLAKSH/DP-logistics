/**
 * Realtime subscription helper.
 *
 * The pattern the whole dashboard follows: an event INVALIDATES, a query
 * FETCHES. The payload is never treated as the truth.
 *
 * That matters for correctness, not tidiness. A postgres_changes payload
 * carries the raw row — not the joined, permission-filtered shape the UI needs
 * — and it can arrive out of order. A client-side reducer applied to those
 * events drifts from the database, and nobody notices until a manager acts on
 * a number that is wrong. It also means switching transport later (Broadcast
 * from the database, when subscriber counts make postgres_changes expensive)
 * changes this file and nothing else, because no component ever depended on a
 * payload's shape.
 */
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline'

export interface RealtimeHandle {
  unsubscribe(): void
}

export interface SubscribeOptions {
  yardId: string
  onChange(table: string, payload: unknown): void
  onState(state: ConnectionState): void
}
