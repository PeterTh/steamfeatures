/** Table labels are public URL aliases; ambiguous legacy labels use full keys. */
export function featureCodes(features) {
  const byKey = new Map(features.map(feature => [feature.key, feature]));
  const keys = new Map(features.map(feature => [feature.key.toUpperCase(), feature]));
  const byCode = new Map();
  for (const feature of features) {
    if (typeof feature.short !== 'string' || !/^[a-z0-9]{2,3}$/i.test(feature.short)) continue;
    const code = feature.short.toUpperCase();
    byCode.set(code, byCode.has(code) || (keys.has(code) && keys.get(code).id !== feature.id) ? null : feature);
  }
  return {
    resolve(value) {
      return typeof value === 'string' ? byKey.get(value) ?? byCode.get(value.toUpperCase()) ?? null : null;
    },
    token(feature) {
      const code = typeof feature.short === 'string' ? feature.short.toUpperCase() : null;
      return byCode.get(code)?.id === feature.id ? code : feature.key;
    }
  };
}
