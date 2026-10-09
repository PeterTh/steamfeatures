import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REFRESH_BUDGET, createRefreshState, validateRefreshState,
  selectRefreshBatch, applyRefreshResults, isSteamDenied
} from '../scripts/refresh-state.mjs';

const at = day => `2026-10-${String(day).padStart(2, '0')}T04:17:00.000Z`;
const game = (id, fields = {}) => ({ id, name: `Game ${id}`, releaseStatus: 'released', reviews: 10, tagIds: [0], ...fields });
const ok = (id, metadata = {}) => ({ id, status: 'ok', metadata: { appType: 0, reviews: 10, tags: ['Action'], ...metadata } });
const apply = (state, results, day = 1) => applyRefreshResults(state, { results, now: at(day) });
const select = (games, state = createRefreshState(), fields = {}) => selectRefreshBatch({ games, state, now: at(2), ...fields });

test('fresh durable state starts unbootstrapped and round trips as JSON', () => {
  assert.equal(DEFAULT_REFRESH_BUDGET, 4000);
  const state = createRefreshState();
  assert.deepEqual(state, { version: 1, bootstrapComplete: false, apps: {} });
  assert.deepEqual(validateRefreshState(JSON.parse(JSON.stringify(state))), state);
});

test('default daily rotation is bounded at 4,000 and configurable up to 5,000', () => {
  const games = Array.from({ length: 5100 }, (_, i) => game(i + 1));
  assert.equal(select(games).length, 4000);
  assert.equal(select(games, undefined, { budget: 5000 }).length, 5000);
  for (const budget of [0, -1, 5001, 1.5, NaN, '4000']) assert.throws(() => select(games, undefined, { budget }), /budget/);
});

test('selection excludes unreleased games, known non-game types, and separate new-release IDs', () => {
  const state = apply(createRefreshState(), [ok(3, { appType: 12 }), ok(4, { appType: 6 }), ok(5, { releaseStatus: 'upcoming' }), ok(6, { releaseStatus: 'released' })]);
  const games = [game(1), game(2, { releaseStatus: 'unknown' }), game(3), game(4), game(5), game(6, { releaseStatus: 'upcoming' }), game(7), game(8, { releaseStatus: 'upcoming' })];
  assert.deepEqual(select(games, state, { excludeIds: [7] }), [1, 6]);
});

test('never-attempted games fill metadata gaps first without treating zero reviews as missing', () => {
  const games = [game(1), game(2, { reviews: null }), game(3, { tagIds: [] }), game(4, { reviews: null, tagIds: [] }), game(5, { reviews: 0 })];
  assert.deepEqual(select(games), [4, 2, 3, 1, 5]);
});

test('oldest attempts come after untouched games and ahead of newer attempts regardless of success', () => {
  let state = apply(createRefreshState(), [ok(2), { id: 3, status: 'failed' }], 1);
  state = apply(state, [ok(1)], 2);
  assert.deepEqual(select([game(1), game(2), game(3), game(4)], state, { now: at(3) }), [4, 2, 3, 1]);
});

test('a full cycle visits every game once before repeating and continues after JSON reload', () => {
  const games = Array.from({ length: 103 }, (_, i) => game(i + 1));
  let state = createRefreshState();
  const visited = [];
  for (let day = 1; day <= 6; day++) {
    const ids = select(games, state, { budget: 20, now: at(day) });
    visited.push(...ids);
    state = JSON.parse(JSON.stringify(apply(state, ids.map(id => ok(id)), day)));
  }
  assert.equal(new Set(visited.slice(0, 103)).size, 103);
  assert.deepEqual(visited.slice(103), Array.from({ length: 17 }, (_, i) => i + 1));
  assert.deepEqual(select(games, state, { budget: 20, now: at(7) }), Array.from({ length: 20 }, (_, i) => i + 18));
});

test('failure retry delays are honored, grow exponentially, and cap at 30 days', () => {
  let state = createRefreshState();
  let now = at(1);
  for (let count = 1; count <= 8; count++) {
    state = applyRefreshResults(state, { now, results: [{ id: 1, status: 'failed' }] });
    const entry = state.apps[1];
    assert.equal(entry.failures, count);
    assert.equal(Date.parse(entry.retryNotBefore) - Date.parse(now), Math.min(2 ** (count - 1), 30) * 86400000);
    assert.deepEqual(select([game(1)], state, { now }), []);
    assert.deepEqual(select([game(1)], state, { now: entry.retryNotBefore }), [1]);
    now = entry.retryNotBefore;
  }
});

test('a failed app moves behind untouched and older apps rather than starving them', () => {
  const games = [game(1, { reviews: null, tagIds: [] }), game(2), game(3)];
  let state = createRefreshState();
  assert.deepEqual(select(games, state, { budget: 1, now: at(1) }), [1]);
  state = apply(state, [{ id: 1, status: 'failed' }], 1);
  assert.deepEqual(select(games, state, { budget: 1, now: at(2) }), [2]);
  state = apply(state, [ok(2)], 2);
  assert.deepEqual(select(games, state, { budget: 1, now: at(3) }), [3]);
  state = apply(state, [ok(3)], 3);
  assert.deepEqual(select(games, state, { budget: 1, now: at(4) }), [1]);
});

test('unavailable entries receive a 30-day cooldown without erasing previous data', () => {
  const before = apply(createRefreshState(), [ok(1, { reviews: 1700 })]);
  const state = apply(before, [{ id: 1, status: 'unavailable' }], 2);
  assert.deepEqual(state.apps[1].metadata, before.apps[1].metadata);
  assert.equal(state.apps[1].checkedAt, at(1));
  assert.equal(state.apps[1].lastAttemptAt, at(2));
  assert.equal(Date.parse(state.apps[1].retryNotBefore) - Date.parse(at(2)), 30 * 86400000);
  assert.deepEqual(validateRefreshState(state), state);
});

test('confirmed denial result codes survive persistence and normal refresh retries after 30 days', () => {
  const before = apply(createRefreshState(), [ok(1)]);
  const state = apply(before, [{ id: 1, status: 'unavailable', resultCode: 15 }], 2);
  assert.equal(isSteamDenied(state.apps[1]), true);
  assert.deepEqual(validateRefreshState(JSON.parse(JSON.stringify(state))), state);
  assert.equal(state.apps[1].checkedAt, at(1));
  assert.deepEqual(select([game(1)], state, { now: at(3) }), []);
  assert.deepEqual(select([game(1)], state, { now: state.apps[1].retryNotBefore }), [1]);
  const failed = apply(state, [{ id: 1, status: 'failed', resultCode: 2 }], 3);
  assert.equal(failed.apps[1].resultCode, 2);
  assert.equal(isSteamDenied(failed.apps[1]), false);
  const networkFailure = apply(failed, [{ id: 1, status: 'failed' }], 4);
  assert.equal(networkFailure.apps[1].resultCode, undefined);
  const recovered = apply(networkFailure, [ok(1)], 5);
  assert.equal(recovered.apps[1].resultCode, undefined);
  assert.equal(recovered.apps[1].status, 'ok');
  assert.equal(isSteamDenied({ status: 'unavailable' }), false);
});

test('invalid and inconsistent result codes cannot create a publication exception', () => {
  const state = apply(createRefreshState(), [{ id: 1, status: 'unavailable', resultCode: 15 }]);
  for (const resultCode of [null, 0, 1, 2, -1, 15.5, '15', 0x100000000]) {
    assert.throws(() => apply(state, [{ id: 1, status: 'unavailable', resultCode }], 2), /result code/);
    assert.throws(() => validateRefreshState({ ...state, apps: { 1: { ...state.apps[1], resultCode } } }), /result code/);
  }
  assert.throws(() => apply(state, [{ id: 1, status: 'failed', resultCode: 15 }], 2), /result code/);
  assert.throws(() => apply(state, [{ ...ok(1), resultCode: 15 }], 2), /result code/);
  const legacy = structuredClone(state);
  delete legacy.apps[1].resultCode;
  assert.deepEqual(validateRefreshState(legacy), legacy);
  assert.equal(isSteamDenied(legacy.apps[1]), false);
});

test('a successful retry clears failure status and refreshes only explicitly provided fields', () => {
  let state = apply(createRefreshState(), [ok(1, { reviews: 100, name: 'Retained name' })]);
  state = apply(state, [{ id: 1, status: 'failed' }], 2);
  state = apply(state, [{ id: 1, status: 'ok', metadata: { reviews: 0, positivePercent: null, tags: [], tagDataKnown: true } }], 3);
  assert.deepEqual(state.apps[1], {
    status: 'ok', lastAttemptAt: at(3), checkedAt: at(3),
    metadata: { appType: 0, name: 'Retained name', reviews: 0, tags: [], positivePercent: null, tagDataKnown: true }
  });
});

test('state updates and selection never mutate caller-owned objects', () => {
  const initial = createRefreshState();
  const result = ok(1);
  const games = [game(1)];
  const before = structuredClone({ initial, result, games });
  const state = apply(initial, [result]);
  select(games, state);
  state.apps[1].metadata.tags.push('Mutated copy');
  assert.deepEqual({ initial, result, games }, before);
  const copied = validateRefreshState(state);
  copied.apps[1].metadata.tags.push('Another copy');
  assert.equal(state.apps[1].metadata.tags.length, 2);
});

test('durable frozen discovery cursor, completion timestamp, and bootstrap status survive updates', () => {
  const state = {
    ...createRefreshState(), bootstrapComplete: true,
    lastDiscoveryAt: at(1), discovery: { since: at(1), until: at(2), nextStart: 1000 }
  };
  const updated = apply(state, [ok(1)], 2);
  assert.equal(updated.bootstrapComplete, true);
  assert.equal(updated.lastDiscoveryAt, at(1));
  assert.deepEqual(updated.discovery, state.discovery);
  updated.discovery.nextStart = 2000;
  assert.equal(state.discovery.nextStart, 1000);
});

test('bootstrap cursor survives a checkpoint and is validated independently from discovery', () => {
  const state = { ...createRefreshState(), bootstrapCursor: { nextStart: 12000, queryComplete: false } };
  const updated = apply(state, [ok(1)]);
  assert.deepEqual(updated.bootstrapCursor, state.bootstrapCursor);
  for (const cursor of [{ nextStart: -1, queryComplete: false }, { nextStart: 0 }, { nextStart: 0, queryComplete: 1 }, { nextStart: 0, queryComplete: false, other: 1 }]) {
    assert.throws(() => validateRefreshState({ ...state, bootstrapCursor: cursor }), /bootstrap cursor/);
  }
});

test('daily rotation count survives updates and cannot contain malformed or excessive attempts', () => {
  const state = { ...createRefreshState(), rotation: { date: '2026-10-01', attempted: 4000 } };
  const updated = apply(state, [ok(1)]);
  assert.deepEqual(updated.rotation, state.rotation);
  updated.rotation.attempted = 5000;
  assert.equal(state.rotation.attempted, 4000);
  for (const rotation of [
    null, [],
    { date: '2026-10-01', attempted: -1 }, { date: '2026-10-01', attempted: 5001 },
    { date: '2026-10-01', attempted: 1.5 }, { date: '2026-02-30', attempted: 0 },
    { date: '2026-10-1', attempted: 0 }, { date: '2026-10-01', attempted: 0, other: true }
  ]) assert.throws(() => validateRefreshState({ ...state, rotation }), /rotation/);
});

test('malformed state and corrupt discovery cursors fail closed', () => {
  for (const patch of [
    { version: 2 }, { apps: [] }, { bootstrapComplete: 'yes' }, { unknownField: 1 },
    { lastDiscoveryAt: 'yesterday' },
    { discovery: { since: at(2), until: at(1), nextStart: 0 } },
    { discovery: { since: at(1), until: at(2), nextStart: -1 } },
    { discovery: { since: at(1), until: at(2), nextStart: 0, wrong: true } }
  ]) assert.throws(() => validateRefreshState({ ...createRefreshState(), ...patch }));
});

test('invalid IDs, timestamps, metadata and duplicate results are rejected atomically', () => {
  const state = apply(createRefreshState(), [ok(1)]);
  const before = structuredClone(state);
  for (const results of [
    [ok(0)], [ok(1.5)], [ok(2), ok(2)],
    [{ id: 2, status: 'other' }], [{ id: 2, status: 'failed', metadata: { reviews: 0 } }],
    [ok(2, { reviews: -1 })], [ok(2, { positivePercent: 101 })],
    [ok(2, { tags: ['Action', 'Action'] })], [ok(2, { releaseISO: '2026-02-30' })],
    [ok(2, { appType: null })], [ok(2, { unrecognized: true })]
  ]) assert.throws(() => apply(state, results, 2));
  assert.throws(() => applyRefreshResults(state, { results: [ok(1)], now: '2026-10-02' }), /timestamp/);
  assert.throws(() => applyRefreshResults(state, { results: [ok(1)], now: '2026-09-30T04:17:00.000Z' }), /backwards/);
  assert.deepEqual(state, before);
});

test('invalid successful or failed state entries cannot reset or skip the queue silently', () => {
  const valid = apply(createRefreshState(), [ok(1)]);
  for (const patch of [
    { checkedAt: at(2) }, { checkedAt: undefined }, { metadata: undefined },
    { status: 'failed', metadata: undefined, failures: 1, retryNotBefore: at(2) },
    { status: 'failed' }, { retryNotBefore: at(2) }, { failures: 1 },
    { status: 'failed', failures: 1, retryNotBefore: at(1) }
  ]) assert.throws(() => validateRefreshState({ ...valid, apps: { 1: { ...valid.apps[1], ...patch } } }));
  assert.throws(() => validateRefreshState({ ...valid, apps: { '01': valid.apps[1] } }), /entry/);
  assert.throws(() => select([game(1), game(1)], valid), /Duplicate/);
  assert.throws(() => select([game(1)], valid, { excludeIds: [0] }), /app ID/);
});
