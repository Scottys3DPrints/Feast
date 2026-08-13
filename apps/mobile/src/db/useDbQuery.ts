import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

/**
 * Run a synchronous SQLite read and refresh it whenever the screen regains focus.
 *
 * ⚠️ Phase 4 should replace this with Drizzle's `useLiveQuery()` (§4.6), which is
 * backed by SQLite change notifications and updates without a focus event. This exists
 * because `useLiveQuery` only works over Drizzle's query builder, and several of the
 * §17 list queries need `COALESCE`/`LEFT JOIN` shapes written as raw SQL.
 *
 * The reads are synchronous and indexed, so re-running them on focus costs well under
 * the 1.2 s cold-start budget — but it does mean a value mutated while the screen is
 * visible will not repaint on its own. Mutations that must show immediately should
 * update local state as well.
 */
export function useDbQuery<T>(read: () => T, deps: readonly unknown[] = []): T | undefined {
  const [value, setValue] = useState<T>();

  useFocusEffect(
    useCallback(() => {
      setValue(read());
      // `read` is intentionally not a dependency: callers pass inline closures, and
      // depending on identity would re-run on every render.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps),
  );

  return value;
}
