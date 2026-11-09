# Admin page layout

The Admin page used to be one long scroll of 16 sections. It now shows one group at a time.

## Groups

| Group (hash) | Sections (element ids) |
| --- | --- |
| Overview (`#overview`) | Needs attention, `connection`, the four cards |
| Devices & access (`#devices`) | `pending`, `devices`, `sharing`, `collaborators` |
| Internet (`#internet`) | `internet`, `quickLink` |
| Messages (`#messages`) | `messages` |
| Security (`#security`) | `guessing` banner, `password`, `log`, Danger zone with `lockdown` |
| This computer (`#computer`) | `settings`, `live`, `permissions`, `service` |

A later "Setup" group only needs one more entry in `GROUPS` (public/admin-nav.js), one nav link and one `group-setup` container in admin.html.

## Decisions

- **Navigation.** One `<nav>` element: a left sidebar at 900 px and wider, a sticky horizontally scrolling tab bar below it (44 px tap targets) on narrow windows. The active link has `aria-current="page"`. Links are plain `<a href="#group">`, so keyboard, reload, deep links and the back button work without extra code.
- **Hash routing.** `#devices` opens a group. A section id such as `#settings` or `#pending` opens the group that holds it and scrolls to it, so old links and the in-page links in the notes keep working. With no hash, the last group (localStorage `pd.admin.group`) opens, else Overview.
- **Ids.** No element id was renamed or removed. `navPending` (the old sidebar count) is gone; the group badges replace it. `quickLink` was already used twice and still is.
- **Needs attention.** `attentionItems()` in admin-nav.js builds the list from the state the page already loads, in this order: password guessing (red), devices waiting, failed logins in the last hour, internet link failed (red) or own domain not connected, Mac permissions missing or waiting (from the Permissions panel, which announces its result with an `admin-permissions` event), service not installed. Each item has a button to the right section. `groupBadges()` adds the same items up per group: red if any item is red, else amber. Unknown permission states do not count, because Screen Recording often reports Unknown. A Quick link that was simply never turned on is not an alert.
- **Danger zone.** Lockdown sits in a dashed red box at the bottom of Security. Its confirmation now ends with "This cannot be undone from a phone." Log out, Block and Remove keep their own confirmations. Stop Pocket Dev stays in Service, styled as a danger button.
- **Wording.** public/machine.js is not served on the Admin port, so admin-nav.js has a small `say()`. The page detects the host with `navigator.platform`. On a Mac text is unchanged. Elsewhere "Mac" becomes "computer" and "launchd service" becomes "background service", applied to the page and to later text through a MutationObserver. New copy says "this computer" and the pill says "This computer only".
- **Long lists.** The Security log shows 20 rows and a Show more button (20 more each time); changing the filter resets it.
- **Less work in hidden groups.** The state is still fetched every 5 s, because the attention strip and badges need it. The security log request, the Collaborators refresh and the Quick link check only run while their group is open, and run at once when it is opened.
- **Sticky bars.** The page measures the header and tab bar into `--top-h` and `--nav-h`, and `scroll-padding-top` uses them, so anchored sections are not covered.
- **Served file.** admin.js serves the new `/admin-nav.js`; that is the only change outside public/.
