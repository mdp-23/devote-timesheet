# Devote Timesheet

At the end of the day, type `/devote-timesheet:timesheet` in the Code tab of the Claude
desktop app. Claude builds your day from what you actually worked on, matches it to your
ClickUp tasks, shows you a table, and logs only what you approve.

## What It Looks At

- **ActivityWatch**, a free time tracker that runs on your computer. It notes which app and
  browser tab is in front and whether you are at the keyboard. Idle time is left out.
- **Your Claude Code sessions**: when you prompted each one. The time spent reading and
  reviewing before a prompt counts toward that session's task.
- **Your calendar meetings**, when the calendar connected to Claude is yours.

All of this stays on your computer. ClickUp only gets the task, the time and a one-line
description. Personal browsing is never listed or logged.

## Setting It Up (Once per Computer)

You need Node on your Mac (the LTS installer from nodejs.org). Then in the Code tab of the
Claude desktop app, run these one at a time:

```
/plugin marketplace add mdp-23/devote-timesheet
/plugin install devote-timesheet@devote-timesheet
```

Quit Claude (Cmd+Q), reopen it, and type `/devote-timesheet:timesheet`. The first time, Claude
sets everything up with you: it installs ActivityWatch, opens the Chrome extension and makes
your ClickUp token in your own Chrome. Your parts are:

- Allowing ActivityWatch when macOS asks (System Settings, Privacy & Security, Accessibility).
- Clicking "Add to Chrome" on the extension.
- Typing your ClickUp password when ClickUp asks, then copying the new token into the Terminal
  tab Claude opens. Signed in with Google and have no ClickUp password? Use "Forgot Password?"
  on that screen to set one.

### Why Your Own Token

The team shares one Claude account, so the ClickUp connector in Claude logs time as whoever
connected it. Your token is tied to your ClickUp account and saved only on your Mac, so your
time is always logged as you. Claude never sees it.

## Two Computers

If you work on two Macs, set both up as above, then on each one run this once in the Terminal
app:

```bash
node ~/.claude/plugins/cache/devote-timesheet/devote-timesheet/*/scripts/timesheet.mjs share-on
```

Each Mac then saves its day to a `devote-timesheet` folder in your iCloud Drive, every 15
minutes while you use Claude, and the timesheet on either Mac includes both. If both Macs are
in use at the same minute, that minute is only counted once.

## How the Time Is Worked Out

- Each minute you are active goes to whatever was in front of you.
- Minutes in the Claude app go to the session you prompted next, since that is the reading
  and reviewing that led to the prompt. Minutes after your last prompt go to the session you
  last prompted, for up to 15 minutes.
- Meetings count in full, even if you were away from the keyboard.
- Each task's total is rounded to the nearest 5 minutes.

It is an estimate of where your attention went. Fix anything that looks wrong in the table
before you approve it.
