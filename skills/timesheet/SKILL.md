---
name: timesheet
description: Build the person's timesheet for the day from what they actually did on their computer (ActivityWatch), their Claude Code sessions and their meetings, match it to their ClickUp tasks, and log the time they approve. Use when someone says "do my timesheet", "log my time", "timesheet", "sync my time to ClickUp", "what did I work on today", or types /devote-timesheet:timesheet. Takes an optional date ("yesterday", "Monday", 2026-11-10).
allowed-tools: Bash, Read, Write
---

# Timesheet

The script is `${CLAUDE_PLUGIN_ROOT}/scripts/timesheet.mjs`. Run it with `node`. Everything it
reads stays on this computer. Nothing goes to ClickUp until the person approves the table.

Keep it quick: the person wants their time logged, not a report. One line while you work
("Building your day from ActivityWatch and your Claude sessions."), then the table.

## 1. Check the trackers

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/timesheet.mjs" doctor`.

- `activitywatch` not reachable: on a Mac run `open -a ActivityWatch`, wait 10 seconds, run
  doctor again. If ActivityWatch is not installed, stop and give them this, to run once in the
  Terminal app, then open ActivityWatch from Applications:

  ```bash
  brew install --cask activitywatch
  ```

  Without Homebrew, it is a download from activitywatch.net.

  On the first run of the day, also tell them it only knows about time from when it was first
  opened, so a day it was not running is missing, not empty.
- `windowTitles` says none have a title: they need to allow ActivityWatch in System Settings,
  Privacy & Security, Accessibility. Say that in one line; it still works without titles, less
  accurately.
- `browserTracker` missing: say once that installing the "ActivityWatch Web Watcher" extension
  in Chrome (https://chromewebstore.google.com/detail/activitywatch-web-watcher/nglaklhklhcoonedhgnpgddginnjdadi) makes browser time far more accurate. Carry on without it.

If ActivityWatch has no data for the day (it was not running), say so plainly: the timesheet
then only has Claude sessions and meetings, and time spent elsewhere is missing, not zero.

## 2. Work out who is logging

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/timesheet.mjs" whoami`.

- `token: true`: entries are logged with their own ClickUp token, as `username`. Use the
  script for tasks, logged and post below.
- `token: false`: the ClickUp connector may be signed in as someone else (the team shares a
  Claude account). Call `clickup_get_user`. If that is clearly not the person you are working
  with, or you cannot tell, ask them once: "This will log time as <name>. Is that you?" If not,
  give them the one-time setup, to run in the Terminal app (it asks for their ClickUp token,
  from ClickUp, avatar, Settings, Apps, API Token, and never shows it to Claude):

  ```bash
  node "<the real path of timesheet.mjs>" setup-token
  ```

  Print the command with the real path filled in. Then stop until they say it is done.

Never ask them to paste the token into the chat.

## 3. Get their meetings

Work out the date (default today, in their timezone). Read their calendar for that day with
the Google Calendar connector, only if the connected calendar is theirs (its primary
calendar id is their email). Keep events they accepted or organised that have at least one
other attendee or a video link. Skip all-day events, declined events, "Focus time" and
"Busy" blocks. Write them to a scratch file as
`[{"start": "<ISO with offset>", "end": "<ISO with offset>", "title": "..."}]`.

If the calendar connector is not theirs, skip this step and say meetings come from
ActivityWatch only (a Meet or Zoom window in front), so in-person meetings need adding by hand.

## 4. Build the day

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/timesheet.mjs" day --date YYYY-MM-DD [--meetings <file>]
```

It returns `items`, each a block of their active time (idle time is already removed):

- `claude:<id>`: time in a Claude Code session, with its title, folder, prompts and any
  ClickUp task ids pasted into it. The minutes are the reading, reviewing and prompting
  before each prompt they sent there. Sessions with 0 minutes were prompted while
  ActivityWatch saw nothing.
- `web:<site>`: time on a website, with the page titles and minutes on each.
- `app:<app>`: time in another app (Figma, Photoshop, Mail), with window titles.
- `meeting:<title>`: a calendar meeting, counted in full.
- `claude:unmatched`: time in the Claude app with no Code prompt nearby. Usually a chat in
  claude.ai, which this cannot see into. Ask what it was for if it is over 10 minutes.

Also get what they already logged that day, so nothing is counted twice:
`timesheet.mjs logged --date YYYY-MM-DD` (token) or `clickup_get_time_entries` for the day
(connector, only once you know it is them).

## 5. Match to ClickUp tasks

Get the tasks to match against:

- Their open tasks: `timesheet.mjs tasks` (token) or `clickup_filter_tasks` with
  `assignees: ["me"]` (connector, all pages).
- The tasks they logged time on in the last 14 days: `timesheet.mjs logged --from <date 14
  days back> --date <date>` (token) or `clickup_get_time_entries` for that range (connector).
  People often log to recurring tasks they are not assigned to ("Emails", an ad hoc task for
  a client), and these are the best guide to where they usually put time.
- If a client's work still has no task, search that client's open tasks with
  `clickup_search` and offer the best one as a suggestion, marked as such in the table.

Match each item to one task, using:

1. A ClickUp task id in the session (`clickupTaskIds`): exact match.
2. The client or brand named in the session title, folder, prompts, page titles, the Shopify
   store in `admin.shopify.com/store/<store>`, the Canva or Figma file name, the Klaviyo
   account, or the meeting title. Then the task for that client that fits the work best (an
   EDM task for email work, a BFCM task for BFCM assets). Use the task's list and folder to
   tell clients apart.
3. Several items can go to one task. One item that clearly covers two tasks can be split
   by its page titles.

Leave unmatched what you cannot place with confidence. Do not guess.

Not work (personal sites, social feeds that are not a client's page, streaming, shopping):
put it in "Not logged" as a single total with no detail. Never list which personal sites
they visited, and never log it.

Small bits under 3 minutes that do not match anything go into "Not logged" as well.

## 6. Show the table

Round each task's total to the nearest 5 minutes (5 minutes minimum). Take off anything they
already logged on that task for the day. Start time is when they first worked on it.

```
**Your Day, Wed 11 Nov** (6h 40m active, 1h 30m in meetings, 25m already logged)

| Task | Time | From | What |
|---|---|---|---|
| [Acme: BFCM Launch EDM](https://app.clickup.com/t/...) | 1h 15m | 09:10 | Built the EDM in Claude, edits in Klaviyo |
| ... |

**Not matched**, 35m: Canva "Summer v3" (20m), Claude chat (15m)
**Not logged**, 40m: personal and small bits
```

Link every task. "What" is one plain line a client could read: what was done, not the sites
visited. Then ask them to approve, change a time, move a row to another task, or tell you
what the not-matched time was for. Apply their changes and show the table again only if
they changed something big.

## 7. Log it

Only after they say yes.

- Token: write `[{"taskId", "start": "YYYY-MM-DD HH:MM", "minutes", "description"}]` to a
  scratch file and run `timesheet.mjs post --file <file>`.
- Connector: `clickup_add_time_entry` per row, with `task_id`, `start`, `duration` like
  "1h 15m", and the "What" line as `description`.

Report in one line: how many entries and how much time were logged, as whom. If any failed,
name them and why.

## Rules

- Window titles, URLs and prompts never leave this chat. ClickUp only gets the task, the
  time, the start and the one-line description.
- Never log anything they have not approved.
- If a source could not be read, say "could not check", never treat it as no time.
- The times are an estimate of attention, so say "about" if they ask how exact it is.
