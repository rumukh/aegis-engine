import { check, id, ids, list, record, reference, text, unique } from './validation.js';

export interface CosmeticItem {
  id: string;
  slot: string;
  assetId: string;
}
export interface CosmeticState {
  schema: 1;
  owned: string[];
  claims: { id: string; item: string }[];
  equipped: { slot: string; item: string }[];
}

function claimIdentity(value: unknown, path: string): string {
  const result = text(value, path);
  check(
    result.length <= 512,
    'CLAIM-BOUND',
    path,
    'Claim identity exceeds 512 characters.',
    'Use a bounded stable claim identifier.',
  );
  return result;
}

export function validateCosmetics(value: unknown, assets: readonly string[]): CosmeticItem[] {
  const catalog = list(value, '$.catalog', (v, p) => {
    const item = record(v, p),
      assetId = id(item.assetId, `${p}.assetId`);
    reference(assetId, assets, `${p}.assetId`);
    return { id: id(item.id, `${p}.id`), slot: id(item.slot, `${p}.slot`), assetId };
  });
  unique(
    catalog.map((item) => item.id),
    '$.catalog',
  );
  return catalog;
}

export function createCosmeticState(): CosmeticState {
  return { schema: 1, owned: [], claims: [], equipped: [] };
}

export function restoreCosmetics(catalog: readonly CosmeticItem[], value: unknown): CosmeticState {
  const items = validateCosmetics(
    catalog,
    catalog.map((c) => c.assetId),
  );
  const o = record(value, '$');
  check(o.schema === 1, 'VERSION', '$.schema', 'Unsupported cosmetic state.', 'Use schema 1.');
  const owned = ids(o.owned, '$.owned');
  owned.forEach((key) =>
    reference(
      key,
      items.map((c) => c.id),
      '$.owned',
    ),
  );
  const claims = list(
    o.claims,
    '$.claims',
    (v, p) => {
      const c = record(v, p),
        item = id(c.item, `${p}.item`);
      reference(item, owned, p);
      return { id: claimIdentity(c.id, `${p}.id`), item };
    },
    4096,
  );
  unique(
    claims.map((c) => c.id),
    '$.claims',
  );
  check(
    owned.every((key) => claims.some((c) => c.item === key)),
    'RESTORE',
    '$.owned',
    'Owned cosmetic lacks a grant claim.',
    'Store the original idempotent grant.',
  );
  const equipped = list(o.equipped, '$.equipped', (v, p) => {
    const e = record(v, p),
      slot = id(e.slot, `${p}.slot`),
      item = id(e.item, `${p}.item`);
    reference(item, owned, p);
    check(
      items.some((c) => c.id === item && c.slot === slot),
      'COSMETIC-SLOT',
      p,
      'Cosmetic does not fit the slot.',
      'Use an owned item declared for this slot.',
    );
    return { slot, item };
  });
  unique(
    equipped.map((e) => e.slot),
    '$.equipped',
  );
  return { schema: 1, owned, claims, equipped };
}

/** Shared by minigame completion and narrative reward consumers; duplicate grants never accumulate currency. */
export function grantCosmetic(
  catalog: readonly CosmeticItem[],
  snapshot: CosmeticState,
  claimId: string,
  itemId: string,
): CosmeticState {
  const state = restoreCosmetics(catalog, snapshot);
  claimIdentity(claimId, '$.claimId');
  reference(
    itemId,
    catalog.map((c) => c.id),
    '$.itemId',
  );
  const prior = state.claims.find((c) => c.id === claimId);
  check(
    !prior || prior.item === itemId,
    'CLAIM-CONFLICT',
    '$.claimId',
    'Claim identity was reused for a different cosmetic.',
    'Use a stable claim ID for one logical grant.',
  );
  if (prior) return state;
  state.claims.push({ id: claimId, item: itemId });
  if (!state.owned.includes(itemId)) state.owned.push(itemId);
  return state;
}

export function equipCosmetic(
  catalog: readonly CosmeticItem[],
  snapshot: CosmeticState,
  itemId: string,
): CosmeticState {
  const state = restoreCosmetics(catalog, snapshot);
  const item = catalog.find((c) => c.id === itemId);
  check(
    item && state.owned.includes(itemId),
    'COSMETIC-OWNERSHIP',
    '$.itemId',
    'Cosmetic is unknown or not owned.',
    'Grant the cosmetic before equipping it.',
  );
  return {
    ...state,
    equipped: [
      ...state.equipped.filter((e) => e.slot !== item.slot),
      { slot: item.slot, item: itemId },
    ],
  };
}
