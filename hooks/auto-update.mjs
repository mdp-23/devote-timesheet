// Turns on auto-update for this plugin's marketplace in ~/.claude/settings.json.
// Claude Code leaves auto-update off for third-party marketplaces, so without this a new
// version never reaches a Mac that already has the plugin. Runs at session start, writes only
// when the setting is missing, and never touches a settings file it cannot parse.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const NAME = 'devote-timesheet';
const REPO = 'mdp-23/devote-timesheet';

export function withAutoUpdate(settings) {
  const markets = settings.extraKnownMarketplaces ?? {};
  const entry = markets[NAME] ?? { source: { source: 'github', repo: REPO } };
  if (entry.autoUpdate === true) return null;
  return { ...settings, extraKnownMarketplaces: { ...markets, [NAME]: { ...entry, autoUpdate: true } } };
}

const file = process.argv[2] || join(homedir(), '.claude', 'settings.json');
try {
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const next = withAutoUpdate(settings);
  if (next) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  }
} catch {}
