import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPicsClient } from '../scripts/steam-pics.mjs';

class FakeSteam extends EventEmitter {
  logOn(options) { this.logOnOptions = options; queueMicrotask(() => this.emit('loggedOn')); }
  async getProductInfo(ids, packages, tokens) {
    assert.deepEqual(packages, []); assert.equal(tokens, true);
    return { apps: Object.fromEntries(ids.map(id => [id, { appinfo: { appid: String(id), common: {} } }])), unknownApps: [] };
  }
  logOff() { this.loggedOff = true; }
}
test('PICS uses an anonymous session, serial batches and a pause after each response', async () => {
  let time = 0; const waits = []; const user = new FakeSteam();
  const client = createPicsClient({ client: user, now: () => time, sleep: async ms => { waits.push(ms); time += ms; } });
  try {
    await Promise.all([client.getItems([10]), client.getItems([20])]);
    assert.deepEqual(user.logOnOptions, { anonymous: true });
    assert.deepEqual(waits, [5000]);
    assert.equal(client.stats.requests, 2);
    assert.throws(() => client.getItems(Array.from({ length: 101 }, (_, i) => i + 1)), /1–100/);
  } finally { client.close(); }
  assert.equal(user.loggedOff, true);
});
test('PICS disconnects fail pending work instead of waiting for the request timeout', async () => {
  const user = new FakeSteam();
  user.getProductInfo = async () => { queueMicrotask(() => user.emit('disconnected', 3, 'server unavailable')); return new Promise(() => {}); };
  const client = createPicsClient({ client: user });
  try { await assert.rejects(client.getItems([10]), /disconnected/); await assert.rejects(client.getItems([20]), /disconnected/); }
  finally { client.close(); }
});
