#!/usr/bin/env node
// Devote timesheet: builds a person's day from ActivityWatch, Claude Code sessions and their
// meetings, then logs the approved time to ClickUp.
//
//   node timesheet.mjs doctor
//   node timesheet.mjs day [--date YYYY-MM-DD] [--meetings meetings.json]
//   node timesheet.mjs setup-token            (paste a ClickUp personal token; never shown)
//   node timesheet.mjs whoami
//   node timesheet.mjs tasks
//   node timesheet.mjs logged [--date YYYY-MM-DD]
//   node timesheet.mjs post --file entries.json [--dry-run]
//
// Everything it reads stays on this machine. Only the approved entries go to ClickUp.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { buildDay, isHumanPrompt, promptText, clickupTaskIds } from './lib.mjs';

const AW = process.env.AW_URL || 'http://127.0.0.1:5600'; // localhost can resolve to IPv6, which aw-server does not listen on
const CLICKUP = 'https://api.clickup.com/api/v2';
const CONFIG = path.join(os.homedir(), '.config', 'devote-timesheet', 'config.json');

const args = process.argv.slice(2);
const cmd = args[0];
const opt = name => { const i = args.indexOf(`--${name}`); return i > -1 ? args[i + 1] : undefined; };
const flag = name => args.includes(`--${name}`);
const out = obj => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
const fail = (msg, extra = {}) => { out({ ok: false, error: msg, ...extra }); process.exit(1); };

// ---------- dates ----------

function localDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dayBounds(date) {
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}
function iso(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const p = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${localDate(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`;
}
const hm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// ---------- ActivityWatch ----------

async function awJson(p, init) {
  const r = await fetch(AW + p, { ...init, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`ActivityWatch ${p} returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function awBuckets() {
  const b = await awJson('/api/0/buckets/');
  const ids = Object.keys(b);
  const host = os.hostname();
  const pick = prefix => ids.filter(id => id.startsWith(prefix)).sort((a, z) => (z.includes(host) - a.includes(host)))[0];
  return {
    window: pick('aw-watcher-window'),
    afk: pick('aw-watcher-afk'),
    web: ids.filter(id => id.startsWith('aw-watcher-web')),
  };
}

async function awDay(start, end) {
  const buckets = await awBuckets();
  if (!buckets.window || !buckets.afk) throw new Error('ActivityWatch is running but has no window or idle tracker yet');
  const q = [
    `afk = flood(query_bucket("${buckets.afk}"));`,
    `notafk = filter_keyvals(afk, "status", ["not-afk"]);`,
    `win = flood(query_bucket("${buckets.window}"));`,
    `win = filter_period_intersect(win, notafk);`,
    ...buckets.web.map((b, i) => `web${i} = flood(query_bucket("${b}"));`),
    `RETURN = {"win": win${buckets.web.map((_, i) => `, "web${i}": web${i}`).join('')}};`,
  ];
  const res = await awJson('/api/0/query/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ timeperiods: [`${iso(start)}/${iso(end)}`], query: q }),
  });
  const r = res[0] || {};
  const toIv = e => { const s = Date.parse(e.timestamp); return { start: s, end: s + e.duration * 1000, ...e.data }; };
  const win = (r.win || []).map(toIv);
  const web = buckets.web.flatMap((_, i) => (r[`web${i}`] || []).map(toIv));
  return { win, web, buckets };
}

// ---------- Claude Code sessions ----------

function claudeRoots() {
  const roots = [path.join(os.homedir(), '.claude', 'projects')];
  if (process.env.CLAUDE_CONFIG_DIR) roots.unshift(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
  return roots.filter(r => fs.existsSync(r));
}

// The desktop app keeps a title per session; the CLI does not. Optional.
function desktopTitles() {
  const dirs = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'Claude', 'claude-code-sessions'),
  ].filter(d => d && fs.existsSync(d));
  const titles = new Map();
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) {
        try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (j.cliSessionId && j.title) titles.set(j.cliSessionId, j.title); } catch {}
      }
    }
  };
  dirs.forEach(walk);
  return titles;
}

async function claudeDay(start, end) {
  const prompts = [];
  const sessions = new Map();
  for (const root of claudeRoots()) {
    for (const proj of fs.readdirSync(root)) {
      const dir = path.join(root, proj);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(dir, f);
        if (fs.statSync(file).mtimeMs < start) continue;
        const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.includes('"type":"user"')) continue;
          let d; try { d = JSON.parse(line); } catch { continue; }
          const t = Date.parse(d.timestamp);
          if (!(t >= start && t < end) || !isHumanPrompt(d)) continue;
          const id = d.sessionId;
          prompts.push({ t, session: id });
          let s = sessions.get(id);
          if (!s) { s = { id, folder: d.cwd, branch: d.gitBranch, prompts: [], clickupTaskIds: [] }; sessions.set(id, s); }
          s.prompts.push({ at: hm(t), text: promptText(d) });
          for (const tid of clickupTaskIds(line)) if (!s.clickupTaskIds.includes(tid)) s.clickupTaskIds.push(tid);
        }
      }
    }
  }
  const titles = desktopTitles();
  for (const s of sessions.values()) s.title = titles.get(s.id) || null;
  return { prompts, sessions };
}

// ---------- commands ----------

async function doctor() {
  const report = { activitywatch: null, windowTracker: null, idleTracker: null, browserTracker: null, claudeSessions: null, clickupToken: null };
  try {
    const b = await awBuckets();
    report.activitywatch = 'running';
    report.windowTracker = b.window ? 'ok' : 'missing';
    report.idleTracker = b.afk ? 'ok' : 'missing';
    report.browserTracker = b.web.length ? `ok (${b.web.join(', ')})` : 'missing: install the ActivityWatch Web Watcher extension in Chrome, or browser time only shows page titles';
    if (b.window) {
      const ev = await awJson(`/api/0/buckets/${encodeURIComponent(b.window)}/events?limit=50`);
      const titled = ev.filter(e => e.data.title).length;
      report.windowTitles = ev.length ? `${titled} of the last ${ev.length} window events have a title${titled ? '' : ': grant ActivityWatch Accessibility access in System Settings'}` : 'no events yet';
    }
  } catch (e) { report.activitywatch = `not reachable at ${AW} (${e.message}). Open the ActivityWatch app.`; }
  const roots = claudeRoots();
  report.claudeSessions = roots.length ? `ok (${roots.join(', ')})` : 'no Claude Code sessions found on this machine';
  const cfg = readConfig();
  report.clickupToken = cfg ? `set, logs as ${cfg.username}` : 'not set: entries go through the ClickUp connector instead';
  out(report);
}

async function day() {
  const date = opt('date') || localDate();
  const { start, end } = dayBounds(date);
  const sources = {};
  let win = [], web = [];
  try {
    const aw = await awDay(start, end);
    win = aw.win; web = aw.web;
    sources.activitywatch = win.length
      ? `ok, ${win.length} window events, ${web.length} browser tab events${aw.buckets.web.length ? '' : ' (no browser extension, so browser time uses page titles)'}`
      : 'no data: ActivityWatch has nothing for this day (not running, or idle all day), so time outside Claude sessions and meetings is missing, not zero';
  } catch (e) {
    sources.activitywatch = `could not check: ${e.message}`;
  }
  const { prompts, sessions } = await claudeDay(start, end);
  sources.claude = `ok, ${prompts.length} prompts across ${sessions.size} sessions`;

  let meetings = [];
  const mf = opt('meetings');
  if (mf) {
    const raw = JSON.parse(fs.readFileSync(mf, 'utf8'));
    meetings = raw.map(m => ({ start: Date.parse(m.start), end: Date.parse(m.end), title: m.title }))
      .filter(m => m.end > m.start)
      .map(m => ({ ...m, start: Math.max(m.start, start), end: Math.min(m.end, end) }));
    sources.meetings = `ok, ${meetings.length} meetings`;
  } else sources.meetings = 'not given';

  const result = buildDay({ win, web, prompts, meetings });
  const items = result.items.map(it => {
    const base = { ...it, first: hm(it.first), last: hm(it.last) };
    if (it.kind === 'claude' && it.key !== 'claude:unmatched') {
      const s = sessions.get(it.key.slice(7));
      if (s) Object.assign(base, { title: s.title, folder: s.folder, branch: s.branch, clickupTaskIds: s.clickupTaskIds, prompts: s.prompts.slice(0, 6), promptCount: s.prompts.length });
    }
    return base;
  });
  // Sessions prompted while ActivityWatch saw nothing (it was off, or idle) still show, with 0 minutes.
  const seen = new Set(items.map(i => i.key));
  const unseen = [...sessions.values()].filter(s => !seen.has(`claude:${s.id}`))
    .map(s => ({ key: `claude:${s.id}`, kind: 'claude', minutes: 0, title: s.title, folder: s.folder, clickupTaskIds: s.clickupTaskIds, prompts: s.prompts.slice(0, 6), promptCount: s.prompts.length }));

  out({ ok: true, date, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, sources, totals: result.totals, items: [...items, ...unseen] });
}

function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return null; } }

async function clickup(p, init = {}) {
  const cfg = readConfig();
  if (!cfg) fail('No ClickUp token set. Run: node timesheet.mjs setup-token');
  const r = await fetch(CLICKUP + p, { ...init, headers: { Authorization: cfg.token, 'content-type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  const body = await r.text();
  if (!r.ok) throw new Error(`ClickUp ${p} returned ${r.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

async function setupToken() {
  process.stdout.write('Paste your ClickUp personal API token (ClickUp > avatar > Settings > Apps > API Token), then press Return: ');
  const token = await new Promise(res => {
    const stdin = process.stdin;
    let buf = '';
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume(); stdin.setEncoding('utf8');
    stdin.on('data', ch => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { if (stdin.isTTY) stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); return res(buf.trim()); }
        if (c === '\u0003') process.exit(1);
        if (c === '\u007f') buf = buf.slice(0, -1); else buf += c;
      }
    });
  });
  if (!/^pk_/.test(token)) fail('That does not look like a ClickUp personal token (they start with pk_).');
  const r = await fetch(CLICKUP + '/user', { headers: { Authorization: token } });
  if (!r.ok) fail(`ClickUp rejected the token (${r.status}).`);
  const { user } = await r.json();
  const teams = await (await fetch(CLICKUP + '/team', { headers: { Authorization: token } })).json();
  const team = (teams.teams || [])[0];
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ token, userId: user.id, username: user.username, email: user.email, teamId: team && team.id }, null, 2), { mode: 0o600 });
  out({ ok: true, loggedInAs: user.username, workspace: team && team.name });
}

async function whoami() {
  const cfg = readConfig();
  if (!cfg) return out({ ok: true, token: false });
  out({ ok: true, token: true, username: cfg.username, email: cfg.email, userId: cfg.userId, teamId: cfg.teamId });
}

async function tasks() {
  const cfg = readConfig();
  const all = [];
  for (let page = 0; page < 10; page++) {
    const r = await clickup(`/team/${cfg.teamId}/task?assignees[]=${cfg.userId}&include_closed=false&subtasks=true&page=${page}`);
    for (const t of r.tasks || []) all.push({ id: t.id, name: t.name, status: t.status && t.status.status, list: t.list && t.list.name, folder: t.folder && t.folder.name, space: t.space && t.space.id, url: t.url });
    if (r.last_page !== false && (!r.tasks || r.tasks.length < 100)) break;
  }
  out({ ok: true, count: all.length, tasks: all });
}

async function logged() {
  const cfg = readConfig();
  const date = opt('date') || localDate();
  const from = opt('from') || date;
  const start = dayBounds(from).start, end = dayBounds(date).end;
  const r = await clickup(`/team/${cfg.teamId}/time_entries?start_date=${start}&end_date=${end}`);
  out({ ok: true, from, to: date, entries: (r.data || []).map(e => ({ id: e.id, task: e.task && e.task.name, taskId: e.task && e.task.id, date: localDate(new Date(+e.start)), start: hm(+e.start), minutes: Math.round(+e.duration / 60000), description: e.description })) });
}

// entries.json: [{taskId, start: "YYYY-MM-DD HH:MM", minutes, description}]
async function post() {
  const file = opt('file');
  if (!file) fail('Give --file entries.json');
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = readConfig();
  const results = [];
  for (const e of entries) {
    const [d, t] = e.start.split(' ');
    const [y, mo, da] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number);
    const startMs = new Date(y, mo - 1, da, h, mi).getTime();
    const body = { tid: e.taskId, start: startMs, duration: Math.round(e.minutes * 60000), description: e.description || '', billable: !!e.billable };
    if (flag('dry-run')) { results.push({ dryRun: true, ...e }); continue; }
    try {
      const r = await clickup(`/team/${cfg.teamId}/time_entries`, { method: 'POST', body: JSON.stringify(body) });
      results.push({ ok: true, taskId: e.taskId, minutes: e.minutes, entryId: r.data && r.data.id });
    } catch (err) { results.push({ ok: false, taskId: e.taskId, error: err.message }); }
  }
  out({ ok: results.every(r => r.ok !== false), loggedAs: cfg && cfg.username, results });
}

const commands = { doctor, day, 'setup-token': setupToken, whoami, tasks, logged, post };
if (!commands[cmd]) {
  process.stdout.write('Commands: doctor, day [--date YYYY-MM-DD] [--meetings file], setup-token, whoami, tasks, logged [--date], post --file entries.json [--dry-run]\n');
  process.exit(cmd ? 1 : 0);
}
commands[cmd]().catch(e => fail(e.message));
