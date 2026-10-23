import { extraFeatures, hardwareDevices, isFeatureKnown, featureWeight } from './extra-features.mjs';

export const compatibilityTargets = hardwareDevices.map(device => ({
  key: device.key, name: device.name, parameter: device.key.slice('steam-'.length),
  ratings: extraFeatures.filter(feature => feature.knowledgeGroup === `${device.key}-status`).map(feature => ({
    id: feature.id, value: feature.key.slice(device.key.length + 1), label: feature.name.slice(feature.name.indexOf(':') + 1).trim(),
  })),
}));

const deviceByStatus = new Map(hardwareDevices.flatMap(device =>
  (device.key === 'steam-os' ? [0, 1, 2] : [0, 1, 2, 3]).map(status => [device.base + status, device])));
const descriptions = new Map(extraFeatures.map(feature => [feature.id, feature.description]));

/** Keep the collected flags intact; choose the features offered by the interface. */
export function presentationFeatures(features) {
  const visible = features.filter(feature => feature.id !== 45 && (!feature.hardware || deviceByStatus.has(feature.id))).map(feature => {
    const device = deviceByStatus.get(feature.id);
    return { ...feature, icon: 'column-' + (device?.key ?? feature.key),
      ...(feature.id === 46 ? { group: 'Remote Play' } : {}),
      ...(descriptions.has(feature.id) ? { description: descriptions.get(feature.id) } : {}) };
  });
  for (const [id, after] of [[10002, 22], [10001, 23], [46, 43]]) {
    const index = visible.findIndex(feature => feature.id === id);
    if (index < 0 || !visible.some(feature => feature.id === after)) continue;
    const [feature] = visible.splice(index, 1);
    visible.splice(visible.findIndex(feature => feature.id === after) + 1, 0, feature);
  }
  return visible;
}

/** A hardware target has several filterable ratings, but only one table column. */
export function featureColumns(features) {
  const visible = presentationFeatures(features), columns = [], seen = new Set();
  for (const feature of visible) {
    const device = deviceByStatus.get(feature.id);
    if (!device) { columns.push(feature); continue; }
    if (seen.has(device.key)) continue;
    seen.add(device.key);
    const statuses = visible.filter(candidate => deviceByStatus.get(candidate.id) === device).map(candidate => ({ ...candidate,
      status: candidate.key.slice(device.key.length + 1), label: candidate.name.slice(candidate.name.indexOf(':') + 1).trim() }));
    columns.push({ id: device.base + 9, key: device.key, name: device.name, group: 'Steam hardware', hardware: true,
      icon: 'column-' + device.key, short: device.short, knowledgeGroup: `${device.key}-status`, statuses,
      weight: Math.max(0, ...statuses.map(status => status.weight ?? 1)), minWeight: Math.min(0, ...statuses.map(status => status.weight ?? 1)),
      description: device.key === 'steam-frame'
        ? "Steam's rating of how well the game runs directly on Steam Frame, without streaming from a PC."
        : `Steam's rating of how well the game runs on ${device.name}.` });
  }
  return columns;
}

export function columnState(game, column) {
  if (column.statuses) {
    const rating = column.statuses.find(status => game.featureIds.includes(status.id));
    const status = rating?.status ?? 'unknown';
    const positive = status === 'verified' || status === 'supported';
    return { status, label: rating?.label ?? 'Unknown', listed: Boolean(rating),
      supported: positive || status === 'playable' ? 'true' : status === 'unsupported' ? 'false' : 'unknown',
      mark: positive ? '✓' : status === 'playable' ? '✓' : status === 'unsupported' ? '−' : '?',
      className: positive ? 'check' : status === 'playable' ? 'check playable' : status === 'unsupported' ? 'check negative' : 'dash' };
  }
  const known = isFeatureKnown(game, column), listed = game.featureIds.includes(column.id), weight = featureWeight(game, column), negative = listed && weight < 0;
  const neutral = listed && weight === 0;
  return { status: !known ? 'unknown' : listed ? 'listed' : 'not-listed', listed,
    label: !known ? 'Unknown' : listed ? `Listed${negative ? ' · −' + Math.abs(weight) + ' score point' : neutral ? ' · 0 score points' : ''}` : 'Not listed',
    supported: known ? String(listed) : 'unknown', mark: !known ? '?' : negative ? '−' : listed ? '✓' : '–',
    className: listed ? `check${negative ? ' negative' : neutral ? ' neutral' : ''}` : 'dash' };
}

/** Details are available even for an optional account or explicit no-DRM text. */
export function disclosureDetails(game, column) {
  const data = game.disclosures ?? {};
  if (column.id === 10003 && data.drm) return {
    summary: game.featureIds.includes(column.id) ? 'Third-party DRM disclosed · −1 score point' : 'No third-party DRM disclosed',
    description: data.drm, facts: data.drmActivationLimit ? [['Activation limit', data.drmActivationLimit]] : []
  };
  if (column.id === 10004 && data.account) return {
    summary: data.accountRequired === true ? 'Account required for the game or some features · −1 score point'
      : data.accountRequired === false ? 'No required third-party account disclosed · no score penalty' : 'Account requirement unclear · no score penalty',
    description: data.account,
    facts: data.accountLinking === true ? [['Steam account linking', 'Supported']] : []
  };
  if (column.id === 8 && game.featureIds.includes(8)) return {
    summary: 'Valve Anti-Cheat advertised · 0 score points', description: 'Steam lists Valve Anti-Cheat support for this game.', facts: []
  };
  if (column.id !== 10005 || !data.antiCheat) return null;
  const anti = data.antiCheat, vac = data.vac || game.featureIds.includes(8), facts = [];
  if (vac && !/\bvac\b|valve anti-cheat/i.test(anti.name ?? '')) facts.push(['Valve Anti-Cheat', 'Also advertised by Steam']);
  if (typeof anti.kernelMode === 'boolean') facts.push(['Kernel mode', anti.kernelMode ? 'Yes' : 'No']);
  if (typeof anti.bootProtection === 'boolean') facts.push(['Boot protection', anti.bootProtection ? anti.bootProtectionName || 'Yes' : 'No']);
  if (typeof anti.uninstallsCompletely === 'boolean') facts.push(['Fully removed on uninstall', anti.uninstallsCompletely ? 'Yes' : 'No']);
  return { summary: `${game.featureIds.includes(column.id) ? 'Third-party anti-cheat disclosed'
    : isFeatureKnown(game, column) ? 'Only Valve Anti-Cheat disclosed' : 'Third-party anti-cheat unknown'} · ${game.featureIds.includes(column.id) && featureWeight(game, column) < 0 ? '−1 score point' : '0 score points'}`, facts,
    description: anti.name || 'Anti-cheat software is disclosed; its name is not available in this snapshot.' };
}
