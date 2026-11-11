// Pure logic for building a person's day. No network or file access here, so it can be tested.
//
// Inputs are plain intervals in epoch milliseconds:
//   win:      [{start, end, app, title}]          focused window, already cut to not-idle time
//   web:      [{start, end, url, title, incognito}] active browser tab (may be empty)
//   prompts:  [{t, session}]                      every prompt the person sent Claude
//   meetings: [{start, end, title}]               calendar events they attended
//
// Rule for Claude time: the minutes in the Claude app before a prompt belong to the session
// that prompt went to (that is the reading, reviewing and writing). Minutes after the last
// prompt go to the session most recently prompted, if it was within MATCH_WINDOW.

export const MATCH_WINDOW_MS = 15 * 60 * 1000;

const BROWSERS = /^(google chrome|chrome|chromium|arc|brave browser|microsoft edge|msedge|zen|firefox|safari|vivaldi|opera)(\.exe)?$/i;
const CLAUDE_APPS = /^(claude)(\.exe)?$/i;

export function isBrowser(app) { return BROWSERS.test((app || '').trim()); }
export function isClaudeApp(app) { return CLAUDE_APPS.test((app || '').trim()); }

// Overlap of one interval with a sorted list, returned as pieces carrying the list item.
function overlaps(a, list) {
  const out = [];
  for (const b of list) {
    if (b.end <= a.start) continue;
    if (b.start >= a.end) break;
    const s = Math.max(a.start, b.start), e = Math.min(a.end, b.end);
    if (e > s) out.push({ start: s, end: e, item: b });
  }
  return out;
}

// Subtract a sorted list of intervals from one interval.
function subtract(a, list) {
  let pieces = [{ start: a.start, end: a.end }];
  for (const b of list) {
    if (b.end <= a.start || b.start >= a.end) continue;
    const next = [];
    for (const p of pieces) {
      if (b.end <= p.start || b.start >= p.end) { next.push(p); continue; }
      if (b.start > p.start) next.push({ start: p.start, end: b.start });
      if (b.end < p.end) next.push({ start: b.end, end: p.end });
    }
    pieces = next;
  }
  return pieces;
}

const byStart = (x, y) => x.start - y.start;

export function cleanUrl(url) {
  try {
    const u = new URL(url);
    return { domain: u.hostname.replace(/^www\./, ''), path: u.pathname };
  } catch { return { domain: '(unknown site)', path: '' }; }
}

// Shopify admin and a few tools hold the client in the path, not the hostname.
export function webKey(url) {
  const { domain, path } = cleanUrl(url);
  const seg = path.split('/').filter(Boolean);
  if (domain === 'admin.shopify.com' && seg[0] === 'store' && seg[1]) return `admin.shopify.com/store/${seg[1]}`;
  return domain;
}

// Which Claude session a stretch of Claude-app time belongs to.
function sessionFor(pieceEnd, prompts) {
  // First prompt at or after the end of the piece, if it lands within the piece's end (exact split point).
  let before = null;
  for (const p of prompts) {
    if (p.t <= pieceEnd) before = p; else break;
  }
  return before;
}

export function splitClaudeTime(seg, prompts) {
  // Split the segment at each prompt inside it. Each piece goes to the prompt that ends it;
  // the tail after the last prompt goes to the most recent prompt before it.
  const inside = prompts.filter(p => p.t > seg.start && p.t <= seg.end);
  const pieces = [];
  let cursor = seg.start;
  for (const p of inside) {
    if (p.t > cursor) pieces.push({ start: cursor, end: p.t, session: p.session });
    cursor = p.t;
  }
  if (cursor < seg.end) {
    const prev = sessionFor(cursor, prompts);
    const next = prompts.find(p => p.t > seg.end);
    let session = null;
    if (prev && cursor - prev.t <= MATCH_WINDOW_MS) session = prev.session;
    else if (next && next.t - seg.end <= 2 * 60 * 1000) session = next.session;
    pieces.push({ start: cursor, end: seg.end, session });
  }
  return pieces;
}

export function buildDay({ win = [], web = [], prompts = [], meetings = [] }) {
  win = [...win].sort(byStart);
  web = web.filter(w => !w.incognito).sort(byStart);
  prompts = [...prompts].sort((a, b) => a.t - b.t);
  meetings = [...meetings].sort(byStart);

  const segments = []; // {start, end, key, kind, detail, url}

  for (const w of win) {
    // Meetings take precedence over whatever window was in front.
    for (const free of subtract(w, meetings)) {
      const seg = { ...w, start: free.start, end: free.end };
      if (isClaudeApp(seg.app)) {
        for (const p of splitClaudeTime(seg, prompts)) {
          segments.push({ start: p.start, end: p.end, kind: 'claude', key: p.session ? `claude:${p.session}` : 'claude:unmatched', detail: '' });
        }
        continue;
      }
      if (isBrowser(seg.app)) {
        const tabs = overlaps(seg, web);
        let covered = 0;
        for (const t of tabs) {
          covered += t.end - t.start;
          segments.push({ start: t.start, end: t.end, kind: 'web', key: `web:${webKey(t.item.url)}`, detail: t.item.title || '', url: t.item.url });
        }
        // Browser time with no tab record (extension missing): fall back to the window title.
        for (const gap of subtract(seg, tabs.map(t => ({ start: t.start, end: t.end })))) {
          segments.push({ start: gap.start, end: gap.end, kind: 'app', key: `app:${seg.app}`, detail: seg.title || '' });
        }
        continue;
      }
      // A prompt sent from another app (a terminal running Claude Code): time before it counts to that session.
      const inside = prompts.filter(p => p.t > seg.start && p.t <= seg.end);
      if (inside.length) {
        const first = inside[0];
        segments.push({ start: seg.start, end: first.t, kind: 'claude', key: `claude:${first.session}`, detail: '' });
        if (first.t < seg.end) segments.push({ start: first.t, end: seg.end, kind: 'app', key: `app:${seg.app}`, detail: seg.title || '' });
        continue;
      }
      segments.push({ start: seg.start, end: seg.end, kind: 'app', key: `app:${seg.app}`, detail: seg.title || '' });
    }
  }

  for (const m of meetings) {
    segments.push({ start: m.start, end: m.end, kind: 'meeting', key: `meeting:${m.title}|${m.start}`, detail: m.title });
  }

  // Aggregate.
  const groups = new Map();
  for (const s of segments) {
    const ms = s.end - s.start;
    if (ms <= 0) continue;
    let g = groups.get(s.key);
    if (!g) { g = { key: s.key, kind: s.kind, ms: 0, first: s.start, last: s.end, details: new Map() }; groups.set(s.key, g); }
    g.ms += ms;
    g.first = Math.min(g.first, s.start);
    g.last = Math.max(g.last, s.end);
    if (s.detail) {
      const d = g.details.get(s.detail) || { ms: 0, url: s.url };
      d.ms += ms;
      g.details.set(s.detail, d);
    }
  }

  const items = [...groups.values()]
    .map(g => ({
      key: g.key,
      kind: g.kind,
      minutes: round1(g.ms / 60000),
      first: g.first,
      last: g.last,
      details: [...g.details.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8)
        .map(([title, d]) => ({ title, minutes: round1(d.ms / 60000) })),
    }))
    .sort((a, b) => b.minutes - a.minutes);

  const activeMs = segments.filter(s => s.kind !== 'meeting').reduce((n, s) => n + (s.end - s.start), 0);
  const meetingMs = meetings.reduce((n, m) => n + (m.end - m.start), 0);
  return {
    totals: { activeMinutes: round1(activeMs / 60000), meetingMinutes: round1(meetingMs / 60000) },
    items,
  };
}

function round1(n) { return Math.round(n * 10) / 10; }

// Human prompts from Claude Code transcript lines. Tool results, system notices, task
// notifications and messages from other sessions are not the person typing.
export function isHumanPrompt(d) {
  if (d.type !== 'user' || d.isSidechain || d.isMeta) return false;
  const origin = d.origin && typeof d.origin === 'object' ? d.origin.kind : undefined;
  if (origin) return origin === 'human';
  if (d.promptSource && d.promptSource !== 'sdk' && d.promptSource !== 'user') return false;
  const c = d.message && d.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : '';
  if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) return false;
  if (!text.trim()) return Array.isArray(c) && c.some(b => b.type === 'image');
  return !/^\s*<(task-notification|scheduled-task|cross-session-message|agent-message|local-command|command-)/.test(text)
    && !/^This session is being continued/.test(text);
}

// ClickUp task links pasted into a prompt give an exact match.
export function clickupTaskIds(text) {
  const ids = [];
  for (const m of String(text).matchAll(/app\.clickup\.com\/t\/(?:\d+\/)?([A-Za-z0-9-]+)/g)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

export function promptText(d) {
  const c = d.message && d.message.content;
  let text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : '';
  // Drop context blocks the app adds in front of what the person typed.
  text = text.replace(/<([a-z-]+)[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 160);
}
