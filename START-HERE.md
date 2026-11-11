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

1. Install ActivityWatch. In the Terminal app:

   ```bash
   brew install --cask activitywatch
   ```

   Or download it from activitywatch.net. Open it from Applications. It starts itself after
   that.
2. When macOS asks, allow ActivityWatch under System Settings, Privacy & Security,
   Accessibility. Without it, it cannot see window titles.
3. In Chrome, install the [ActivityWatch Web Watcher](https://chromewebstore.google.com/detail/activitywatch-web-watcher/nglaklhklhcoonedhgnpgddginnjdadi) extension.
4. Link your own ClickUp account, so time is logged as you. In ClickUp, click your avatar,
   Settings, Apps, and copy your API token. Then in the Terminal app run the command Claude
   gives you the first time you use `/devote-timesheet:timesheet`, and paste the token when
   it asks. It is saved on your computer only.

## Installing the Plugin

In the Code tab:

```
/plugin marketplace add mdp-23/devote-timesheet
/plugin install devote-timesheet@devote-timesheet
```

Each computer also needs Node (the LTS version from nodejs.org).

## How the Time Is Worked Out

- Each minute you are active goes to whatever was in front of you.
- Minutes in the Claude app go to the session you prompted next, since that is the reading
  and reviewing that led to the prompt. Minutes after your last prompt go to the session you
  last prompted, for up to 15 minutes.
- Meetings count in full, even if you were away from the keyboard.
- Each task's total is rounded to the nearest 5 minutes.

It is an estimate of where your attention went. Fix anything that looks wrong in the table
before you approve it.
