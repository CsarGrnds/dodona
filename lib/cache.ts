// Tiny in-memory TTL cache so repeated page loads don't hammer Yahoo/Google.
type Entry<T> = { value: T; expires: number };
const store = new Map<string, Entry<unknown>>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  const now = Date.now();
  if (hit && hit.expires > now) return hit.value;
  const value = await fn();
  store.set(key, { value, expires: now + ttlMs });
  return value;
}
