# ADR-0007: Semantic frame and ASCII view

- **Status:** Accepted
- **Principle:** CHARTER §3.7 — "Agents can 'see' without a GPU."

## Context

An agent cannot look at pixels, yet it must answer visual questions to debug: _Is the enemy on
screen? Where, relative to the player? Is the platform above or below? Did the door open?_
Principle 7 asks for two things: a **semantic frame** (what the camera would show, as structured
data) and a **deterministic ASCII view** for 2D modes. Both must be derived purely from world
state so they are reproducible and diffable, and both must be genuinely useful — not a debug
afterthought.

## Decision

**Two complementary text views, produced by each mode's `ViewProvider` (`harness/view.ts`).**

### Semantic frame — primary, all three modes

`SemanticFrame` describes a rendered frame as data: a `CameraSnapshot` (position, rotation,
`orthographic|perspective`, fov/ortho-height, viewport) and a list of `VisibleEntity`:

```ts
interface VisibleEntity {
  entity: Entity;
  name?: string; // the readable id used in assertions
  tags: readonly string[]; // "Player", "Enemy", … — for filtering
  world: Vec3; // world position
  screen: { x: number; y: number }; // projected viewport position
  depth: number; // distance along view dir (sort/occlusion)
  bounds?: { width: number; height: number };
  layer: number;
  occluded: boolean;
  visibleFraction: number; // 0 hidden … 1 fully visible
  glyph?: string; // char used when rasterising to ASCII
}
```

Entities are **sorted deterministically**: ascending `depth`, ties broken by ascending `entity`.
On-screen only, unless `includeOffscreen` is requested. This is exactly the data the renderer
would draw — an agent reads it to answer "is the enemy visible and where", precisely.

### ASCII view — 2D modes (platformer, iso)

`AsciiView` is a character grid: `rows: string[]` (each exactly `width` chars, row 0 at top) plus
a `legend` mapping glyph → description (`{ "@": "player", "#": "solid tile" }`). It lets an agent
_see the level_ in text and diff two ticks visually. fps returns `undefined` for ASCII (it relies
on the semantic frame; a coarse depth raster is optional).

### Placement

Projection is mode-specific (orthographic side-on, isometric 2:1, perspective), so the
`ViewProvider` implementation lives in each **mode** package; the shared frame/view **types** live
in the **harness** that orchestrates and diffs them (ADR-0006). Views never mutate the world.

## Consequences

- **Good:** one structured contract serves debugging, assertions (`SimResult.frame(tick)`), and
  the renderer's mental model; determinism makes frames snapshot-testable and diffable; ASCII
  gives humans and agents an instant read of 2D levels.
- **Cost:** each mode implements a real projection to fill `screen`/`depth`/`occluded`; the fps
  occlusion/`visibleFraction` fields are the least certain and may be refined (architecture.md §8).
- **Constraint for implementers:** frame production is a pure read of world state — no caching that
  survives a tick, no RNG, no clock — so `frame(t)` is reproducible for any captured tick.
