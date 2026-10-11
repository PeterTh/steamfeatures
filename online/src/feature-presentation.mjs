import { extraFeatures, hardwareDevices, isFeatureKnown } from './extra-features.mjs';

export const compatibilityTargets = hardwareDevices.map(device => ({
  key: device.key, name: device.name, parameter: device.key.slice('steam-'.length),
  ratings: extraFeatures.filter(feature => feature.knowledgeGroup === `${device.key}-status`).map(feature => ({
    id: feature.id, value: feature.key.slice(device.key.length + 1), label: feature.name.slice(feature.name.indexOf(':') + 1).trim(),
  })),
}));

const hardwareIcons = { 'steam-deck': 'steam-deck', 'steam-machine': 'steam-machine', 'steam-frame': 'prompt-vr', 'steam-os': 'prompt-steam' };
const deviceByStatus = new Map(hardwareDevices.flatMap(device =>
  (device.key === 'steam-os' ? [0, 1, 2] : [0, 1, 2, 3]).map(status => [device.base + status, device])));
const promptIcons = new Map([[28, 'prompt-gamepad'], [18, 'prompt-gamepad'], [60, 'prompt-gamepad'],
  [55, 'prompt-ds4'], [57, 'prompt-dualsense'], [53, 'prompt-vr'], [54, 'prompt-vr'], [10000, 'prompt-mouse-keyboard']]);
const descriptions = new Map(extraFeatures.map(feature => [feature.id, feature.description]));

/** Keep the collected flags intact; choose the features offered by the interface. */
export function presentationFeatures(features) {
  const visible = features.filter(feature => feature.id !== 45 && (!feature.hardware || deviceByStatus.has(feature.id))).map(feature => {
    const device = deviceByStatus.get(feature.id);
    return { ...feature, ...(feature.id === 46 ? { group: 'Remote Play' } : {}),
      ...(descriptions.has(feature.id) ? { description: descriptions.get(feature.id) } : {}),
      ...(device ? { icon: hardwareIcons[device.key] } : promptIcons.has(feature.id) ? { icon: promptIcons.get(feature.id) } : {}) };
  });
  for (const [id, after] of [[10001, 23], [46, 43]]) {
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
      icon: hardwareIcons[device.key], short: device.short, knowledgeGroup: `${device.key}-status`, statuses,
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
  const known = isFeatureKnown(game, column), listed = game.featureIds.includes(column.id), negative = listed && column.weight < 0;
  return { status: !known ? 'unknown' : listed ? 'listed' : 'not-listed', listed,
    label: !known ? 'Unknown' : listed ? `Listed${negative ? ' · −' + Math.abs(column.weight) + ' score point' : ''}` : 'Not listed',
    supported: known ? String(listed) : 'unknown', mark: !known ? '?' : negative ? '−' : listed ? '✓' : '–',
    className: listed ? `check${negative ? ' negative' : ''}` : 'dash' };
}
