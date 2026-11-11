import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDay, isHumanPrompt, promptText, webKey, splitClaudeTime, clickupTaskIds, clipOverlaps } from '../scripts/lib.mjs';

const T = (h, m = 0) => Date.UTC(2026, 10, 11, h, m);
const mins = (day, key) => (day.items.find(i => i.key === key) || { minutes: 0 }).minutes;

test('time before a prompt goes to the session that prompt went to', () => {
  const day = buildDay({
    win: [{ start: T(9), end: T(9, 30), app: 'Claude', title: 'Claude' }],
    prompts: [{ t: T(9, 10), session: 'A' }, { t: T(9, 25), session: 'B' }],
  });
  assert.equal(mins(day, 'claude:A'), 10);
  assert.equal(mins(day, 'claude:B'), 15 + 5); // 15 before its prompt, 5 reading after it
});

test('Claude time with no prompt nearby is unmatched, not given to an old session', () => {
  const pieces = splitClaudeTime({ start: T(11), end: T(11, 10) }, [{ t: T(9), session: 'A' }]);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].session, null);
});

test('meetings take precedence over the focused window and count even when idle', () => {
  const day = buildDay({
    win: [{ start: T(10), end: T(11), app: 'Figma', title: 'Client homepage' }],
    meetings: [{ start: T(10, 30), end: T(11, 30), title: 'WIP' }],
  });
  assert.equal(mins(day, 'app:Figma'), 30);
  assert.equal(day.totals.meetingMinutes, 60);
  assert.equal(day.totals.activeMinutes, 30);
});

test('browser time is split by the active tab, and incognito tabs are left out', () => {
  const day = buildDay({
    win: [{ start: T(13), end: T(13, 30), app: 'Google Chrome', title: 'x' }],
    web: [
      { start: T(13), end: T(13, 20), url: 'https://admin.shopify.com/store/acme-au/products?x=1', title: 'Products' },
      { start: T(13, 20), end: T(13, 25), url: 'https://example.com/', title: 'Private', incognito: true },
    ],
  });
  assert.equal(mins(day, 'web:admin.shopify.com/store/acme-au'), 20);
  assert.equal(mins(day, 'web:example.com'), 0);
  assert.equal(mins(day, 'app:Google Chrome'), 10); // no tab record, so it falls back to the window
});

test('a prompt sent from a terminal claims the time before it', () => {
  const day = buildDay({
    win: [{ start: T(14), end: T(14, 20), app: 'Terminal', title: 'zsh' }],
    prompts: [{ t: T(14, 15), session: 'C' }],
  });
  assert.equal(mins(day, 'claude:C'), 15);
  assert.equal(mins(day, 'app:Terminal'), 5);
});

test('only prompts the person typed count', () => {
  assert.equal(isHumanPrompt({ type: 'user', origin: { kind: 'human' }, message: { content: 'hi' } }), true);
  assert.equal(isHumanPrompt({ type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification>' } }), false);
  assert.equal(isHumanPrompt({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }), false);
  assert.equal(isHumanPrompt({ type: 'user', isMeta: true, message: { content: 'x' } }), false);
  assert.equal(isHumanPrompt({ type: 'user', message: { content: 'This session is being continued from a previous conversation' } }), false);
  assert.equal(isHumanPrompt({ type: 'user', message: { content: 'Fix the header' } }), true);
});

test('prompt text drops the context blocks the app adds', () => {
  const d = { message: { content: '<artifact-view-context a="1">{"x":1}</artifact-view-context> Make the logo bigger' } };
  assert.equal(promptText(d), 'Make the logo bigger');
});

test('two computers active at once are not counted twice', () => {
  const merged = clipOverlaps([
    { start: T(9), end: T(10), app: 'Figma', title: 'a' },
    { start: T(9, 30), end: T(10, 30), app: 'Zen', title: 'b' },
    { start: T(9, 40), end: T(9, 50), app: 'Mail', title: 'c' },
  ]);
  const total = merged.reduce((n, e) => n + (e.end - e.start), 0) / 60000;
  assert.equal(total, 90);
});

test('a prompt on one computer does not claim time on the other', () => {
  const day = buildDay({
    win: [{ start: T(15), end: T(15, 30), app: 'Figma', title: 'x', host: 'air' }],
    prompts: [{ t: T(15, 5), session: 'MINI', host: 'mini' }, { t: T(15, 20), session: 'AIR', host: 'air' }],
  });
  assert.equal(mins(day, 'claude:MINI'), 0);
  assert.equal(mins(day, 'claude:AIR'), 20);
  assert.equal(mins(day, 'app:Figma'), 10);
});

test('ClickUp task links in a prompt are picked up', () => {
  assert.deepEqual(clickupTaskIds('see https://app.clickup.com/t/86d33xm6u and app.clickup.com/t/9012/14ypaj0rwcd'), ['86d33xm6u', '14ypaj0rwcd']);
});

test('web keys group by site, and by store for Shopify admin', () => {
  assert.equal(webKey('https://www.canva.com/design/abc/edit'), 'canva.com');
  assert.equal(webKey('https://admin.shopify.com/store/brand-x/themes'), 'admin.shopify.com/store/brand-x');
});
