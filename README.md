# The Draft Stock Exchange — live site

This repo is the published copy of https://thedraftstockexchange.com. Every push to `main` is deployed by
Cloudflare Workers Builds (`wrangler.jsonc`, static assets in `public/`).

Do not edit files here by hand: `publish_site.py` in the deploy folder rebuilds `public/` from the site's
source on every deploy and replaces it.

A Demas the Hoop Junkie Production.
