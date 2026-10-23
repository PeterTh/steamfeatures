import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { features } from '../src/features.mjs';
import { featureColumns, presentationFeatures } from '../src/feature-presentation.mjs';
import { renderSiteTemplate } from '../scripts/site-template.mjs';

test('every column has its own SVG symbol and distinct artwork, including optional columns', async () => {
  const svg = await readFile(new URL('../src/column-icons.svg', import.meta.url), 'utf8');
  const entries = [...svg.matchAll(/<symbol id="column-([^"]+)" viewBox="0 0 24 24">([\s\S]*?)<\/symbol>/g)];
  const symbols = new Map(entries.map(([, id, content]) => [id, content.trim().replace(/\s+/g, ' ')]));
  assert.equal(symbols.size, entries.length, 'SVG symbol IDs must be unique');
  const columns = featureColumns(features);
  assert.deepEqual([...symbols.keys()].sort(), columns.map(column => column.key).sort());
  const artwork = new Map();
  for (const column of columns) {
    assert.equal(column.icon, 'column-' + column.key, column.name);
    const paths = symbols.get(column.key);
    assert.match(paths, /<(?:path|rect|circle|ellipse|g)\b/, column.name + ' needs SVG artwork');
    assert.ok(!artwork.has(paths), `${column.name} reuses the artwork of ${artwork.get(paths)}`);
    artwork.set(paths, column.name);
  }
  for (const feature of presentationFeatures(features)) {
    assert.ok(symbols.has(feature.icon.slice('column-'.length)), feature.name + ' needs a picker/tooltip icon');
  }
});

test('built pages include every column symbol once and preserve the template around the sprite', async () => {
  const [template, sprite] = await Promise.all([
    readFile(new URL('../src/template.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/column-icons.svg', import.meta.url), 'utf8'),
  ]);
  const html = renderSiteTemplate(template, sprite);
  const [before, after] = template.split('<!-- COLUMN_ICON_SPRITE -->');
  assert.ok(html.startsWith(before) && html.endsWith(after));
  assert.equal(html.includes('<!-- COLUMN_ICON_SPRITE -->'), false);
  for (const column of featureColumns(features)) assert.equal(html.split(`id="column-${column.key}"`).length, 2, column.name);
  assert.throws(() => renderSiteTemplate('No sprite marker', sprite), /Invalid column icon template/);
});
