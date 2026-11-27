# Pocket Dev public launch posts

Prepared 17 November 2026. The first 10 users are already done; this is the public launch. Instagram's first Reel and the YouTube intro are published. Twelve follow-ups are scheduled on each platform; r/SideProject was submitted on 18 November but removed by Reddit’s filters; LinkedIn is live from Rohit’s account with the hero video and a product image in the first comment; other channel posts below remain drafts. The publication record at the end distinguishes live posts from prepared content.

## Instagram: first Reel

Account: [@afk_pocket_dev](https://www.instagram.com/afk_pocket_dev/), confirmed by the owner. Publishing connection: Metricool is connected to @afk_pocket_dev, with timezone Asia/Kolkata. Eleven follow-up Reels are confirmed in its List; the walkthrough is separately scheduled in Meta Business Suite. See [the full Instagram schedule](INSTAGRAM_SCHEDULE.md).

Video: `/Users/ani/Desktop/pocket-dev-video/final2/hero-9x16-bella.mp4` — 30.4 seconds, 1080 × 1920, H.264/AAC, voice and captions. This is the approved hero from the existing production notes.

### Caption

Your laptop does the work. Your phone gives the commands.

I built Pocket Dev so I could check a coding run, approve the next step, or use a terminal without heading back to my desk.

Claude Code, Codex, Git, files, and real terminals — in your phone's browser, running on your own computer.

Free and open source. Nothing to install on your phone. No Pocket Dev cloud account.

Source and setup: github.com/anisirji/pocket-dev

What would you want to do from your phone first?

Demo project shown. Away-from-home access needs optional remote setup; the computer must stay on and awake. Claude Code and Codex use your own accounts.

#PocketDev #ClaudeCode #Codex #OpenSource #BuildInPublic

### First comment

I made this 👋 What would you try first: checking a coding agent, using the terminal, or reviewing Git changes?

### Profile

Name: `Pocket Dev`

Published bio (140 characters):

```text
Your dev computer, from your phone.
Terminals • Claude Code • Codex • Git • Files
Free & open source. By Ani.
github.com/anisirji/pocket-dev
```

Published profile picture: `assets/brand/png/pocket-dev-512.png`, the existing Pocket Dev logo.

Website: `https://github.com/anisirji/pocket-dev`

The updated portfolio is now deployed at `https://www.theani.me/work/pocket-dev`. Instagram's website field is mobile-only in the observed web editor; the GitHub address is currently in the bio as plain text, not a saved website link.

## Reddit: r/ClaudeAI

Video: `/Users/ani/Desktop/pocket-dev-video/final/pocket-dev-promo-16x9-voice.mp4` — 58.67 seconds, 1920 × 1080, H.264/AAC.

### Title

I built an open-source phone interface for Claude Code, terminals and Git on my own computer

### Body

When a Claude Code run needs a decision, I want to check it without going back to my desk. I built Pocket Dev to do that from a phone browser.

It runs on your computer and uses your existing Claude Code login. The phone can show the conversation, tool approvals and diffs, alongside a real terminal, Git changes and files. It also supports Codex using your own login.

The first 10 users have already tried it, and I'm sharing it more widely now.

The demo uses demo data and scripted agent responses; it isn't a recording of a live model run. The server is self-hosted, with no Pocket Dev cloud account and no phone app to install. Same-Wi-Fi access is the default. Away-from-home access is optional and needs a configured tunnel and an awake computer.

macOS is the best tested system. Main features have also been tested on a real Windows 11 PC; Linux hasn't been tested on a real machine.

Source and setup: https://github.com/anisirji/pocket-dev

For people who run Claude Code for longer tasks: which decisions would you actually want to handle from your phone?

## Reddit: r/codex

**Reference draft only, not for publication.** Rules checked 18 November 2026 prohibit bot-generated or bot-posted content. Ani must write and post personally if choosing this community: https://www.reddit.com/r/codex/about/rules.json

Use the same 16:9 demo. This is an alternative community-specific post, not an instruction to submit duplicate posts simultaneously.

### Title

I made a self-hosted phone interface for Codex approvals, chat, terminals and Git

### Body

I built Pocket Dev to check on coding work from my phone while it runs on my computer.

It opens in the phone's browser, uses your existing Codex login, and puts chat, tool approvals, diffs, terminals, Git and files in one place. Claude Code is also supported.

The first 10 users have already tried it. I'd like to hear how this fits into other Codex workflows, particularly the parts you would actually use on a small screen.

It runs on your own computer, with no Pocket Dev cloud account and nothing to install on the phone. Same Wi-Fi by default; optional remote access requires setup and the computer must remain awake.

The video uses demo data and scripted agent responses. macOS is best tested, main features were tested on a real Windows 11 PC, and Linux hasn't been tested on a real machine.

Repo and setup: https://github.com/anisirji/pocket-dev

Would your main use be approving a tool call, continuing a conversation, or checking a command's output?

## Reddit: r/SideProject

### Title

I built Pocket Dev to use my computer's terminals, coding agents and Git from my phone

### Body

Pocket Dev is my open-source tool for the moments when a coding task is still running but I'm away from the desk.

It runs on your own computer. Open it in a phone browser to use real terminals, Claude Code or Codex with your existing accounts, Git and files. No Pocket Dev cloud account or phone app is needed.

The first 10 users have already tried it, and I'm starting the public launch now. Here's the demo and source: https://github.com/anisirji/pocket-dev

Demo data and scripted agent responses are used in the video. Same-Wi-Fi access is the default; optional away-from-home access requires setup and the computer must remain awake. macOS is best tested, Windows 11 main features were tested on a real PC, and Linux hasn't been tested on a real machine.

I'd like feedback on whether the use case is clear from the demo, and what you'd want to use from your phone.

## Hacker News

**The generated title/comment below is a retired draft, not for publication.** Guidelines checked 18 November 2026 require personal writing and prohibit automated posting. Ani must write the title and any comments himself and submit manually: https://news.ycombinator.com/newsguidelines.html

### Title

Show HN: Pocket Dev – terminals, Claude Code and Codex from a phone browser

### Submission URL

https://github.com/anisirji/pocket-dev

### Maker's first comment

Hi HN, I'm Ani. I built Pocket Dev because I wanted to check a coding run, approve the next action or run a command without returning to my desk.

It is a Node.js server running on your own computer. Your phone opens its browser interface, where you get real terminals, Claude Code and Codex conversations using your existing logins, tool approvals, diffs, Git and files. Terminals keep running when the browser disconnects and replay recent output when it reconnects; they don't survive a computer restart.

There is no Pocket Dev cloud account or phone app. Same-Wi-Fi access is the default. Optional remote access uses Cloudflare Tunnel and requires the computer to be on and awake. Local rooms let one phone switch between several computers; rooms over the internet aren't built.

The first 10 users have tried it. macOS is best tested; the main features were tested on a real Windows 11 PC. Linux is implemented but hasn't been tested on a real machine. The demo uses demo data and scripted agent responses.

Node 22+ is required. The repository has the setup commands and per-system guides: https://github.com/anisirji/pocket-dev

I'm interested in feedback on setup friction and which parts of this workflow are useful on a phone.

## Product Hunt

Name: `Pocket Dev`

Tagline: `Your dev computer, from your phone's browser`

Website for submission: `https://www.theani.me/work/pocket-dev` (deployment verified live). Source: `https://github.com/anisirji/pocket-dev`.

Demo source: `/Users/ani/Desktop/pocket-dev-video/final/pocket-dev-promo-16x9-voice.mp4`. This is a local file, not a public video URL; provide a supported public video destination if the launch editor requires one. No video-hosting account is assumed.

Screenshots available in the product repository: `docs/screenshots/hero.png`, `docs/screenshots/02-terminal.png`, `docs/screenshots/07-chat.png`, `docs/screenshots/05-git-changes.png` (confirm files before attaching).

### Description

Use real terminals, Claude Code, Codex, Git and files on your computer from your phone's browser. Pocket Dev is free, open source and self-hosted. No phone app or Pocket Dev cloud account. Coding agents use your existing accounts; optional remote access requires setup.

### Maker comment

Hey Product Hunt, I'm Ani 👋

I wanted to check a coding run or approve its next step from my phone while the work stayed on my computer, so I built Pocket Dev.

It brings real terminals, Claude Code and Codex chats, approvals, diffs, Git and files into one phone-friendly browser interface. It runs on your own machine, and coding agents use your existing accounts.

The first 10 users have already tried it. I'm sharing it more widely now and would love to hear which workflow you would use first.

Same Wi-Fi is the default. Remote access is optional, needs setup, and the computer must remain on and awake. macOS is best tested; main features were tested on a real Windows 11 PC. Linux hasn't been tested on a real machine. The demo uses demo data and scripted agent responses.

Try it and tell me where it helps or where you get stuck: https://github.com/anisirji/pocket-dev

## Indie Hackers

### Title

The first 10 users tried my open-source dev tool. Now I'm launching it publicly.

### Body

I'm Ani, and I built Pocket Dev for a small frustration: returning to my desk just to check a coding run, approve a tool call or run one command.

Pocket Dev runs on your computer and gives your phone a browser interface for terminals, Claude Code, Codex, Git and files. It uses your existing coding-agent accounts. There is no Pocket Dev cloud account or phone app.

The first 10 users have already tried it. The product and videos are ready, and I'm now working on public distribution.

I'm leading with a short product demo, then a fictional story series called AFK about developers being away from their desks. The app screens use demo projects, and scripted agent responses are labelled as demos. I want people to see a useful moment before they see a feature list.

The source and setup are here: https://github.com/anisirji/pocket-dev

Same Wi-Fi is the default. Optional remote access needs setup and an awake computer. macOS is best tested; Windows 11 main features were tested on a real PC, and Linux hasn't been tested on a real machine.

For anyone who has marketed an open-source developer tool: what helped turn an interested viewer into someone who used it again?

## Uneed

Name: `Pocket Dev`

Tagline: `Your dev computer, from your phone's browser`

URL: `https://www.theani.me/work/pocket-dev` (deployment verified live). The existing unauthenticated Uneed preview was created from the repository URL and should be updated to this destination before saving.

Pricing description: `Free and open source. Claude Code and Codex use your own accounts; their costs are separate.`

### Description

Pocket Dev lets you use your own computer from a phone browser: real terminals, Claude Code and Codex chats, tool approvals, diffs, Git and files. It is self-hosted, free and open source, with no Pocket Dev cloud account or phone app to install. Use it on the same Wi-Fi, or configure optional remote access while your computer stays on and awake. macOS is best tested, Windows 11 main features were tested on a real PC, and Linux hasn't been tested on a real machine.

Submitting and scheduling are different actions. Use a free option unless the owner chooses a paid placement; no paid launch has been authorized or purchased.

## Telegram: channel setup and launch announcement

Proposed channel name: `Pocket Dev`

Public handle: not chosen or checked. Do not invent a t.me link.

### Channel description

Pocket Dev releases, demos and setup tips. Use your dev computer from your phone's browser. Free, open source and self-hosted. By Ani. Source: github.com/anisirji/pocket-dev

### Announcement

Pocket Dev is ready for its public launch 🚀

Your computer does the work. Your phone gives the commands.

Use real terminals, Claude Code, Codex, Git and files from your phone's browser. Pocket Dev runs on your own computer; coding agents use your existing logins. No phone app or Pocket Dev cloud account.

The first 10 users have already tried it. Thanks for helping get it this far.

Source and setup: https://github.com/anisirji/pocket-dev

Same Wi-Fi by default. Optional remote access needs setup and an awake computer. The attached demo uses demo data and scripted agent responses. macOS is best tested; Windows 11 main features were tested on a real PC. Linux hasn't been tested on a real machine.

Share the workflow you'd like to use, or report a reproducible bug here: https://github.com/anisirji/pocket-dev/issues

Attach the 16:9 walkthrough. Keep the public announcement separate from the channel description, and do not claim a discussion group exists until it is created.

## Follow-up Instagram posts already backed by finished videos

These are fictional AFK episodes, not the maker's personal testimonials. Each filename is relative to `/Users/ani/Desktop/pocket-dev-video/`.

| Post | Video | Caption |
| --- | --- | --- |
| The Wedding | `final3/ep1-wedding.mp4` | Claude is waiting for approval. Arya is at a wedding. Twenty seconds, then back to the family photo. AFK, episode 1 — a fictional story using the real app with demo data. Ever had to step away from an event to check work? |
| 3 AM: choose the ending | `final3/ep2-3am-question.mp4` | 3:07 AM. The site is down. What should Arya do? Comment 1: fix it from bed, or 2: sleep and handle it in the morning. AFK, episode 2 — fictional story, real app, demo project. |
| The Train, part 1 | `final3/ep3-train-part1.mp4` | A demo in one hour. Tests running. Then the train loses signal. What happens next? AFK, episode 3 — fictional story, real app, demo project. |
| The Train, part 2 | `final3/ep4-train-part2.mp4` | The signal came back. The terminal had kept running. AFK, episode 4 — fictional story, real app, demo project. |
| Chhath, part 1 | `final5/chhath-part1.mp4` | Arya is going home for Chhath Puja. Work has other plans. A Pocket Dev AFK story — fictional characters, real app, demo project. Part 1 of 2. |
| Chhath, part 2 | `final5/chhath-part2.mp4` | Home for Chhath Puja. One more check, then back to the moments that matter. A Pocket Dev AFK story — fictional characters, real app, demo project. Part 2 of 2; watch Part 1 first. |

For the 3 AM choice, publish the winning ending only after real responses are counted. Do not invent a result. Keep the Train and Chhath parts in order. Chhath copy does not make a claim about today's festival date.

Away-from-home episodes need this caption note: `Remote access configured; computer on and awake. Pocket Dev cannot wake a sleeping computer.`

## Product facts and sources

- Product facts: repository `README.md`, `docs/SETUP.md`, `docs/GUIDE.md`, and `docs/ROADMAP.md` as read on 17 November 2026.
- Antigravity: experimental, manually tested on macOS with agy 1.5.9. It is deliberately not a headline launch claim. Some older guide paragraphs and video-folder drafts still call it unbuilt; the current roadmap is more specific.
- The first 10 users are complete: the owner's confirmation in this conversation. No retention, revenue, testimonial or conversion result has been claimed.
- Main demo production method: `/Users/ani/Desktop/pocket-dev-video/PROGRESS.md`; real app demo stack, demo data, scripted agent, simulated installation scene. No live-model-run claim.
- [Show HN requirements](https://news.ycombinator.com/showhn.html): provide a usable product and no requests for votes.
- [Product Hunt promotion rules](https://help.producthunt.com/en/articles/17734384-5-how-to-promote-your-launch-and-what-to-avoid): ask for feedback, never require or reward upvotes.
- [Reddit spam guidance](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam) and community-specific rules: checked via each community's `/about/rules.json`; this does not guarantee moderator approval or satisfy account-specific eligibility.
- [Uneed launch options](https://www.uneed.best/how-it-works): submission is not scheduling; the free queue has a longer wait. Confirm the actual date in the account before announcing it.

## Publication record

| Destination | State | Published URL |
| --- | --- | --- |
| Instagram | First hero Reel live; logo and bio updated. Twelve follow-up Reels scheduled for automatic publication, 17 November–8 December at 20:00 IST (11 Metricool + 1 Meta). Generated-narration videos use the available AI disclosure setting. The audience-selected ending remains conditional | https://www.instagram.com/p/Df1Al_4BZDF/ |
| YouTube | Four public videos live on Mr Ani Shows (intro, tutorial, wide demo, teaser); twelve Shorts scheduled at 20:00 IST, 17 November–8 December; both alternate endings uploaded unlisted. [Full schedule](YOUTUBE_SCHEDULE.md). | https://www.youtube.com/shorts/Nc5vTOAGOVY |
| Reddit | Submitted once in r/SideProject as u/anisirji on 18 November 2026; direct permalink then showed removal by Reddit’s filters. Not publicly live. No duplicate reposts. ClaudeAI remains unposted; r/codex is a manual human-writing step. | https://www.reddit.com/r/SideProject/comments/1xz54bl/i_built_pocket_dev_to_check_coding_work_from_my/ |
| Personal Instagram | @hap.pyani: 14 daily Reels, 18 November–1 December at 20:00 IST; 3 supporting feed posts at 18:30 IST. All 17 saved entries and original video formats verified. Pocket Dev, Rohit and Harsh collaborator selections saved. 14 Story cards prepared; Story scheduling waits for the user’s Page-connection choice. [Campaign record](personal-instagram/README.md). | https://www.instagram.com/hap.pyani/ |
| LinkedIn | Published 18 November 2026 from ROHIT KUMAR DAS. Credits partner Ani; includes website, GitHub, npm and AI setup links. Approved 30.4-second hero video attached; product image published in first comment. Post and image verified after reloading. Rohit’s headline, About, banner, Featured post and three contact website links are updated and verified; two follow-ups scheduled for 23 and 26 November at 11 AM IST and verified in LinkedIn. [Schedule](LINKEDIN_SCHEDULE.md). | https://www.linkedin.com/feed/update/urn:li:activity:7528759827150532608/ |
| Hacker News | Factual product references available. Ani must write the submission text and post manually under current HN rules; the old generated draft is retired. | — |
| Product Hunt | Listing and maker comment prepared; authenticated access pending | — |
| Indie Hackers | Draft prepared; authenticated access pending | — |
| Uneed | Browser preview prepared from the public repository; sign-in needed to save and schedule | — |
| Telegram | Channel copy and announcement prepared; channel access pending | — |
| AI setup prompts | Published 18 November 2026. Copyable setup and project prompts; linked from project page, README, install guides and YouTube channel profile. Agent skill and llms.txt published. | https://www.theani.me/work/pocket-dev/prompts |
| Portfolio | Commit 885409d pushed to main; Vercel deployment successful; project, focus and video checked live | https://www.theani.me/work/pocket-dev |


## Shared AI setup link

Canonical prompt page: https://www.theani.me/work/pocket-dev/prompts

Reusable CTA for launch posts, video descriptions and profiles:

> Want your coding assistant to set it up? Copy the Pocket Dev setup prompt: https://www.theani.me/work/pocket-dev/prompts. Paste it into an assistant running on your own computer.

The page also includes a current-project prompt, agent setup instructions and the reusable skill. The YouTube channel bio and profile links include the AI setup URL. Add this CTA to new posts where links are supported; existing video descriptions and Instagram posts have not been bulk-edited. Website deployment 114bb15 and source guide/skill commit 058e520 were verified live. The npm package will receive the added README/docs/skill files on the next package release; no package was republished for this documentation change.
