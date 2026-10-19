import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { sha256 } from './sources.mjs';

export async function createFixture(directory) {
  const dataDirectory = resolve(directory, 'data');
  await mkdir(dataDirectory, { recursive: true });
  const apps = {
    10: { steam_appid: 10, type: 'game', name: 'Fixture: full support', categories: [2, 22, 23, 28, 55, 56, 64], genres: [1], release_date: { coming_soon: false, date: '1 Jan, 2020' } },
    20: { steam_appid: 20, type: 'game', name: 'Fixture: no Cloud badge', categories: [2, 22], genres: [1], release_date: { coming_soon: false, date: '2 Jan, 2020' } },
    30: { steam_appid: 30, type: 'game', name: 'Fixture: early access', categories: [1, 2, 22], genres: [70, 1], release_date: { coming_soon: false, date: '3 Jan, 2020' } },
    40: { steam_appid: 40, type: 'game', name: 'Fixture: upcoming', categories: [2], genres: [1], release_date: { coming_soon: true, date: 'Coming soon' } },
    50: { steam_appid: 50, type: 'game', name: 'Fixture: unknown data', categories: [], genres: [] },
    60: { steam_appid: 60, type: 'dlc', name: 'Fixture: excluded DLC', categories: [2], genres: [1] }
  };
  apps[10].developers = ['Valve']; apps[10].publishers = ['Valve'];
  apps[20].developers = ['Alpha & Co', 'Second Studio']; apps[20].publishers = ['Other Publisher'];
  const reviews = [
    { steam_appid: 10, steam_reviews_count: 20, steam_reviews_percent: 80, tags: ['Co-op', ' Action ', 'Action'] },
    { steam_appid: 20, steam_reviews_count: 1001, steam_reviews_percent: 90, tags: ['Puzzle', 'Action'] },
    { steam_appid: 30, steam_reviews_count: 1000, steam_reviews_percent: 70, tags: ['MMORPG'] },
    { steam_appid: 40, steam_reviews_count: 0, steam_reviews_percent: null, tags: null },
    { steam_appid: 50, steam_reviews_count: null, steam_reviews_percent: null },
    { steam_appid: 60, steam_reviews_count: 10, tags: ['DLC-only tag'] }
  ];
  await writeFile(resolve(dataDirectory, '0'), JSON.stringify(apps));
  await writeFile(resolve(dataDirectory, 'categories'), '[]');
  await writeFile(resolve(dataDirectory, 'genres'), '1\tAction\n70\tEarly Access\n');
  const reviewsFile = resolve(directory, 'reviews.json.gz');
  const bytes = gzipSync(JSON.stringify(reviews));
  await writeFile(reviewsFile, bytes);
  const license = 'Synthetic validation fixture. Not a real Steam catalog.\n';
  await writeFile(resolve(directory, 'LICENSE'), license);
  const reviewLicenseFile = resolve(directory, 'reviews.LICENSE');
  await writeFile(reviewLicenseFile, license);
  return { blueboxDirectory: directory, reviewsFile, reviewLicenseFile, sources: { apps: { repository: 'fixture', revision: 'fixture', publishedAt: '2026-01-01T00:00:00Z', license: 'fixture' }, reviews: { repository: 'fixture', revision: 'fixture', release: 'fixture', sha256: sha256(bytes), publishedAt: '2026-01-01T00:00:00Z', license: 'fixture' } } };
}
