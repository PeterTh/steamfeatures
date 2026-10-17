import test from 'node:test';
import assert from 'node:assert/strict';
import { features } from '../src/features.mjs';
import { featureColumns } from '../src/feature-presentation.mjs';
import { normalizeQuery, parseQuery, serializeQuery } from '../src/query.mjs';

test('all table labels, including optional columns, stay unique URL codes', () => {
  const seen = new Map();
  // Also reserve the code of the hidden cloud-streaming filter. Hardware ratings
  // deliberately share labels and are represented by one column per device.
  const labelled = new Map([...features.filter(feature => !feature.hardware), ...featureColumns(features)]
    .map(feature => [feature.key, feature]));
  for (const feature of labelled.values()) {
    assert.match(feature.short, /^[A-Z0-9]{2,3}$/, `${feature.name} needs a 2–3-character uppercase code`);
    const code = feature.short.toUpperCase();
    assert.ok(!seen.has(code), `${code} is shared by ${seen.get(code)} and ${feature.name}`);
    seen.set(code, feature.name);
    const conflictingKey = features.find(other => other.id !== feature.id && other.key.toUpperCase() === code);
    assert.equal(conflictingKey, undefined, `${code} must not shadow another feature's full key`);
  }
});

test('every filter code accepts any letter case and retains its full-key alias', () => {
  for (const feature of features.filter(feature => !feature.hardware)) {
    for (const token of [feature.short, feature.short.toLowerCase(), feature.key]) {
      assert.deepEqual(parseQuery(`?has=${token}`, features).has, [feature.id], token);
      assert.deepEqual(parseQuery(`?not=${token}`, features).not, [feature.id], token);
    }
    assert.deepEqual(normalizeQuery({ has: [feature.id, feature.key, feature.short] }, features).has, [feature.id]);
    const params = new URLSearchParams(serializeQuery({ has: [feature.id] }, features));
    assert.equal(params.get('has'), feature.short);
  }
});

test('mixed codes and full keys deduplicate, round-trip and generate compact URLs', () => {
  const old = '?v=1&has=steam-cloud,single-player,steam-achievements&not=third-party-anti-cheat,third-party-drm';
  const mixed = '?has=cld,steam-cloud,1p&has=ACH&not=TaC,third-party-drm';
  const expected = normalizeQuery({ has: [2, 22, 23], not: [10003, 10005] }, features);
  assert.deepEqual(parseQuery(old, features), expected);
  assert.deepEqual(parseQuery(mixed, features), expected);
  const compact = serializeQuery(expected, features);
  assert.equal(compact, '?v=1&has=1P%2CACH%2CCLD&not=DRM%2CTAC');
  assert.deepEqual(parseQuery(compact, features), expected);
  assert.ok(compact.length < old.length / 2);
});

test('alias conflicts and unknown codes cannot silently broaden a filter', () => {
  for (const search of ['?has=CLD&not=steam-cloud', '?has=steam-cloud&not=cld', '?has=ZZZ', '?not=NET', '?has=REQ']) {
    assert.throws(() => parseQuery(search, features), undefined, search);
  }
  assert.throws(() => parseQuery('?has=steam-deck-verified', features), /Use a compatibility filter/);
  assert.throws(() => parseQuery('?has=DCK', features), /Unknown required feature/);
});

test('legacy catalogs without codes or with ambiguous labels retain full-key URLs', () => {
  const legacy = [
    { id: 1, key: 'first', short: 'DUP' },
    { id: 2, key: 'second', short: 'dup' },
    { id: 3, key: 'third' }
  ];
  assert.equal(serializeQuery({ has: [1, 2, 3] }, legacy), '?v=1&has=first%2Csecond%2Cthird');
  assert.deepEqual(parseQuery('?has=first,second,third', legacy).has, [1, 2, 3]);
  assert.throws(() => parseQuery('?has=DUP', legacy), /Unknown required feature/);
  const shadowed = [{ id: 1, key: 'first', short: 'TWO' }, { id: 2, key: 'two' }];
  assert.equal(serializeQuery({ has: [1] }, shadowed), '?v=1&has=first');
  assert.deepEqual(parseQuery('?has=two', shadowed).has, [2]);
  assert.throws(() => parseQuery('?has=TWO', shadowed), /Unknown required feature/);
});
