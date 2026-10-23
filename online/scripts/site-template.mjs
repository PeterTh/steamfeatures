import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const marker = '<!-- COLUMN_ICON_SPRITE -->';

/** One source SVG, embedded once so every redraw uses local symbol references. */
export function renderSiteTemplate(template, sprite) {
  if (template.split(marker).length !== 2 || !sprite.startsWith('<svg ')) throw new Error('Invalid column icon template');
  return template.replace(marker, sprite.replace('<svg ', '<svg class="svg-defs" aria-hidden="true" '));
}

export async function writeSiteTemplate(directory) {
  const [template, sprite] = await Promise.all([
    readFile(resolve(ROOT, 'src/template.html'), 'utf8'), readFile(resolve(ROOT, 'src/column-icons.svg'), 'utf8'),
  ]);
  await writeFile(resolve(directory, 'index.html'), renderSiteTemplate(template, sprite));
}
