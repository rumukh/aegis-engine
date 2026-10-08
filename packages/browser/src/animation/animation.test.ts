import { describe, expect, it } from 'vitest';
import {
  AZURE_VISEMES,
  CutscenePlayer,
  PuppetModel,
  clipEventsBetween,
  createPresentationRandom,
  ease,
  importRhubarb,
  importVisemes,
  resolveMouthShape,
  sampleClip,
  sampleCues,
  validateAtlas,
  validateBundle,
  validateClip,
  validateCueTrack,
  validateCutscene,
  validateRig,
} from './index.js';
import type {
  AtlasFile,
  ClipFile,
  CutsceneEvent,
  CutsceneFile,
  CutsceneHost,
  LineOutcome,
  RigFile,
} from './index.js';

const atlas: AtlasFile = {
  format: 'aegis-atlas/1',
  id: 'mini.atlas',
  image: 'mini.png',
  width: 512,
  height: 256,
  frames: {
    body: { x: 0, y: 0, w: 100, h: 200 },
    head: { x: 104, y: 0, w: 100, h: 100 },
    arm: { x: 208, y: 0, w: 20, h: 80 },
    ...Object.fromEntries(
      ['X', 'A', 'B', 'C', 'D', 'E', 'F'].map((s, i) => [
        `mouth.${s}`,
        { x: 240 + i * 34, y: 0, w: 30, h: 20 },
      ]),
    ),
    'eyes.open': { x: 0, y: 210, w: 60, h: 20 },
    'eyes.half': { x: 64, y: 210, w: 60, h: 20 },
    'eyes.closed': { x: 128, y: 210, w: 60, h: 20 },
    wrap: { x: 200, y: 210, w: 80, h: 20 },
    'wrap.mask': { x: 284, y: 210, w: 80, h: 20 },
    hat: { x: 368, y: 210, w: 60, h: 40 },
    badge: { x: 432, y: 210, w: 20, h: 20, offset: { x: 2, y: 2 }, source: { w: 24, h: 24 } },
  },
};
const mouths = Object.fromEntries(
  ['X', 'A', 'B', 'C', 'D', 'E', 'F'].map((s) => [s, `mini.atlas#mouth.${s}`]),
);
const rig: RigFile = {
  format: 'aegis-rig/1',
  id: 'mini',
  revision: '1',
  atlases: ['mini.atlas'],
  parts: [
    {
      id: 'body',
      frame: 'mini.atlas#body',
      pivot: { x: 50, y: 200 },
      position: { x: 0, y: 0 },
      z: 1,
    },
    {
      id: 'head',
      parent: 'body',
      frame: 'mini.atlas#head',
      pivot: { x: 50, y: 100 },
      position: { x: 0, y: -190 },
      z: 3,
    },
    {
      id: 'arm',
      parent: 'body',
      frame: 'mini.atlas#arm',
      pivot: { x: 10, y: 5 },
      position: { x: 40, y: -150 },
      z: 2,
    },
    {
      id: 'mouth',
      parent: 'head',
      variants: mouths,
      variant: 'X',
      pivot: { x: 15, y: 10 },
      position: { x: 0, y: -20 },
      z: 5,
    },
    {
      id: 'eyes',
      parent: 'head',
      variants: {
        open: 'mini.atlas#eyes.open',
        half: 'mini.atlas#eyes.half',
        closed: 'mini.atlas#eyes.closed',
      },
      variant: 'open',
      pivot: { x: 30, y: 10 },
      position: { x: 0, y: -60 },
      z: 4,
    },
  ],
  roles: { mouth: 'mouth', eyes: 'eyes', head: 'head', body: 'body' },
  expressions: { sleepy: { eyes: 'half' }, closed: { eyes: 'closed' } },
  slots: {
    scarf: { parent: 'body', position: { x: 0, y: -180 }, z: 2 },
    hat: { parent: 'head', position: { x: 0, y: -95 }, z: 9 },
  },
  tints: { scarf: { default: '#c8553d' } },
  emotes: { joy: { expression: 'sleepy', clip: 'wave' } },
};
const scarf: RigFile = {
  format: 'aegis-rig/1',
  id: 'acc.scarf',
  revision: '1',
  atlases: ['mini.atlas'],
  parts: [
    {
      id: 'wrap',
      frame: 'mini.atlas#wrap',
      pivot: { x: 40, y: 10 },
      position: { x: 0, y: 0 },
      z: 0,
      tint: { channel: 'scarf', mask: 'mini.atlas#wrap.mask' },
    },
  ],
  tints: { scarf: { default: '#c8553d' } },
  anchors: { badge: { part: 'wrap', x: 70, y: 10 } },
};
const hat: RigFile = {
  format: 'aegis-rig/1',
  id: 'acc.hat',
  revision: '1',
  atlases: ['mini.atlas'],
  parts: [
    { id: 'hat', frame: 'mini.atlas#hat', pivot: { x: 30, y: 40 }, position: { x: 0, y: 0 }, z: 0 },
  ],
};
const badge: RigFile = {
  format: 'aegis-rig/1',
  id: 'acc.badge',
  revision: '1',
  atlases: ['mini.atlas'],
  parts: [
    {
      id: 'badge',
      frame: 'mini.atlas#badge',
      pivot: { x: 12, y: 12 },
      position: { x: 0, y: 0 },
      z: 0,
    },
  ],
};
const wave: ClipFile = {
  format: 'aegis-clip/1',
  id: 'wave',
  duration: 1,
  tracks: [
    {
      part: 'arm',
      property: 'rotation',
      keys: [
        { t: 0, v: 0, ease: 'linear' },
        { t: 0.5, v: -90 },
        { t: 1, v: 0 },
      ],
    },
    {
      part: 'eyes',
      property: 'variant',
      keys: [
        { t: 0, v: 'open' },
        { t: 0.5, v: 'closed' },
      ],
    },
  ],
  events: [{ t: 0.5, name: 'peak' }],
};
const rigs = new Map([rig, scarf, hat, badge].map((item) => [item.id, item]));

describe('mouth shapes and cue tracks (ANIM-04)', () => {
  it('maps Azure and OVR visemes and imports Rhubarb JSON', () => {
    expect(AZURE_VISEMES).toHaveLength(22);
    expect(AZURE_VISEMES[0]).toBe('X');
    expect(AZURE_VISEMES[21]).toBe('A');
    expect(AZURE_VISEMES[18]).toBe('G');
    const azure = importVisemes(
      'azure',
      [
        { visemeId: 0, audioOffset: 0 },
        { visemeId: 21, audioOffset: 500_000 },
        { visemeId: 2, audioOffset: 1_500_000 },
        { visemeId: 2, audioOffset: 2_000_000 },
      ],
      { line: 'l1', duration: 0.5 },
    );
    expect(azure.cues).toEqual([
      { t: 0, s: 'X' },
      { t: 0.05, s: 'A' },
      { t: 0.15, s: 'D' },
    ]);
    expect(validateCueTrack(azure).ok).toBe(true);
    expect(() =>
      importVisemes('azure', [{ visemeId: 99, time: 0 }], { line: 'l', duration: 1 }),
    ).toThrow();
    const ovr = importVisemes(
      'ovr',
      [
        { viseme: 'sil', time: 0 },
        { viseme: 'aa', time: 0.1 },
      ],
      { line: 'l', duration: 1 },
    );
    expect(ovr.cues.map((cue) => cue.s)).toEqual(['X', 'D']);
    const rhubarb = importRhubarb(
      {
        metadata: { soundFile: 'x.wav', duration: 1.2 },
        mouthCues: [
          { start: 0, end: 0.2, value: 'X' },
          { start: 0.2, end: 0.5, value: 'B' },
          { start: 0.5, end: 1.2, value: 'G' },
        ],
      },
      { line: 'l2', revision: '3' },
    );
    expect(rhubarb).toMatchObject({
      format: 'aegis-cues/1',
      line: 'l2',
      revision: '3',
      duration: 1.2,
    });
    expect(validateCueTrack(rhubarb).ok).toBe(true);
    expect(() =>
      importRhubarb({ mouthCues: [{ start: 0, value: 'Z' }] }, { line: 'l', duration: 1 }),
    ).toThrow();
  });

  it('samples cues by time with rest before, between tracks and after the duration', () => {
    const track = {
      duration: 1,
      cues: [
        { t: 0.1, s: 'B' as const },
        { t: 0.4, s: 'D' as const },
      ],
    };
    expect(sampleCues(track, 0).s).toBe('X');
    expect(sampleCues(track, 0.1).s).toBe('B');
    expect(sampleCues(track, 0.39).s).toBe('B');
    expect(sampleCues(track, 0.4).s).toBe('D');
    expect(sampleCues(track, 0.999).s).toBe('D');
    expect(sampleCues(track, 1).s).toBe('X');
    expect(sampleCues(track, -1).s).toBe('X');
    expect(resolveMouthShape('G', new Set(['X', 'A', 'B']))).toBe('B');
    expect(resolveMouthShape('H', new Set(['X', 'C']))).toBe('C');
    expect(resolveMouthShape('X', new Set(['A']))).toBe('A');
  });

  it('reports cue diagnostics with stable codes', () => {
    const result = validateCueTrack(
      {
        format: 'aegis-cues/1',
        line: 'l',
        duration: 1,
        cues: [
          { t: 0.5, s: 'Q' },
          { t: 0.4, s: 'A' },
          { t: 1, s: 'A' },
        ],
      },
      { audioDuration: 1.2 },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual(
      ['AEG-ANIM-0030', 'AEG-ANIM-0031', 'AEG-ANIM-0032', 'AEG-ANIM-0032'].sort(),
    );
  });
});

describe('rig, atlas and clip validation (ANIM-02, ANIM-07)', () => {
  it('accepts the reference documents together', () => {
    const atlases = new Map([[atlas.id, atlas]]);
    expect(validateAtlas(atlas).diagnostics).toEqual([]);
    for (const item of [rig, scarf, hat, badge])
      expect(validateRig(item, { atlases }).diagnostics).toEqual([]);
    expect(validateClip(wave, { rig }).diagnostics).toEqual([]);
    const bundle = validateBundle({
      documents: [atlas, rig, scarf, hat, badge, wave].map((value) => ({
        source: `${value.id}.json`,
        value,
      })),
    });
    expect(bundle).toMatchObject({ ok: true, diagnostics: [] });
  });

  it('diagnoses missing parts, invalid pivots, unknown shapes and oversized textures in one pass', () => {
    const huge = validateAtlas({
      ...atlas,
      width: 8192,
      frames: { ...atlas.frames, out: { x: 0, y: 250, w: 40, h: 10 } },
    });
    expect(huge.diagnostics.map((d) => d.code)).toEqual(['AEG-ANIM-0020', 'AEG-ANIM-0021']);
    const broken = {
      ...rig,
      parts: [
        ...rig.parts
          .slice(0, 3)
          .map((part) =>
            part.id === 'head' ? { ...part, pivot: { x: 500, y: 0 }, parent: 'nobody' } : part,
          ),
        {
          ...rig.parts[3]!,
          variants: { ...mouths, Q: 'mini.atlas#mouth.A', D: 'mini.atlas#missing' },
          z: 1,
        },
      ],
      slots: { hat: { parent: 'ghost', position: { x: 0, y: 0 }, z: 9 } },
      extra: true,
    };
    const result = validateRig(broken, { atlases: new Map([[atlas.id, atlas]]) });
    const codes = result.diagnostics.map((d) => d.code);
    for (const code of [
      'AEG-ANIM-0005',
      'AEG-ANIM-0010',
      'AEG-ANIM-0011',
      'AEG-ANIM-0012',
      'AEG-ANIM-0013',
      'AEG-ANIM-0016',
      'AEG-ANIM-0018',
      'AEG-ANIM-0030',
    ])
      expect(codes).toContain(code);
    expect(result.ok).toBe(false);
    const cycle = validateRig({
      ...rig,
      parts: [{ ...rig.parts[0]!, parent: 'head' }, ...rig.parts.slice(1)],
    });
    expect(
      cycle.diagnostics.some((d) => d.code === 'AEG-ANIM-0010' && /cycle/.test(d.message)),
    ).toBe(true);
    const missingMouth = validateRig({
      ...rig,
      parts: rig.parts.map((p) =>
        p.id === 'mouth' ? { ...p, variants: { X: 'mini.atlas#mouth.X' } } : p,
      ),
    });
    expect(missingMouth.diagnostics.some((d) => d.code === 'AEG-ANIM-0015')).toBe(true);
  });

  it('checks clips against a rig: parts, variants, key order and easing', () => {
    const result = validateClip(
      {
        ...wave,
        tracks: [
          { part: 'tail', property: 'rotation', keys: [{ t: 0, v: 0 }] },
          { part: 'eyes', property: 'variant', keys: [{ t: 0, v: 'wide' }] },
          {
            part: 'arm',
            property: 'rotation',
            keys: [
              { t: 0.5, v: 0, ease: 'bouncy' },
              { t: 0.4, v: 0 },
              { t: 2, v: 1 },
            ],
          },
          { part: 'arm', property: 'spin', keys: [] },
        ],
      },
      { rig },
    );
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual(
      [
        'AEG-ANIM-0040',
        'AEG-ANIM-0014',
        'AEG-ANIM-0042',
        'AEG-ANIM-0041',
        'AEG-ANIM-0041',
        'AEG-ANIM-0040',
      ].sort(),
    );
  });

  it('checks cutscenes against cast, rigs, clips, lines and markers', () => {
    const cutscene = {
      format: 'aegis-cutscene/1',
      id: 'c',
      revision: '1',
      cast: { a: { rig: 'mini' }, me: { role: 'avatar' }, bad: { rig: 'mini', role: 'avatar' } },
      steps: [
        { op: 'line', actor: 'a', line: 'known' },
        { op: 'line', actor: 'ghost', line: 'unknown' },
        { op: 'pose', actor: 'a', expression: 'angry', clip: 'nope' },
        { op: 'emote', actor: 'a', emote: 'joy' },
        { op: 'marker', id: 'm' },
        { op: 'marker', id: 'm' },
        { op: 'dance' },
        { op: 'wait' },
        { op: 'camera', preset: 'wide', to: { x: 0, y: 0, zoom: 1 } },
        { op: 'background', asset: 'bg', comfort: { op: 'x' } },
      ],
    };
    const result = validateCutscene(cutscene, {
      rigs,
      clips: new Set(['wave']),
      lines: new Set(['known']),
    });
    const codes = result.diagnostics.map((d) => `${d.code} ${d.path}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'AEG-ANIM-0003 $.cast.bad',
        'AEG-ANIM-0051 $.steps[1].actor',
        'AEG-ANIM-0051 $.steps[1].line',
        'AEG-ANIM-0051 $.steps[2].expression',
        'AEG-ANIM-0051 $.steps[2].clip',
        'AEG-ANIM-0006 $.steps[5].id',
        'AEG-ANIM-0050 $.steps[6].op',
        'AEG-ANIM-0003 $.steps[7]',
        'AEG-ANIM-0003 $.steps[8]',
        'AEG-ANIM-0005 $.steps[9].comfort.op',
      ]),
    );
    expect(codes.some((code) => code.includes('steps[3]'))).toBe(false);
  });
});

describe('deterministic sampling (ANIM-03)', () => {
  it('maps a clip time to exactly one pose, with easing, loops and events', () => {
    expect(sampleClip(wave, 0.25).numbers.get('arm')!.rotation).toBeCloseTo(-45);
    expect(sampleClip(wave, 0.75).numbers.get('arm')!.rotation).toBeCloseTo(-45);
    expect(sampleClip(wave, 0.6).variants.get('eyes')).toBe('closed');
    expect(sampleClip(wave, 5).numbers.get('arm')!.rotation).toBe(0);
    expect(sampleClip({ ...wave, loop: true }, 1.25).numbers.get('arm')!.rotation).toBeCloseTo(-45);
    expect(JSON.stringify([...sampleClip(wave, 0.3).numbers])).toBe(
      JSON.stringify([...sampleClip(wave, 0.3).numbers]),
    );
    expect(clipEventsBetween(wave, 0, 0.5).map((e) => e.name)).toEqual(['peak']);
    expect(clipEventsBetween({ ...wave, loop: true }, 0.2, 2.6).map((e) => e.t)).toEqual([
      0.5, 1.5, 2.5,
    ]);
    expect(ease('step', 0.9)).toBe(0);
    expect(ease([0.42, 0, 0.58, 1], 0.5)).toBeCloseTo(0.5, 3);
    expect(ease('easeOutBack', 1)).toBeCloseTo(1);
    const a = createPresentationRandom('seed');
    const b = createPresentationRandom('seed');
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
  });

  it('composes avatars with tint, slots and an anchored badge without pre-rendered combinations (F02)', () => {
    const avatar = new PuppetModel({
      rigs,
      clips: new Map([['wave', wave]]),
      composition: {
        rig: 'mini',
        tints: { scarf: '#2F6FB3' },
        accessories: [
          { anchor: 'badge', rig: 'acc.badge' },
          { slot: 'scarf', rig: 'acc.scarf' },
          { slot: 'hat', rig: 'acc.hat' },
        ],
      },
      at: { x: 1000, y: 1400 },
    });
    const items = avatar.pose(0);
    expect(items.map((item) => item.id)).toEqual([
      'body',
      'arm',
      'acc.scarf@slot:scarf/wrap',
      'acc.badge@anchor:badge/badge',
      'head',
      'eyes',
      'mouth',
      'acc.hat@slot:hat/hat',
    ]);
    const wrap = items.find((item) => item.id.endsWith('/wrap'))!;
    expect(wrap).toMatchObject({ tint: '#2f6fb3', mask: 'mini.atlas#wrap.mask' });
    // The badge's centre sits exactly on the scarf anchor, wherever the scarf is.
    const at = avatar.anchorAt('badge', 0)!;
    const badgeItem = items.find((item) => item.id.endsWith('/badge'))!;
    const centre = {
      x: badgeItem.matrix[0] * 12 + badgeItem.matrix[2] * 12 + badgeItem.matrix[4],
      y: badgeItem.matrix[1] * 12 + badgeItem.matrix[3] * 12 + badgeItem.matrix[5],
    };
    expect(centre.x).toBeCloseTo(at.x);
    expect(centre.y).toBeCloseTo(at.y);
    expect(at).toEqual({ x: 1030, y: 1220 });
    // Default tint when the composition does not choose one.
    const plain = new PuppetModel({
      rigs,
      composition: { rig: 'mini', accessories: [{ slot: 'scarf', rig: 'acc.scarf' }] },
    });
    expect(plain.pose(0).find((item) => item.id.endsWith('/wrap'))!.tint).toBe('#c8553d');
    expect(
      () =>
        new PuppetModel({
          rigs,
          composition: { rig: 'mini', accessories: [{ slot: 'cape', rig: 'acc.hat' }] },
        }),
    ).toThrow(/slot or anchor/);
  });

  it('drives mouth, blink, clips, hops and moves as pure functions of stage time', () => {
    const make = () => {
      const puppet = new PuppetModel({
        rigs,
        clips: new Map([['wave', wave]]),
        composition: { rig: 'mini' },
        at: { x: 0, y: 0 },
        seed: 's',
      });
      puppet.behave({ blink: { seed: 'blink' }, breathe: {} });
      puppet.play('wave', { at: 1 });
      puppet.hop(2);
      puppet.move([{ x: 300, y: 0 }], 3, { duration: 1 });
      return puppet;
    };
    const one = make();
    const two = make();
    for (let t = 0; t < 6; t += 0.05)
      expect(JSON.stringify(one.pose(t))).toBe(JSON.stringify(two.pose(t)));
    const mouth = (p: PuppetModel, t: number) => p.pose(t).find((i) => i.id === 'mouth')!.frame;
    one.setMouth('D');
    expect(mouth(one, 6)).toBe('mini.atlas#mouth.D');
    one.setMouth('H');
    expect(mouth(one, 6)).toBe('mini.atlas#mouth.C');
    one.setMouth(undefined);
    expect(mouth(one, 6)).toBe('mini.atlas#mouth.X');
    const eyes = new Set<string>();
    for (let t = 0; t < 20; t += 0.01) eyes.add(one.pose(t).find((i) => i.id === 'eyes')!.frame);
    expect([...eyes].sort()).toEqual([
      'mini.atlas#eyes.closed',
      'mini.atlas#eyes.half',
      'mini.atlas#eyes.open',
    ]);
    // An expression with closed eyes is not reopened by blinking.
    one.setExpression('closed');
    expect(
      new Set(
        Array.from(
          { length: 200 },
          (_, i) => one.pose(i * 0.1).find((x) => x.id === 'eyes')!.frame,
        ),
      ),
    ).toEqual(new Set(['mini.atlas#eyes.closed']));
    const mover = make();
    expect(mover.positionAt(3.5).x).toBeCloseTo(150);
    expect(mover.facing).toBe('right');
    mover.settle(3.1);
    expect(mover.positionAt(3.1)).toEqual({ x: 300, y: 0 });
  });

  it('damps large motion under reduced motion but keeps lip-sync and blinking', () => {
    const lift = (reducedMotion: boolean) => {
      const puppet = new PuppetModel({ rigs, composition: { rig: 'mini' }, reducedMotion });
      puppet.hop(0, { height: 100 });
      // The body frame matrix places the frame's top-left: 200 px (its pivot) above the feet.
      return -puppet.pose(0.225).find((i) => i.id === 'body')!.matrix[5] - 200;
    };
    expect(lift(false)).toBeGreaterThan(lift(true) * 3);
    const calm = new PuppetModel({ rigs, composition: { rig: 'mini' }, reducedMotion: true });
    calm.setMouth('D');
    expect(calm.pose(0).find((i) => i.id === 'mouth')!.frame).toBe('mini.atlas#mouth.D');
  });
});

class FakeHost implements CutsceneHost {
  log: string[] = [];
  lines = new Map<string, LineOutcome>();
  reset(): void {
    this.log.push('reset');
  }
  background(asset: string, _t: unknown, o: { instant: boolean }): number {
    this.log.push(`background:${asset}${o.instant ? '!' : ''}`);
    return o.instant ? 0 : 0.5;
  }
  camera(target: unknown, m: { duration: number }, o: { instant: boolean }): number {
    this.log.push(`camera:${typeof target === 'string' ? target : 'to'}${o.instant ? '!' : ''}`);
    return o.instant ? 0 : m.duration;
  }
  enter(
    actor: string,
    _f: unknown,
    _t: unknown,
    m: { duration?: number },
    o: { instant: boolean },
  ): number {
    this.log.push(`enter:${actor}${o.instant ? '!' : ''}`);
    return o.instant ? 0 : (m.duration ?? 1);
  }
  exit(actor: string, _t: unknown, m: { duration?: number }, o: { instant: boolean }): number {
    this.log.push(`exit:${actor}${o.instant ? '!' : ''}`);
    return o.instant ? 0 : (m.duration ?? 1);
  }
  move(actor: string): number {
    this.log.push(`move:${actor}`);
    return 1;
  }
  pose(actor: string, p: { clip?: string }, o: { instant: boolean }): number {
    this.log.push(`pose:${actor}${o.instant ? '!' : ''}`);
    return p.clip && !o.instant ? 1 : 0;
  }
  emote(actor: string, emote: string, o: { instant: boolean }): number {
    this.log.push(`emote:${actor}:${emote}${o.instant ? '!' : ''}`);
    return o.instant ? 0 : 0.5;
  }
  line(actor: string | undefined, line: string) {
    this.log.push(`line:${actor ?? 'narrator'}:${line}`);
    this.lines.set(line, 'pending');
    return { outcome: () => this.lines.get(line)! };
  }
  stopLine(): void {
    this.log.push('stopLine');
  }
  music(asset: string | null, _f: number, o: { instant: boolean }): void {
    this.log.push(`music:${asset}${o.instant ? '!' : ''}`);
  }
  atmosphere(): void {}
  sfx(asset: string): void {
    this.log.push(`sfx:${asset}`);
  }
  effect(name: string, _a: unknown, d: number, o: { instant: boolean }): number {
    this.log.push(`effect:${name}${o.instant ? '!' : ''}`);
    return o.instant ? 0 : d;
  }
  transition(): number {
    return 0.5;
  }
  settle(): void {
    this.log.push('settle');
  }
}

const scene: CutsceneFile = {
  format: 'aegis-cutscene/1',
  id: 'scene',
  revision: '1',
  cast: { a: { rig: 'mini' }, me: { role: 'avatar' } },
  steps: [
    { op: 'background', asset: 'bg', comfort: { asset: 'bg.warm' } },
    { op: 'music', asset: 'theme', fade: 1 },
    { op: 'enter', actor: 'a', from: 'left', to: { x: 1, y: 1 }, duration: 1 },
    { op: 'enter', actor: 'me', from: 'right', to: { x: 2, y: 1 }, duration: 2, wait: false },
    { op: 'line', actor: 'a', line: 'l1' },
    { op: 'marker', id: 'after-l1' },
    { op: 'sfx', asset: 'ding' },
    { op: 'pose', actor: 'me', clip: 'wave' },
    { op: 'line', actor: 'me', line: 'l2', advance: 'auto' },
    { op: 'exit', actor: 'a', to: 'left', duration: 1 },
  ],
};

describe('cutscene player (ANIM-05)', () => {
  const run = (comfort = false) => {
    const host = new FakeHost();
    const events: CutsceneEvent[] = [];
    const player = new CutscenePlayer(scene, host, {
      onEvent: (e) => events.push(e),
      comfort: () => comfort,
    });
    return { host, events, player };
  };

  it('waits for lines and for "next" by default; motion plays automatically (F05)', () => {
    const { host, events, player } = run();
    player.play(0);
    expect(host.log).toEqual(['reset', 'stopLine', 'background:bg']);
    player.update(0.5);
    expect(host.log.slice(3)).toEqual(['music:theme', 'enter:a']);
    player.update(1.5);
    expect(host.log.slice(5)).toEqual(['enter:me', 'line:a:l1']);
    player.update(100);
    expect(player.status()).toBe('playing');
    host.lines.set('l1', 'completed');
    player.update(100);
    expect(player.status()).toBe('awaiting-input');
    player.update(1000);
    expect(host.log.at(-1)).toBe('line:a:l1');
    expect(player.next(1000)).toBe(true);
    expect(host.log.slice(7)).toEqual(['sfx:ding', 'pose:me']);
    player.update(1001);
    host.lines.set('l2', 'completed');
    player.update(1001);
    // advance: auto continues without input once the line ended.
    expect(host.log.at(-1)).toBe('exit:a');
    player.update(1002);
    expect(player.status()).toBe('completed');
    expect(
      events.filter((e) => e.type === 'line').map((e) => (e as { line: string }).line),
    ).toEqual(['l1', 'l2']);
    expect(events.at(-1)).toEqual({ type: 'completed', cutscene: 'scene' });
  });

  it('a failed or blocked line waits for input even with auto advance', () => {
    const { host, player } = run();
    const until = (from: number, to: number) => {
      for (let t = from; t <= to; t += 0.25) player.update(t);
    };
    player.play(0);
    until(0, 10);
    expect(host.log).toContain('line:a:l1');
    host.lines.set('l1', 'failed');
    player.update(10);
    expect(player.status()).toBe('awaiting-input');
    player.next(10);
    until(10, 20);
    expect(host.log).toContain('line:me:l2');
    host.lines.set('l2', 'failed');
    player.update(20);
    expect(player.status()).toBe('awaiting-input');
  });

  it('pauses with composed reasons, skips to the end state and replays from a marker', () => {
    const { host, events, player } = run(true);
    player.play(0);
    expect(host.log).toContain('background:bg.warm');
    player.pause('menu');
    player.pause('hidden');
    player.update(50);
    expect(player.status()).toBe('paused');
    expect(player.next(50)).toBe(false);
    player.resume('menu');
    expect(player.status()).toBe('paused');
    player.resume('hidden');
    for (let t = 50; t <= 55; t += 0.25) player.update(t);
    expect(host.log).toContain('line:a:l1');
    host.log = [];
    player.skip(56);
    expect(host.log).toEqual(['stopLine', 'settle', 'pose:me!', 'exit:a!', 'settle']);
    expect(player.status()).toBe('skipped');
    expect(events.at(-1)).toEqual({ type: 'skipped', cutscene: 'scene' });
    host.log = [];
    player.play(60, { from: 'after-l1' });
    expect(host.log).toEqual([
      'reset',
      'stopLine',
      'background:bg.warm!',
      'music:theme!',
      'enter:a!',
      'enter:me!',
      'settle',
      'sfx:ding',
      'pose:me',
    ]);
    expect(player.marker()).toBe('after-l1');
    expect(() => player.play(0, { from: 'nope' })).toThrow(/marker/);
  });
});
