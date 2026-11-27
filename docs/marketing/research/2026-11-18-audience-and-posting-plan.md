# Pocket Dev: audience evidence and posting plan

Researched 18 November 2026. Product baseline: local README, RELEASE_2.0.md and RELEASE_2.1.md. Method: Corey Haines's [customer-research skill](https://github.com/coreyhaines31/marketingskills/blob/main/skills/customer-research/SKILL.md), Mode 2, with its [source guide](https://github.com/coreyhaines31/marketingskills/blob/main/skills/customer-research/references/source-guides.md).

The skill was read and applied directly from its public source. The CLI search could not complete in the network-restricted shell; no global skill installation is claimed. No outreach or external posting was performed.

## What the research supports

There are observable needs for carrying work between agents, continuing local work from a phone, and keeping terminal access alongside agent chat. These are prospective-user signals, not verified Pocket Dev customers or evidence of willingness to pay. No private Discord conversations, customer interviews, product analytics, or conversion data were available. Roles and demographics are omitted unless stated by the author.

Confidence refers to existence of the problem. Confidence in Pocket Dev adoption remains low until people try it and return. Multiple comments within one thread are clustered, not counted as independent sources. Vendor launch posts prove distribution activity and competitive crowding; their promotional claims do not prove customer demand.

## Priority audiences

| Priority | Observable behavior | Job and trigger | Pocket Dev fit | Confidence and qualification |
| --- | --- | --- | --- | --- |
| 1 | Already uses Claude Code and Codex; maintains manual handoff notes or switches after limits | Continue the same task with another agent without manually rebuilding the conversation | Provider switching with carried conversation history; Continue with options | Medium: independent questions and firsthand workflows, plus vendor corroboration. Strongest when BOTH tools are installed and authenticated. No claim of transferred hidden reasoning, identical tool state, or unlimited allowance. |
| 2 | Already runs tasks locally; tries to continue them on a phone | Leave the desk while retaining access to current work | Unified Chats list, computer-session discovery, live following and handover, terminal/Git/files | High for the general need across Reddit, HN and a competitor issue; medium for exact v2.1 fit. Test each source client/session type before promising support. |
| 3 | Maintains client websites on their own computer | A client requests a small change while the developer is away | Local project access, agent chat, terminal and Git in one browser | Low: one explicit business-owner example. A targeted experiment, not a validated market segment. |
| 4 | Already assembles SSH/tmux/Tailscale/browser terminal setups | Reach a persistent local workflow from different devices | Browser terminal, session output replay, files, multiple computers | Medium for adjacent need; lower acquisition priority. Existing solutions are capable and users may prefer them. Linux and latest Windows handover have verification limits. |

Start recruitment with macOS users of the first two workflows, reflecting Pocket Dev's documented testing. Keep other systems' actual limitations visible.

## Voice-of-user evidence bank

Quotes below are verbatim excerpts. Relative dates are preserved where public pages did not expose an exact publication date. Search snippets are explicitly identified. These entries are examples, not a statistical sample.

| ID | Exact excerpt | Source, author/context | Date visible | Interpretation |
| --- | --- | --- | --- | --- |
| E01 | "every time I switch, the new tool starts blank and I have to re-explain everything." | [r/claude question](https://www.reddit.com/r/claude/comments/1uzv9ow/how_do_you_share_codding_session_between_claude/), Much_Passenger_3342 | 4 months ago | Direct request for cross-agent continuity. |
| E02 | "If I have to change context between sessions I have one model write a prompt for another." | Same source, igaper, reply | 4 months ago | An actual workaround; same thread cluster as E01. |
| E03 | "Most of the time I max out Claude and then continue on with codex." | [r/ClaudeAI discussion](https://www.reddit.com/r/ClaudeAI/comments/1xowo4h/anyone_else_find_themselves_switching_back_and/), Sui_Gener1s | Page displays 2h ago; search index dates conflict | Switching trigger; exact date uncertain. |
| E04 | "shared tests, a short task contract, and the current branch state in the prompt." | Same source, bostonaholic | Relative time only | Existing workaround; same cluster as E03. |
| E05 | "I can't access / don't see my Claude Desktop Code sessions on my phone." | [r/ClaudeCode question](https://www.reddit.com/r/ClaudeCode/comments/1w2iojh/bug_or_missing_feature_no_interoperability/), Critical_Peace_1939 | 2 months ago | Existing commuter workflow. Historical problem, not proof of a current native limitation. |
| E06 | "my client texted me he wanted some of the text changed." | [Website-business owner](https://www.reddit.com/r/ClaudeCode/comments/1u4sjt3/can_i_control_my_computer_from_my_phone/), Promptaaa | Page displays 4 months ago | Specific client-work trigger; segment needs more evidence. |
| E07 | "full terminal access, not just CC." | [HN local remote setup](https://news.ycombinator.com/item?id=47775039), Reebz | 7 months ago | User explains why native agent access alone is insufficient for their workflow. |
| E08 | "I’ve usually got 3-10 CC sessions active at any time" | Same HN source, Reebz | 7 months ago | Power-user workflow; does not imply Pocket Dev has equivalent workspace orchestration. |
| E09 | "Installed the app about an hour ago and have been using it as I’m on the go." | [Happy launch discussion](https://news.ycombinator.com/item?id=44904039), becomevocal | 15 August 2025 | Actual trial of a competitor. Older than 12 months, lower weight. |
| E10 | "tapping \"approve\" sometimes gets stuck and has no effect." | [Happy issue #1035](https://github.com/slopus/happy/issues/1035), thelabxl | 12 April 2026 | Reported reliability concern in one setup, not a general competitor verdict. |
| E11 | "im forced to use acode plus claude code connected remotely to my phone, such a high friction setup. any ideas???" | [r/vibecoding question](https://www.reddit.com/r/vibecoding/comments/1vsjcei/how_do_yall_vibecode_when_on_mobile_devices_like/), search-result excerpt | 19 August 2026 | Setup friction; public full-page fetch failed, lower weight. |
| E12 | "At the minimum, running commands through the phone, checking UI, and being able to pick up the work from a desktop later on." | [r/vibecoding request](https://www.reddit.com/r/vibecoding/comments/1qx9arh/any_products_allowing_vibecoding_from_a_mobile/), search-result excerpt | 6 February 2026 | Wants remote computing and continuity. Do not assume Pocket Dev provides the requested preview experience. |
| E13 | "Last night I was away from my desk for about 11hrs and was basically stuck because I couldn't allow the prompt." | [Mobile prompt question](https://www.reddit.com/r/ClaudeCode/comments/1xpkk36/how_do_you_manage_prompts_with_claude_code_on/), ttsoldier | Page displays 2h ago; index date conflicts | Severe interruption, but screenshot concerns local/private-network permission. Do NOT claim Pocket Dev bypasses OS dialogs. |

Further corroboration, treated as maker evidence rather than independent customer validation:

- [DEV session-handover author](https://dev.to/haoli/i-use-claude-code-and-codex-side-by-side-handing-off-between-them-was-pure-pain-so-i-built-a-cli-25bf): built tooling around manually carrying work between agents.
- [DEV handoff walkthrough](https://dev.to/aaron_w_ef987250d3531be6d/how-i-hand-a-claude-code-session-to-codex-and-back-without-re-explaining-anything-2poe): describes model cross-checking and allowance-triggered switching. Vendor/author bias applies.
- [Current ClaudeCode weekly showcase](https://www.reddit.com/r/ClaudeCode/comments/1xxn3k9/weekly_showcase_thread_what_are_you_building_with/): similar remote-control and multi-agent products appear; a reader asks what benefit exists beyond native Remote Control. This is an objection and evidence of an active posting venue, not proof that showcase posts convert.

## Ranked places to post

Ranks are judgments from problem fit and posting access, not measured channel ROI. Open links again before execution because pinned threads rotate.

| Rank | Exact place | Audience/problem to highlight | Solution to demonstrate | Format and posting condition |
| --- | --- | --- | --- | --- |
| 1 | [r/ClaudeCode weekly showcase, 16 November](https://www.reddit.com/r/ClaudeCode/comments/1xxn3k9/weekly_showcase_thread_what_are_you_building_with/) | Local-agent users lose continuity when leaving the computer or switching tools | Open a computer chat on the phone; follow a running reply; continue with another installed provider | Short maker disclosure, actual demo, repo, how Claude contributed and a concrete lesson. Thread explicitly accepts simple self-promotion. |
| 2 | [r/ClaudeAI project showcase hub](https://www.reddit.com/r/ClaudeAI/comments/1xq4qd2/claude_project_showcase_discussion_hub_updated_on/) | Claude/Codex users manually carry task context between tools | One chat, provider switch, carried history, then a visible successful next action | Educational project explanation; free to try, restrained copy, explain Claude's contribution. Hub and rules display conflicting feed-karma thresholds; use the hub rather than assuming feed eligibility. |
| 3 | [DEV Community](https://dev.to/new), discovery tags [claude](https://dev.to/t/claude), [codex](https://dev.to/t/codex), [opensource](https://dev.to/t/opensource) | Developers search for repeatable handoff workflows | Tutorial: actual task in Claude Code, switch to Codex, inspect the resulting change | Original tutorial with screenshots, setup and failure modes. Existing handoff articles show topical supply; readership/conversion unmeasured. [Conduct](https://dev.to/code-of-conduct). |
| 4 | [Claude Discord linked from Anthropic](https://claude.com/community) | Builders compare local-agent workflows and need help trying tools | Live computer-to-phone handover demo; recruit people matching E01/E05 | Community page confirms project sharing. Exact permitted channel and server rules were not accessible publicly: inspect them after joining; no invented channel name. |
| 5 | [Show HN](https://news.ycombinator.com/showhn.html) | Technical users ask why use this over SSH/tmux or native mobile access | Explain browser access to agents, terminal, Git and files, with usable source and setup | Ani personally writes and submits. HN prohibits generated/AI-edited text and automated posts. Existing competitors range from 1 point/1 comment to 30 points/8 comments in inspected examples: no reliable launch spike assumed. |
| 6 | [Vibe Coding X community](https://x.com/i/communities/1898129646782497027), then [r/vibecoding](https://www.reddit.com/r/vibecoding/) | People already own a computer but dislike their remote mobile workflow | Browser-based continuation on their own machine; show first run and limitations | This X community is the subreddit-required approval route. Submit the tool there, await mod approval, then one introductory subreddit post; later posts only for major updates. [Rules](https://www.reddit.com/r/vibecoding/about/rules.json). Approval is not assumed. |
| 7 | [r/selfhosted](https://www.reddit.com/r/selfhosted/) | Self-hosters who also use coding agents want local control plus terminal/files | Self-hosted computer service, phone browser, authentication, terminal reconnection, optional remote setup | Conditional later test. Rules require production readiness and documentation. Lead with verified behavior and system limitations. Do not pitch as a universal SSH/RDP replacement. [Rules](https://www.reddit.com/r/selfhosted/about/rules.json). |
| 8 | [Anthropic's build submission](https://claude.com/community) | Existing Claude builders who may discover featured tools | A concise real demo and how Claude was used to build it | Earned-media submission, not an ordinary community post. [Submission details](https://support.claude.com/en/articles/15485501-submit-your-build-how-it-works-and-what-you-re-agreeing-to). Feature not guaranteed; submission licenses supplied material for promotion. |

## Message briefs, not publication copy

**Cross-agent task continuity:** Problem: re-explaining the task after a provider switch. Demonstration: ask Claude Code to work on a small repository task, switch provider to Codex, inspect what history was carried, and finish one observable step. Question: what project information did the next agent still need? Do not promise lossless native-state transfer or lower costs.

**Computer-to-phone continuity:** Problem: leaving the desk separates the user from an existing local conversation. Demonstration: start on computer, open From your computer on the phone during a reply, show queued input and subsequent handover. Question: would this replace their current remote workflow? Do not imply every IDE/desktop app transcript is supported without checking.

**Local workflow in one browser:** Problem: agent chat alone is insufficient when the next step needs a command, file or Git inspection. Demonstration: open chat, inspect terminal output, review Git and a file from the same phone. Explain same-Wi-Fi default, optional remote setup and awake-computer requirement.

## What to defer

- Broad AI audiences and generic founder directories: no comparably direct problem evidence found here.
- Enterprise buyers: no evidence collected of security review, team buying or willingness to adopt. Do not invent enterprise personas.
- Phone-only beginners without a host computer: outside current product requirements, despite superficially relevant mobile-coding searches.
- Automatic lock-screen approval alerts: current campaign explicitly disclaims them; notification-first demand is not fully served today.
- Antigravity/Copilot as a production-ready headline: experimental status and verification limits remain.
- Reposting the filtered r/SideProject launch: existing local record says removed by Reddit filters. Retain that record; this is not evidence the market rejected the product.

## First experiment

Use ranks 1 and 2 for initial distribution, and rank 3 for a durable tutorial. Recruit five matching testers for each primary workflow before broadening. These are experiment targets, not growth forecasts. Record source, user-described trigger, successful first task, setup obstacles, and voluntary week-later repeat usage. Recheck whether their original problem remains unresolved before suggesting adoption. Treat visits, npm downloads and GitHub stars as discovery indicators, not unique users or retention.

Research found only public proxy evidence. The next confidence increase comes from observed Pocket Dev usage, not another round of persona invention.
