import SteamUser from 'steam-user';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Anonymous public appinfo only. No account, credentials, ownership or packages. */
export function createPicsClient({ spacingMs = 5000, timeoutMs = 60000, sleep = pause, now = Date.now, client } = {}) {
  if (!Number.isSafeInteger(spacingMs) || spacingMs < 0 || spacingMs > 60000) throw new Error('Invalid PICS request spacing');
  const user = client ?? new SteamUser({ dataDirectory: null, autoRelogin: false, enablePicsCache: false, protocol: SteamUser.EConnectionProtocol.WebSocket });
  let connected = false, closed = false, terminalError, nextAt = 0, requests = 0, queue = Promise.resolve();
  const pending = new Set();
  const fail = error => { terminalError = error instanceof Error ? error : new Error(String(error)); for (const reject of pending) reject(terminalError); };
  user.on('error', fail);
  user.on('disconnected', (code, message) => { connected = false; if (!closed) fail(new Error(`Steam PICS disconnected (${code}): ${message}`)); });
  async function bounded(operation) {
    let timer, rejectOperation;
    const stopped = new Promise((resolve, reject) => { rejectOperation = reject; pending.add(reject); timer = setTimeout(() => reject(new Error('Steam PICS request timed out')), timeoutMs); });
    try { return await Promise.race([operation(), stopped]); }
    finally { clearTimeout(timer); pending.delete(rejectOperation); }
  }
  async function connect() {
    if (closed || terminalError) throw terminalError ?? new Error('Steam PICS client is closed');
    if (connected) return;
    await bounded(() => new Promise(resolve => { user.once('loggedOn', () => { connected = true; resolve(); }); user.logOn({ anonymous: true }); }));
  }
  return {
    get stats() { return { requests }; },
    getItems(ids) {
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff)) throw new Error('PICS requires 1–100 unique app IDs');
      const operation = queue.then(async () => {
        await connect();
        if (nextAt > now()) await sleep(nextAt - now());
        if (terminalError) throw terminalError;
        requests++;
        try {
          // Request any tokens available to the anonymous session. Restricted
          // apps still return public_only; this does not require a user account.
          const result = await bounded(() => user.getProductInfo(ids, [], true));
          if (!result || !result.apps || typeof result.apps !== 'object') throw new Error('Invalid Steam PICS response');
          for (const [key, entry] of Object.entries(result.apps)) if (!ids.includes(Number(key)) || Number(entry.appinfo?.appid) !== Number(key)) throw new Error('Unexpected Steam PICS app');
          return result;
        } finally { nextAt = now() + spacingMs; }
      });
      queue = operation.catch(() => {});
      return operation;
    },
    close() { closed = true; for (const reject of pending) reject(new Error('Steam PICS client closed')); user.logOff(); }
  };
}
