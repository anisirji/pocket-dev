# Pocket Dev content calendar

Open `index.html` directly in Chrome, or click **Pocket Dev Calendar** in the Mac Dock. The launcher is installed at `/Users/ani/Applications/Pocket Dev Calendar.app`.

The calendar is an offline snapshot built from the saved marketing queues. It displays month and agenda views, account and status filters, full captions, original local videos, publisher links, published history, and an export of confirmed schedules to `.ics`. All dates use Asia/Kolkata (IST). Mobile widths open in agenda view.

It currently contains 135 entries: 100 saved schedules, 13 published posts, 19 drafts/proposed slots, and 3 filtered or removed items (two Reddit submissions and one reply). The 18 finished videos are fully covered on YouTube, Facebook, brand Instagram, and LinkedIn. X / @anisirji also covers all 18: two in a published launch and 16 scheduled posts, plus a published community discussion. The second X account is suspended and has no schedules. Four personal-Instagram videos remain drafts awaiting verification; 14 Stories remain prepared only. One Humanizer Reddit draft is retained for review.

The **Questions & replies** view saves question links, authors, fit notes, short drafts, and verified outcomes. It currently tracks 7 questions, 0 live replies, 1 removed reply, and 0 DMs sent. Search or filter the questions, open their original threads, copy a draft, or download the saved log. Research-only questions are kept separate from dated posts. Reply style is saved with the log: brief, casual, specific, and clear that Ani built Pocket Dev.

Published dates missing from the source records are shown in the undated library. Elapsed schedules are never automatically changed to Published. Personal Instagram's existing schedules retain their November 18 verification date. This page does not publish, edit, or synchronize social-platform posts.

To refresh after updating the saved source queues, run:

```bash
python3 /Users/ani/Desktop/pocket-dev/docs/marketing/content-calendar/build.py
```

Then reload the page. `template.html`, `calendar.css`, and `calendar.js` are the editable source. The builder produces `index.html` and `calendar-data.json` and checks finished-video coverage, distinct event IDs, local video paths, and schedule dates.

`Open Calendar.command` records the Dock launcher's command. A backup of the Dock preferences from before installation is stored in `~/Library/Application Support/Pocket Dev Calendar/`.
