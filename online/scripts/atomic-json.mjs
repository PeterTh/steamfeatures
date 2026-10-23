import { rename, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';

const fileBusy = error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);

/** Keep the prior JSON readable until replacement succeeds. Windows readers or
 * scanners can briefly prevent rename; retry only that operation, never the
 * collection request that produced the checkpoint. Permanent errors still stop.
 * Callers serialize writes to a given filename. */
export async function writeAtomicJSON(filename, value, { renameFile = rename, sleep = pause } = {}) {
  const temporary = filename + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try { await renameFile(temporary, filename); return; }
    catch (error) {
      if (!fileBusy(error) || attempt >= 7) throw error;
      await sleep(Math.min(50 * (2 ** attempt), 1000));
    }
  }
}

/** Routine progress is a view of the durable SQLite checkpoint. Defer a busy
 * snapshot instead of stopping collection; terminal status and archive metadata
 * remain strict. Callers serialize updates, and continue logging current status. */
export function createProgressWriter(filename, { now = Date.now, intervalMs = 30000,
  writeJSON = writeAtomicJSON, warn = message => console.error(message) } = {}) {
  let lastAttempt = -Infinity;
  return async status => {
    const routine = status.phase === 'collecting';
    if (routine && now() - lastAttempt < intervalMs) return false;
    lastAttempt = now();
    try { await writeJSON(filename, status); return true; }
    catch (error) {
      if (!routine || !fileBusy(error)) throw error;
      warn(JSON.stringify({ warning: 'Progress file is busy; collection continues from SQLite',
        filename, at: status.updatedAt, error: error.message }));
      return false;
    }
  };
}
