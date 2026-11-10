# Deploy the site to pocket-dev.theani.me

Nothing here is enabled yet. The owner does these steps once.

1. **Merge to main.** The workflow `.github/workflows/pages.yml` runs on pushes to `main` that touch `site/`. You can also run it by hand from the Actions tab (Run workflow).
2. **Enable Pages.** GitHub repo `anisirji/pocket-dev`, Settings, Pages, Build and deployment, Source: **GitHub Actions**.
3. **Add the DNS record** at the DNS host for `theani.me`:

   | Type | Name / Host | Value / Target |
   | --- | --- | --- |
   | CNAME | `pocket-dev` | `anisirji.github.io` |

   If the host asks for a full name, it is `pocket-dev.theani.me`. If it proxies records (Cloudflare), set the record to "DNS only" until GitHub issues the certificate.
4. **Set the custom domain.** Settings, Pages, Custom domain: `pocket-dev.theani.me` (the file `site/CNAME` already says so). Wait for the DNS check to pass, then tick **Enforce HTTPS**.
5. **Check.** Open https://pocket-dev.theani.me. DNS can take minutes to hours.

To preview locally: `cd site && python3 -m http.server 8080`, then open http://localhost:8080.
