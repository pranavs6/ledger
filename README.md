# ledger

A work second brain that runs on this Mac: a journal, a task board, links, and
a location log that notices when the Mac arrives at or leaves your places.
Styled in the GOV.UK design language, like loci and laex.

## Install

Needs Node 22+ (`nvm install 22`). `bin/ledger` finds it on its own, or set
`LEDGER_NODE`.

```bash
nvm use                          # .nvmrc pins 22
npm install                      # also builds static/build/boot.js
bin/ledger adduser pranav        # asks for a password
bin/ledger serve                 # http://127.0.0.1:4545
bin/ledger install-launchd       # or: run at login, restart if it dies
bin/ledger install-helper        # Ledger Locator, for visits to your places
```

Put it on your PATH with `ln -s "$PWD/bin/ledger" ~/.local/bin/ledger`.

## Commands

```
ledger serve                 run the web app
ledger adduser <name>        create an account (asks for a password)
ledger passwd <name>         new password; signs that account out everywhere
ledger deluser <name>        delete an account and everything in it
ledger users                 list accounts
ledger revoke [name]         sign out every session, or one account's
ledger unlock                clear sign-in lockouts (all local requests share one IP)
ledger install-launchd       LaunchAgent dev.ledger.server, log in ~/Library/Logs/ledger.log
ledger uninstall-launchd
ledger install-helper        build Ledger Locator.app, start it at login (LaunchAgent dev.ledger.locator)
ledger uninstall-helper
```

Passwords can be piped for scripting: `printf 'pw\npw\n' | ledger adduser x`.

Environment: `LEDGER_PORT` (4545), `LEDGER_HOST` (127.0.0.1), `LEDGER_DB`
(`~/Library/Application Support/ledger/ledger.db`, mode 600).

## What's in it

- **Today**: where you are, tasks due in the next 7 days, open tasks per
  status, and today's journal.
- **Journal**: entries with a title, a Markdown body and a date. The day view
  (`/journal/day/YYYY-MM-DD`) also lists that day's task status changes and
  place visits. Useful for standups.
- **Tasks**: title, description (Markdown), domain, timeline (free text),
  created, assigned on, due by, status. There's a list view with filters and a
  kanban board: drag cards between columns, or without JS use the status
  select that appears when a card has focus. Every status change is kept as
  history.
- **Statuses** and **domains** are per-user lists you can add to, rename,
  reorder, colour and archive (Menu → Settings). The defaults are Yet to
  begin, In progress, In review, In UAT, Done and Dropped, and UI, App,
  Analytics, Systems and Debugging. A "closed" status counts as finished, so
  its tasks are never overdue and the board only shows the last 14 days of
  them.
- **Links**: URL, title, description and domain.
- **My locations**: places, each a geofence (a centre and a radius) with an
  on/off switch for entry and exit logging, recent visits and hours per
  week. **Location log** lists every visit.

## Location

Visits come from **Ledger Locator**, a small Swift app in `helper/` that
`bin/ledger install-helper` builds into
`~/Library/Application Support/ledger/Ledger Locator.app`, signs for this Mac
and starts at login. It needs the Xcode command line tools. macOS asks once
whether it may use your location; choose Allow.

- It watches each place's geofence with Core Location region monitoring.
  macOS tells it when you cross a boundary, so nothing polls. Each location
  fix is also checked against the geofences, with a margin on the way out so
  a noisy fix near the edge does not flap.
- It reports to `POST /api/helper/report` on 127.0.0.1 every minute and on
  every change: its permission status, its location, and whether it is
  inside or outside each geofence. The reply is the list of geofences to
  watch, so changes in Ledger reach it within a minute. It authenticates with
  the secret in `~/Library/Application Support/ledger/helper-token` (mode
  600).
- A Mac's location comes from nearby Wi-Fi networks and is usually accurate
  to 20 to 100 m, so give geofences a radius of 150 m or more.
- macOS delivers nothing while the Mac sleeps. If the helper goes quiet for 5
  minutes, open visits are closed at its last check-in. On waking it
  re-checks every geofence, and a visit starts again if you are still there.
- Turning logging off, moving a geofence or deleting a place closes its open
  visit at once.
- Add a place on the map, as in loci: search for an address, click to drop
  the pin, drag it to adjust. The geofence is drawn as you change the
  radius, and a blue dot shows where the helper last put this Mac. You can
  also paste coordinates or use **Use this Mac's current location**.

The map is MapLibre GL (served from `node_modules`, not bundled, since it
starts its worker from its own URL) with OpenFreeMap tiles, or VersaTiles in
dark mode. Search goes through `/places/search` to OpenStreetMap's Nominatim
with an identifying User-Agent, at most one request a second, cached in
memory. These are the only requests that leave the Mac, and neither carries
your saved places.

A work Mac's management software may turn off Location Services or block
unsigned apps. The places page says so when the helper cannot get a location.
The helper's ad hoc signature is tied to this build, so reinstalling it may
make macOS ask for permission again. Log: `~/Library/Logs/ledger-locator.log`.

## Security

As in loci: scrypt passwords, opaque session tokens (only their SHA-256 is
stored), 10 failed sign-ins from an IP locks it out for 15 minutes, and
everything is written to `/activity`. As in laex: it binds to `127.0.0.1`,
refuses any `Host` that isn't localhost (DNS rebinding), and refuses writes
from another origin. Markdown is sanitised. If you bind to another address,
it refuses to start when there are no accounts.

## Design

govuk-frontend 6.5.1 is served from `node_modules`, so it works offline.
There's no Crown and no GOV.UK wordmark, and GDS Transport is mapped to local
Arial because the font is licensed for government use only (its files are
never served). Light and dark themes: govuk-frontend 6 reads colours from
`--govuk-*` custom properties, so dark mode is a variable swap (laex's
palette) plus a few overrides in `static/ledger.css`. Choose Match system,
Light or Dark from the Menu.

## Layout

```
bin/ledger              CLI launcher (finds Node 22)
src/cli.ts              commands
src/server.tsx          Hono app, security middleware, static files
src/auth.ts             users, sessions, lockout, audit
src/db.ts               SQLite + migrations (PRAGMA user_version)
src/tasks.ts, categories.ts, places.ts   data
src/routes/*.tsx        pages (hono/jsx, server-rendered)
src/views/              layout and GOV.UK components
src/location/geofence.ts  helper token, reports to visits, sleep handling
helper/                 Ledger Locator (Swift) and its Info.plist
client/boot.ts          govuk init, menu, board drag and drop
static/ledger.css
test/                   vitest: auth, geofence visits, migrations, routes
```

`npm test`, `npm run typecheck`.
