# Incremental presentation events

`world.events.since(cursor)` returns the frozen FIFO suffix of the recorded event log, including the event at `cursor`. Events and nested payloads are immutable at emission; a tail shares those immutable entries but not the mutable log array. Start at `0`, advance by the number of entries consumed:

```ts
const fresh = world.events.since(cursor);
const offset = cursor; // fresh[i] has sequence offset + i within this generation
cursor += fresh.length;
```

A caught-up reader gets a shared frozen empty array without slicing the history. An unrecorded bus has an empty log. Only integer cursors in `[0, log length]` are valid; reset the cursor to zero on world replacement/restart. A numeric cursor does **not** identify its generation. Reading does not drain another reader's cursor.

- **Static:** a displayed frame drains only its own tail, including all events from batched steps. Restart resets the cursor and the presentation generation. The explicit debug `events()` still returns the full log.
- **Live:** each named client has an independent cursor; anonymous legacy polls retain the legacy cursor. State/control reads never drain a frame cursor. A cold or generation-mismatched presentation receives the full `eventHistory` atomically with its snapshot, even if the normal cursor is caught up. A warm frame only returns its new `events`; `/events` is an explicit full-history read. Full-history reads are intentionally still proportional to history length.
- This change reduces **read work**, not retention: recording still retains the complete history. It does not impose a ring buffer, discard old events, or alter the world hash, event digest, transport schema or clock.

## Measured control

The Node [delivery test](../../packages/render-three/src/frame-events.test.ts) counts actual `slice` reference copies on the event log. After **10,000** events, **100** idle reads by the old `history().slice(cursor)` path copied **1,000,000** references. The shared live/static tail drain copied **0**. A three-event burst then copied **3**, delivered once in order with sequence numbers `10000..10002`. `history()` remains available when the complete history is actually needed.

Browser acceptance is complementary: both live and exported static presentations should show each new event once with no new HUD/audio cues on idle frames. Independent live pages should agree on the batch. A cold/reconnected page should recover existing state without replaying historical one-shot cues; after restart the generation changes, stale cues disappear and the first new sequence is zero.
