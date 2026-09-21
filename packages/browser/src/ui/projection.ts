import { BrowserServiceError, requireId } from '../errors.js';

export interface PresentationContent {
  label: string;
  text?: string;
  caption?: string;
  narration?: { packId: string; lineId: string };
}
export interface PresentationEntry {
  id: string;
  content: PresentationContent;
  playerIds?: readonly string[];
  spoiler?: boolean;
  /** Required action warnings remain available through an authored safe alternative. */
  safeAlternative?: PresentationContent;
}
export interface ProjectionPolicy {
  playerId?: string;
  handoff?: boolean;
  hideSpoilers?: boolean;
}
export interface ProjectedEntry {
  id: string;
  content: PresentationContent;
}

/** Only projected records should enter DOM, live regions, captions or narration. */
export function projectPresentation(
  entries: readonly PresentationEntry[],
  policy: ProjectionPolicy,
): ProjectedEntry[] {
  if (policy.handoff) return [];
  const seen = new Set<string>();
  const output: ProjectedEntry[] = [];
  for (const item of entries) {
    requireId(item.id);
    if (seen.has(item.id))
      throw new BrowserServiceError('invalid-data', 'Duplicate presentation entry.');
    seen.add(item.id);
    const privateDenied =
      item.playerIds !== undefined &&
      (policy.playerId === undefined || !item.playerIds.includes(policy.playerId));
    const hidden = privateDenied || (policy.hideSpoilers && item.spoiler);
    const content = hidden ? item.safeAlternative : item.content;
    if (content) output.push({ id: item.id, content: structuredClone(content) });
  }
  return output;
}
