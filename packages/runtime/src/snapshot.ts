import { createWorld } from '@aegis/core';
import { checkJson, cloneData, counterSchema, identifierSchema, schema } from './data.js';
import type { Schema } from './data.js';
import { caughtFailure, success } from './outcome.js';
import type { Outcome } from './outcome.js';
import type { RuntimeSnapshot } from './types.js';

const prng = schema.object({
  s: schema.array(schema.number({ integer: true, min: 0, max: 0xffffffff }), { min: 4, max: 4 }),
});

const ticket = schema.object({ id: identifierSchema, token: counterSchema });
const anchor = schema.union(
  schema.object({ kind: schema.literal('elapsed'), turn: counterSchema }),
  schema.object({
    kind: schema.literal('phase-entry'),
    instance: counterSchema,
    offset: counterSchema,
  }),
  schema.object({
    kind: schema.literal('phase-end'),
    instance: counterSchema,
    offset: schema.number({ integer: true }),
  }),
);

/** This runtime owns one explicitly registered state resource, not arbitrary ECS/plugin state. */
export const runtimeSnapshotSchema: Schema<RuntimeSnapshot> = schema.object({
  format: schema.literal('aegis-runtime/1'),
  adapter: identifierSchema,
  stateVersion: counterSchema,
  content: schema.object({
    id: identifierSchema,
    revision: identifierSchema,
    schemaVersion: counterSchema,
    hash: schema.string({ pattern: /^[a-f0-9]{16}$/ }),
  }),
  seed: schema.union(schema.string(), schema.number()),
  revision: counterSchema,
  turn: counterSchema,
  world: schema.object({
    version: schema.literal(1),
    tick: schema.literal(0),
    entities: schema.array(
      schema.object({
        id: schema.string(),
        components: schema.record(schema.json),
      }),
      { max: 0 },
    ),
    resources: schema.object({ 'aegis.runtime.state': schema.json }),
    prng,
    allocator: schema.object({
      slots: schema.array(counterSchema, { max: 0 }),
      free: schema.array(counterSchema, { max: 0 }),
    }),
  }),
  streams: schema.record(prng),
  pending: schema.union(
    schema.literal(null),
    schema.object({
      id: counterSchema,
      rule: identifierSchema,
      payload: schema.json,
      turns: counterSchema,
      completedTurns: counterSchema,
      progress: schema.json,
    }),
  ),
  jobs: schema.array(
    schema.object({
      id: identifierSchema,
      rule: identifierSchema,
      payload: schema.json,
      anchor,
      phase: identifierSchema,
      priority: schema.number({ integer: true }),
      token: counterSchema,
      dueTurn: counterSchema,
    }),
  ),
  claims: schema.array(identifierSchema),
  consumedJobs: schema.array(ticket),
  phase: schema.union(
    schema.literal(null),
    schema.object({
      id: identifierSchema,
      instance: counterSchema,
      enteredTurn: counterSchema,
      allowance: counterSchema,
    }),
  ),
  nextAction: counterSchema,
  nextJob: counterSchema,
  nextPhase: counterSchema,
});

/** Structural/core validation only. Adapter, rules, content and active references are checked by restore. */
export function validateRuntimeSnapshot(candidate: unknown): Outcome<RuntimeSnapshot> {
  try {
    const plain = checkJson(candidate);
    if (!plain.ok) return plain;
    const parsed = runtimeSnapshotSchema.parse(candidate);
    if (!parsed.ok) return parsed;
    const world = createWorld({ seed: parsed.value.seed });
    world.restore(parsed.value.world);
    return success(cloneData(parsed.value));
  } catch (error) {
    return caughtFailure(error, 'invalid-save');
  }
}

export function isRuntimeSnapshot(candidate: unknown): candidate is RuntimeSnapshot {
  return validateRuntimeSnapshot(candidate).ok;
}
