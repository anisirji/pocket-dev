# Reddit filter research and revised submission — November 19, 2026

The revised post was submitted once at the user's explicit request, but Reddit immediately filtered it. Both the signed-in permalink and an independent signed-out page display “Sorry, this post was removed by Reddit’s filters.” It is not publicly published. No further resubmissions or moderator messages were sent.

Revised post: https://www.reddit.com/r/SideProject/comments/1xzykvm/i_built_an_opensource_phone_interface_for_the/

Original post: https://www.reddit.com/r/SideProject/comments/1xz54bl/i_built_pocket_dev_to_check_coding_work_from_my/

## Findings

- [Reddit's spam policy](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam) prohibits repetitive mass promotion and calls for authentic, community-relevant contributions. Promotional content frequency and community-specific standards matter; the policy does not mean every project link is prohibited.
- [The reputation filter](https://support.reddithelp.com/hc/en-us/articles/27441485903124-Reputation-filter) considers karma, verification, and other account signals. This particular filter considers account behavior rather than individual post wording. The visible account profile showed **1 day of Reddit age and 1 karma**. This makes account reputation plausible, but the exact filter and trigger remain undisclosed. Email verification was not established; no ban or shadowban was established.
- [r/SideProject's published rules endpoint](https://www.reddit.com/r/SideProject/about/rules.json) returned no custom rules. The live composer described the community as a place for sharing side projects and receiving constructive feedback. It accepted native video and body text, offered no community flair, and showed no eligibility block. Hidden moderation configuration cannot be inferred from this.
- [Reddit's moderation queue documentation](https://support.reddithelp.com/hc/en-us/articles/15484440494356-Moderation-Queue) says moderators can review filtered/removed posts and approve eligible content. Approval is not guaranteed.

## Revised submission

Title: I built an open-source phone interface for the coding tools running on my computer

I'm the maker of Pocket Dev. I wanted to check a running coding task or respond to an approval request without returning to my desk.

It runs on your own computer and opens in your phone's browser. You can use terminals, read and continue Claude Code or Codex conversations, inspect Git changes, and browse files. It uses your existing coding-tool logins.

It's free and open source. There's no phone app or Pocket Dev cloud account. Your computer needs to stay on and awake. Same-Wi-Fi access is the default; access from outside your home needs additional setup.

The attached demo uses demo data and scripted agent responses. macOS is the best-tested platform; the main Windows 11 features have been tested on a real PC, while Linux hasn't been tested on a real machine.

Source and setup: https://github.com/anisirji/pocket-dev

For people who run long coding tasks: which would you actually use from a phone—checking progress, handling approvals, or reviewing a diff? I'm especially interested in what would make the small-screen workflow frustrating.

Attached the existing 58.666-second landscape demo as native media, with demo-data/scripted-response disclosure. Removed the unsupported “first 10 users” claim, extra external links, and installation-prompt call to action. Verified the six rendered paragraphs and single correct GitHub link before submitting. The redirect confirmed `created=t3_1xzykvm&createdPostType=video`. The signed-in post contains a processed native Reddit video of 58.666016 seconds, matching the full source. Public playback remains unavailable while the post is filtered.

## Moderator-review request draft — not sent

Subject: Could you review my Pocket Dev side-project post?

Hi r/SideProject mods,

I'm the maker of Pocket Dev, a free, open-source tool for using the coding tools on my own computer from a phone browser. My account is new, and Reddit's filters removed my original post. I revised it and made one further submission, which was filtered too:

https://www.reddit.com/r/SideProject/comments/1xzykvm/i_built_an_opensource_phone_interface_for_the/

The revised post has a native demo, one GitHub source/setup link, a maker disclosure, demo limitations, and a specific question about the small-screen workflow. Could you review it and let me know whether it fits the community or requires changes? I won't make further submissions while awaiting guidance.

Thank you.

Only the revised post needs consideration; the earlier attempt is https://www.reddit.com/r/SideProject/comments/1xz54bl/i_built_pocket_dev_to_check_coding_work_from_my/.
