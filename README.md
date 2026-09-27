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
```

Put it on your PATH with `ln -s "$PWD/bin/ledger" ~/.local/bin/ledger`.

## Commands

```
ledger serve                 run the web app and the location detector
ledger adduser <name>        create an account (asks for a password)
ledger passwd <name>         new password; signs that account out everywhere
ledger deluser <name>        delete an account and everything in it
ledger users                 list accounts
ledger revoke [name]         sign out every session, or one account's
ledger unlock                clear sign-in lockouts (all local requests share one IP)
ledger install-launchd       LaunchAgent dev.ledger.server, log in ~/Library/Logs/ledger.log
ledger uninstall-launchd
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
- **My locations**: places, each with an on/off switch for entry and exit
  logging, the networks that identify them, recent visits and hours per week.
  **Location log** lists every visit.

## Location detection

macOS 14.4+ redacts the Wi-Fi name (`SSID : <redacted>`) for command-line
tools, so a network is identified by its **gateway's MAC address**:
`route -n get default`, then `arp -n <gateway>`. This needs no permissions and
doesn't change per router. If the default route is a VPN tunnel (`utun*`),
each physical `en*` interface is tried instead, so a full-tunnel work VPN
doesn't hide the office.

The detector polls every 30 seconds, and a few seconds after
`/Library/Preferences/SystemConfiguration` changes:

- a network only counts once it's seen on two ticks in a row, so a Wi-Fi blip
  doesn't split a visit; the times recorded are when it was first seen
- if more than 5 minutes pass between ticks (the Mac slept or Ledger was
  stopped), open visits are closed at the last tick before the gap
- turning logging off for a place, or deleting it, closes its open visit at
  once. Deleting is soft, so the log keeps the place's name

Add a network by being there: on a place's page, choose **Add this network**.

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
src/location/           fingerprint + detector
client/boot.ts          govuk init, menu, board drag and drop
static/ledger.css
test/                   vitest: auth, fingerprint parsing, detector, routes
```

`npm test`, `npm run typecheck`.
