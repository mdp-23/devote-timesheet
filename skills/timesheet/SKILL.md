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

## 1. Check the setup

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/timesheet.mjs" doctor`, then `whoami`.

If `node` is not found, stop: they need Node from nodejs.org (the LTS installer), then a
restart of the Claude app.

Anything missing is set up now, in this order. Do each part yourself and leave them only the
clicks macOS or ClickUp insists on. On the first run this is the whole job: once it is set
up, say tracking starts now and the first timesheet is at the end of tomorrow, and stop.

1. **ActivityWatch** (`activitywatch` not reachable). If it is installed, run
   `open -a ActivityWatch`. If not, run `brew install --cask activitywatch` when Homebrew is
   there (`which brew`), then `open -a ActivityWatch`. Without Homebrew, give them
   https://activitywatch.net/downloads/ to download and drag into Applications, then open it.
   Run doctor again after 10 seconds.
2. **Window titles** (`windowTitles` says none have a title): macOS asks to allow
   ActivityWatch under System Settings, Privacy & Security, Accessibility. That click is theirs.
3. **Browser** (`browserTracker` missing): open
   https://chromewebstore.google.com/detail/activitywatch-web-watcher/nglaklhklhcoonedhgnpgddginnjdadi
   in their Chrome with Claude in Chrome if it is connected; they click "Add to Chrome". Without
   it browser time comes from window titles, which still works, less accurately.
4. **Their own ClickUp token** (`token: false`). Required: the team shares one Claude
   account, so the ClickUp connector logs time as whoever connected it, not as this person.
   Never log or read their time through the connector. The token is theirs and lives only on
   this Mac.
   - In their Chrome (Claude in Chrome), open https://app.clickup.com/settings/apps, click
     **Create token**, describe it as "Devote Timesheet", leave expiry on Never and click
     Create token. ClickUp then asks for their ClickUp password: that is theirs to type. If
     they sign in with Google and have no ClickUp password, they use "Forgot Password?" there
     to set one.
   - Do not screenshot or read the page once the token is showing.
   - Start the paste step in a Terminal panel tab with `run_in_terminal` when that tool is
     there, otherwise give the command to run in the Terminal app, with the real path:

     ```bash
     node "<real path of timesheet.mjs>" setup-token
     ```

     They copy the token from ClickUp and paste it there. Never ask for it in the chat.
   - Run `whoami` again. It must show their name. If it shows someone else, stop: the
     token belongs to another person.
5. **A daily reminder**, once: if the scheduled-tasks tool is available and has no
   timesheet task, offer one at 4:45pm on weekdays that runs `/devote-timesheet:timesheet`.

If ActivityWatch has no data for the day (it was not running), say so plainly: the timesheet
then only has Claude sessions and meetings, and time spent elsewhere is missing, not zero.

## 2. Who Is Logging

Every ClickUp read and write below goes through the script with their token, as `username`
from `whoami`. Use the person's first name from it when talking to them.

## 3. Get their meetings

Work out the date (default today, in their timezone). The Calendar connector is also shared,
so read it only if its primary calendar id is the `email` from `whoami`. Keep events they
accepted or organised that have at least one other attendee or a video link. Skip all-day
events, declined events, "Focus time" and "Busy" blocks. Write them to a scratch file as
`[{"start": "<ISO with offset>", "end": "<ISO with offset>", "title": "..."}]`.

If the calendar is not theirs, skip this step and say meetings come from ActivityWatch only
(a Meet or Zoom window in front), so in-person meetings need adding by hand.

## 4. Build the day

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/timesheet.mjs" day --date YYYY-MM-DD [--meetings <file>]
```

`sources` has one entry per computer. If they use two computers with sharing on
(`share-on`), the other computer's day is merged in from its last export, and its entry says
when that was. Say in one line if the other computer's export is older than an hour, or
missing ("could not check"), since its time after that is not in the table.

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
`timesheet.mjs logged --date YYYY-MM-DD`.

## 5. Match to ClickUp tasks

Get the tasks to match against:

- Their open tasks: `timesheet.mjs tasks`.
- The tasks they logged time on in the last 14 days: `timesheet.mjs logged --from <date 14
  days back> --date <date>`.
  People often log to recurring tasks they are not assigned to ("Emails", an ad hoc task for
  a client), and these are the best guide to where they usually put time.
- If a client's work still has no task, search that client's open tasks with
  `clickup_search` (a read of the workspace, so the connector is fine here) and offer the
  best one as a suggestion, marked as such in the table.

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

Write `[{"taskId", "start": "YYYY-MM-DD HH:MM", "minutes", "description"}]` to a scratch
file and run `timesheet.mjs post --file <file>`. Never use `clickup_add_time_entry`: on the
shared account it logs the time as someone else.

Report in one line: how many entries and how much time were logged, as whom. If any failed,
name them and why.

## Rules

- Window titles, URLs and prompts never leave this chat. ClickUp only gets the task, the
  time, the start and the one-line description.
- Never log anything they have not approved.
- If a source could not be read, say "could not check", never treat it as no time.
- The times are an estimate of attention, so say "about" if they ask how exact it is.
