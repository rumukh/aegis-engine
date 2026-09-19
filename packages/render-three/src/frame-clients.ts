import type { InputPacket, LiveInput } from './live-input.js';

export interface FrameClient {
  id: string;
  /** True only for fresh gameplay intent, not a held level or an idle frame poll. */
  claim: boolean;
  /** Last observed restart generation; null on a page's first exchange. */
  generation: number | null;
}

export interface FrameInputStatus {
  role: 'controlling' | 'observing';
  accepted: boolean;
  reason: 'accepted' | 'observing' | 'stale' | 'generation';
  lastSeq: number;
}

export interface FrameClientState {
  lastSeq: number;
  lastSeen: number;
  eventCursor: number;
}

export const FRAME_CLIENT_LIMIT = 32;
export const FRAME_CLIENT_IDLE_SECONDS = 60;
export const FRAME_OWNER_IDLE_SECONDS = 2;

export function validFrameClient(value: unknown): value is FrameClient {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const client = value as Record<string, unknown>;
  return (
    typeof client['id'] === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(client['id']) &&
    typeof client['claim'] === 'boolean' &&
    (client['generation'] === null ||
      (Number.isSafeInteger(client['generation']) && Number(client['generation']) >= 0))
  );
}

/** Host-only stream arbitration. Page sequence numbers and ownership never enter world state. */
export class FrameClients {
  readonly #clients = new Map<string, FrameClientState>();
  #owner: string | undefined;
  #ownerSeen = 0;
  #legacySeq = -1;

  client(id: string, now: number, input: LiveInput): FrameClientState | undefined {
    this.expire(now, input);
    let client = this.#clients.get(id);
    if (client === undefined) {
      if (this.#clients.size >= FRAME_CLIENT_LIMIT) return undefined;
      client = { lastSeq: -1, lastSeen: now, eventCursor: 0 };
      this.#clients.set(id, client);
    }
    client.lastSeen = now;
    return client;
  }

  expire(now: number, input: LiveInput): void {
    if (this.#owner !== undefined && now - this.#ownerSeen > FRAME_OWNER_IDLE_SECONDS) {
      input.clear();
      this.#owner = undefined;
    }
    for (const [id, client] of this.#clients)
      if (id !== this.#owner && now - client.lastSeen > FRAME_CLIENT_IDLE_SECONDS)
        this.#clients.delete(id);
  }

  submit(
    input: LiveInput,
    client: FrameClientState,
    metadata: FrameClient,
    packet: InputPacket,
    generation: number,
    now: number,
  ): FrameInputStatus {
    const result = (accepted: boolean, reason: FrameInputStatus['reason']): FrameInputStatus => ({
      role: this.#owner === metadata.id ? 'controlling' : 'observing',
      accepted,
      reason,
      lastSeq: client.lastSeq,
    });
    if (packet.seq <= client.lastSeq) return result(false, 'stale');
    client.lastSeq = packet.seq;
    if (metadata.generation !== generation) return result(false, 'generation');
    if (metadata.claim && this.#owner !== metadata.id) {
      input.clear();
      this.#owner = metadata.id;
    }
    if (this.#owner !== metadata.id) return result(false, 'observing');
    this.#ownerSeen = now;
    // Each stream is ordered independently; the existing LiveInput receives one host-owned stream.
    input.submit({ ...packet, seq: input.lastSeq + 1 });
    return result(true, 'accepted');
  }

  /** Legacy API remains one stream. A neutral legacy observer cannot replace a modern owner. */
  submitLegacy(input: LiveInput, packet: InputPacket, now: number): FrameInputStatus {
    this.expire(now, input);
    const result = (accepted: boolean, reason: FrameInputStatus['reason']): FrameInputStatus => ({
      role: this.#owner === undefined ? 'controlling' : 'observing',
      accepted,
      reason,
      lastSeq: this.#legacySeq,
    });
    if (packet.seq <= this.#legacySeq) return result(false, 'stale');
    this.#legacySeq = packet.seq;
    if (this.#owner !== undefined) return result(false, 'observing');
    input.submit({ ...packet, seq: input.lastSeq + 1 });
    return result(true, 'accepted');
  }

  reset(): void {
    this.#owner = undefined;
    this.#legacySeq = -1;
    for (const client of this.#clients.values()) client.eventCursor = 0;
  }
}
