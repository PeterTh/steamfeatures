import { parseQuery, serializeQuery } from './query.mjs';
import { featureColumns } from './feature-presentation.mjs';
import { featureCodes } from './feature-codes.mjs';

/** Column highlighting is URL state, independent of the catalog query. */
export function parseView(search = '', features, tags = [], languages = []) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(String(search).replace(/^\?/, '').split('#')[0]);
  const query = parseQuery(params, features, tags, languages);
  const codes = featureCodes(featureColumns(features));
  const highlights = params.getAll('highlight').map(value => codes.resolve(value)?.key ?? null);
  const highlight = highlights.length && highlights[0] && new Set(highlights).size === 1 ? highlights[0] : null;
  return { query, highlight };
}

/** Return a canonical URL query string without adding display state to the query. */
export function serializeView(query, highlight, features, tags = [], languages = []) {
  const search = serializeQuery(query, features, tags, languages);
  const codes = featureCodes(featureColumns(features)), column = codes.resolve(highlight);
  if (column === null) return search;
  const params = new URLSearchParams(search || '?v=1');
  params.set('highlight', codes.token(column));
  return `?${params.toString()}`;
}
