# ira.lgbt

my 10/10 epic le website

A Cloudflare Worker that serves the site and two widgets: what I'm listening to
on Spotify, and an anonymous inbox people can send messages and drawings to.

```sh
npm install
npm test
npm run dev      # needs .dev.vars — copy .dev.vars.example
npm run deploy
```

## Layout

| | |
| --- | --- |
| [src/index.js](src/index.js) | routing, and rendering the landing page |
| [src/spotify.js](src/spotify.js) | the now-playing widget and its 5s cache |
| [src/inbox.js](src/inbox.js) | receiving messages and drawings |
| [src/admin.js](src/admin.js) | reading the inbox, blocking people |
| [src/lib/sender.js](src/lib/sender.js) | anonymous-but-blockable visitor identity |
| [src/lib/access.js](src/lib/access.js) | verifying Cloudflare Access tokens |
| [public/render.js](public/render.js) | Spotify markup — imported by both the Worker and the browser |
| [public/widgets.js](public/widgets.js) | browser side: polling, progress bar, drawing canvas |
| [migrations/](migrations/) | D1 schema |

## Endpoints

| | |
| --- | --- |
| `GET /` | the site, with the Spotify widget already rendered in |
| `GET /api/spotify` | current track + recent, plus how stale the snapshot is |
| `POST /api/inbox` | send a message and/or a drawing |
| `/admin` | the inbox — behind Cloudflare Access |

## How the Spotify widget stays current

The page is rendered with the widget already on it, so it never pops in. The
browser then polls every 5 seconds, and the Worker answers from its own cache
unless that snapshot is more than 5 seconds old — so the number of Spotify API
calls stays flat no matter how many people are looking.

Between polls the progress bar advances locally. Each response carries
`staleMs`, how old the snapshot was when it was served, so the browser anchors
the bar to real playback position rather than drifting.

## Config

Storage: KV for Spotify tokens, D1 for submissions and blocks, R2 for drawing
PNGs — all bound in [wrangler.jsonc](wrangler.jsonc), along with
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` for the admin login.

Secrets (`npx wrangler secret put NAME`): `SENDER_SECRET`, `IP_SALT`,
`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`.

Changing `SENDER_SECRET` logs every visitor out of their identity, and changing
`IP_SALT` orphans every existing ip block. Spam limits live in `LIMITS` at the
top of [src/inbox.js](src/inbox.js).

For local dev, `.dev.vars` carries the same values plus `ADMIN_DEV_BYPASS=true`,
which opens `/admin` without Access. Never set that one on the deployed Worker.
