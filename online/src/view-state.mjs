import { parseQuery, serializeQuery } from './query.mjs';
import { featureColumns } from './feature-presentation.mjs';

function validHighlight(value, features) {
  return typeof value === 'string' && featureColumns(features).some(feature => feature.key === value) ? value : null;
}

/** Column highlighting is URL state, independent of the catalog query. */
export function parseView(search = '', features, tags = [], languages = []) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(String(search).replace(/^\?/, '').split('#')[0]);
  const query = parseQuery(params, features, tags, languages);
  const highlights = params.getAll('highlight');
  const highlight = new Set(highlights).size === 1 ? validHighlight(highlights[0], features) : null;
  return { query, highlight };
}

/** Return a canonical URL query string without adding display state to the query. */
export function serializeView(query, highlight, features, tags = [], languages = []) {
  const search = serializeQuery(query, features, tags, languages);
  const key = validHighlight(highlight, features);
  if (key === null) return search;
  const params = new URLSearchParams(search || '?v=1');
  params.set('highlight', key);
  return `?${params.toString()}`;
}
