/** Resources owned by a cache must survive removal of any one borrowing scene object. */
const borrowed = new WeakSet<object>();

export function sharedResource<T extends object>(resource: T): T {
  borrowed.add(resource);
  return resource;
}

export function isSharedResource(resource: object): boolean {
  return borrowed.has(resource);
}
