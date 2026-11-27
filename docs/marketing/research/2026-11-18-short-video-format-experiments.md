# Pocket Dev: short-video format experiments

Saved 18 November 2026 from Ani's Codex conversation.

**Latest status:** all three reference MP4s downloaded successfully with yt-dlp 2026.10.26 after network-enabled execution became available. Each is 1080×1920 with audio; ffprobe inspection and a first-second decode passed. Files and a verification manifest are under `.pocket-dev/reference-reels/`. An [initial visual review](2026-11-18-reference-reel-visual-review.md) now describes the actual opening frames, captioned ideas, and sampled visual structure of all three videos. Full audio review and new Pocket Dev production remain pending. Earlier network-failure notes below describe previous attempts.

## Agreed direction

Create videos in each of the three reference formats below, one at a time and in the supplied order. Publish and observe each experiment, then use the results to decide which formats to repeat. The goal is to give relevant viewers a concrete reason to watch, then demonstrate a real Pocket Dev outcome.

Ani's proposed structure: **real-life situation → problem → what if? → demonstration**. Original example: wondering whether you could code from a phone while your PC stays in your bag. This is an idea to develop, not a verified product demonstration: the host computer must stay awake and reachable.

Before scripting, complete: **“The viewer will stay because they want to see whether ______.”**

## Reference queue

| Order | Reference | Original supplied link | Status |
| --- | --- | --- | --- |
| 1 | [Det6xAWgLk4](https://www.instagram.com/reel/Det6xAWgLk4/) | https://www.instagram.com/reel/Det6xAWgLk4/?jplx=czJjYWxuN3dsbHo1 | Downloaded, 93.18s; format inspection pending |
| 2 | [DfhNx3Lh0GP](https://www.instagram.com/reel/DfhNx3Lh0GP/) | https://www.instagram.com/reel/DfhNx3Lh0GP/?rpxt=OTdkcG42ank0ODZp | Downloaded, 84.33s; format inspection pending |
| 3 | [Df1gkaiGSh1](https://www.instagram.com/reel/Df1gkaiGSh1/) | https://www.instagram.com/reel/Df1gkaiGSh1/?cnvx=c3VveTZnN3YybTBk | Downloaded, 108.84s; format inspection pending |

Instagram fetches failed and searches for the three reel IDs returned no results on 18 November. The reference videos have not been watched here. Do not infer their creators, scripts, scenes, or formats from their IDs. Inspect the actual video before claiming to match its format; use an accessible copy if needed.

For each reference, record after viewing: audience, opening visual, spoken opening, on-screen text, story structure, source of curiosity, payoff, duration, shot pacing, sound, and CTA. Adapt the structure to an original Pocket Dev demonstration.

## Skills selected

- Primary: [Vyral viral-hooks](https://github.com/vyralcontent/content-skills/blob/main/skills/viral-hooks/SKILL.md). Develop visual, spoken, and on-screen hooks together; generate different angles; check that the payoff fulfills the promise.
- Full scripts: [Vyral viral-short-form](https://github.com/vyralcontent/content-skills/blob/main/skills/viral-short-form/SKILL.md). Shape hook, escalation, payoff, and CTA.
- Alternative for first-frame critique: [PostPlusAI visual-hook](https://github.com/PostPlusAI/hook-skills/blob/main/creative/visual-hook/SKILL.md).
- Alternative for detailed opening-frame review: [Ootto virality](https://github.com/Ootto-AI/claude-virality-skill/blob/main/virality/SKILL.md). Its performance examples are creator-reported, not independently verified causal evidence.
- Audience context: [Corey Haines customer-research](https://github.com/coreyhaines31/marketingskills/blob/main/skills/customer-research/SKILL.md), applied in the [existing audience report](2026-11-18-audience-and-posting-plan.md).

Skill source files were read online. No local or global installation is claimed. Their frameworks are starting points for experiments, not guarantees of reach or retention.

## Audience and product grounding

Two research-backed hypotheses to test separately:

1. Developers already using Claude Code and Codex want to carry their conversation between agents without manually re-explaining the task.
2. Developers running local coding tasks want to open and continue supported computer conversations from their phone.

These are prospective-user signals, not confirmed adoption. Show verified behavior in the actual product. Conversation history is not identical native agent state. Do not imply automatic notifications or access to a sleeping computer.

## Saved hook ideas

These are proposed scenes, not completed experiments or factual testimonials. Choose the hook that fits the inspected reference and a reproducible demonstration.

| Angle | Spoken opening | First picture | Screen text |
| --- | --- | --- | --- |
| Recognizable problem | “Left Claude running at home?” | Away from the desk, opening the existing session on a phone | “Your session is still there.” |
| Visual surprise | “This phone controls my laptop.” | A phone instruction produces a visible action on the host computer | “Watch the laptop.” |
| Challenge | “One bug. Only my phone.” | A real error and the phone used to investigate it | “Can I fix it?” |
| Switching frustration | “Explaining everything to Codex again?” | A manual handoff from a long Claude conversation | “Another agent. Same explanation.” |
| Practical discovery | “Your terminal, on your phone.” | Run a command and reveal its actual output | “Same computer. Different screen.” |
| Unfinished task | “Can I finish this from here?” | A specific unfinished change, viewed away from the desk | “One change left.” |

Initial creative recommendation: **“One bug. Only my phone.”** It raises a concrete question with an observable outcome. This is a hypothesis, not a selected winner, and it must fit the chosen reference format.

Earlier mobile-demo cut to retain as another option:

| Time | Beat |
| --- | --- |
| 0–2s | “Left your coding session at your desk?” with laptop session and phone visible |
| 2–6s | Open the same supported conversation on the phone |
| 6–11s | Send the next instruction and show the actual reply |
| 11–15s | Pocket Dev name and one setup CTA |

## Baseline supplied by Ani

Instagram screenshot: approximately 30-second reel, with roughly 40–45% still watching around 3 seconds, 25–30% around 10 seconds, and a few percent near the end. These are visual estimates, not exported analytics. The graph shows early loss but does not establish its cause. The actual source reel has not been identified from this screenshot.

View sources shown: Feed 89.7%, Reels tab 8.6%, Profile 1.7%. These sources do not reveal follower status or audience fit. View count, average watch time, and conversion data were not supplied.

## One-at-a-time workflow

1. Inspect reference 1 and write a concrete description of its format.
2. Choose one audience problem and a real, repeatable Pocket Dev outcome that fits the format.
3. Draft distinct hooks with the opening shot, spoken line, and screen text. Select one and storyboard the complete payoff before producing assets.
4. Create the first video, verify the promised behavior, and review it with and without sound.
5. Record the published post and results at consistent observation windows, initially 24 hours, 72 hours, and seven days. These are comparison windows, not platform rules.
6. Repeat for references 2 and 3. Carry findings forward and record any changes to audience, topic, duration, CTA, or distribution.
7. Repeat promising formats with another relevant problem before treating a single result as reliable.

For hook-only comparisons, hold the body and CTA as similar as practical. For different formats, record the differences rather than attributing every result to the hook. Organic audiences vary; comparisons are directional.

## Results to record

| Field | Experiment 1 | Experiment 2 | Experiment 3 |
| --- | --- | --- | --- |
| Reference | Det6xAWgLk4 | DfhNx3Lh0GP | Df1gkaiGSh1 |
| Confirmed format | Pending inspection | Pending inspection | Pending inspection |
| Audience/problem | TBD | TBD | TBD |
| Selected hook and visible payoff | TBD | TBD | TBD |
| Duration/platform/post URL | — | — | — |
| Publication time and observation age | — | — | — |
| Views/reach and available audience split | — | — | — |
| Retention near 3s and 10s, if available | — | — | — |
| Average watch time and completion, if available | — | — | — |
| Shares/saves relative to reach | — | — | — |
| Profile visits/link clicks, if attributable | — | — | — |
| Successful first tasks and voluntary repeat usage, if observable | — | — | — |
| Finding/next change | — | — | — |

Keep metrics separate by platform and use the definitions displayed there. Compare completion alongside duration and average watch time. Use reach and retention to assess attention, and relevant visits and successful product use to assess customer interest. Missing data stays missing.

## Current handoff

All three reference videos are now downloaded, alongside their metadata and a verification manifest. No new Pocket Dev adaptation has been produced, posted, or scheduled. Next: inspect **reference 1** and develop its first Pocket Dev adaptation.

## Download and inspection tools researched

Researched after Ani explicitly requested a skill, MCP, or tool to download the references.

- [yt-dlp](https://github.com/yt-dlp/yt-dlp): the direct command-line option. Its supported-extractor list includes Instagram; actual availability must be tested on the supplied reel. Site support alone does not prove a successful download.
- [smorand/mcp-instagram](https://github.com/smorand/mcp-instagram): an MCP server exposing `download_video` for Instagram videos/reels, built around yt-dlp. It also has a CLI, so connecting a new MCP is not essential just to download a file.
- **vidIQ plugin**: the plugin catalogue describes visual analysis of Instagram Reels, including hooks, structure, and key moments. Suggested as an alternative for the underlying study task; not confirmed connected or tested against these references. Do not claim it offers local MP4 downloading.

Local checks found ffmpeg available and yt-dlp absent. A standalone yt-dlp download from GitHub and an isolated pip installation into `/private/tmp/pocket-dev-reel-tools/python` both failed because the hosts could not resolve. An initial Instagram HEAD request returned HTTP 200, but a subsequent page fetch failed DNS resolution; HTTP 200 alone was not video access. No reference video was downloaded or studied in this attempt. No browser cookies or account credentials were accessed.

Once yt-dlp is available and network access works, the first anonymous download to test is:

```sh
yt-dlp --ignore-config --no-playlist --socket-timeout 15 --retries 1 \
  -P /private/tmp/pocket-dev-reference-reels \
  -o '%(id)s.%(ext)s' \
  'https://www.instagram.com/reel/Det6xAWgLk4/'
```

If Instagram requires authentication, record that result; do not silently export browser cookies. A completed download must be verified as playable before its scenes or format are described.

### Reusable local downloader prepared

The project now includes `scripts/download-reference-reels.sh`. Run this in the Mac's normal Terminal:

```sh
bash /Users/ani/Desktop/pocket-dev/scripts/download-reference-reels.sh
```

It creates an isolated yt-dlp environment under `.pocket-dev/reel-tools/`, downloads all three references in order, and saves videos plus metadata under `.pocket-dev/reference-reels/`. Both locations are covered by the repository's existing `.pocket-dev/` ignore rule. It accepts individual public Instagram reel URLs as arguments. It does not access browser cookies, change global Python packages, or change Codex's network settings.

The script's shell syntax, help, and invalid-URL handling were checked locally. The first installation attempts failed because the sandboxed shell could not resolve external hosts. Subsequently the script ran successfully with approved network-enabled execution, installed yt-dlp 2026.10.26 into its isolated environment, and downloaded all three references without account cookies. Videos and metadata are now available locally for analysis. The saved `download-verification.json` records duration, dimensions, codecs, file size, and verification results for each file.
