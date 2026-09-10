# busybar-wm

> [!IMPORTANT]
> **Unofficial community project.** Built and maintained by [@viirtualp1](https://github.com/viirtualp1), **not** an official Flipper Devices / BUSY product, and not affiliated with, endorsed by, or supported by them. "BUSY Bar" remains their trademark. For the real hardware and official apps, visit **[busy.app](https://busy.app/)**.

A window manager for the [BUSY Bar](https://busy.bar). One device, one screen,
as many apps as you like — and something that decides which of them you are
looking at right now.

Dota when a match is live, the chess clock during a game, the album cover the
rest of the time, and the display handed back to the Bar when nothing has
anything to say.

## The trick

`busybar-wm` is a reverse proxy that sits in front of the Bar. Apps point
`BUSY_ADDR` at the daemon instead of at the device, and **nothing else about
them changes** — not a line of code, not a dependency.

```
busybar-dota ─┐
busybar-chess ─┤   BUSY_ADDR=http://127.0.0.1:4111
nowplaying ────┼──────────► busybar-wm ──────────► BUSY Bar
livesplit ─────┘            (arbitrates)           (one app at a time)
```

Everything the window manager needs to know, it already sees in the traffic:

- an app **drawing** is an app asking for the screen,
- the `DELETE /display/draw` every app already sends when it has nothing to
  show is it **giving the screen back**,
- and the last frame it drew is kept here, so when it wins the screen again it
  is replayed without the app ever being asked to redraw.

Draws are answered by the daemon. An app that is off screen is told its frame
landed — because it did, here — and carries on as if it owned the display.
Everything that is not a draw (asset uploads, the status socket, brightness,
`/version`) is piped straight through to the hardware, so cover art keeps
uploading and the Bar's own controls keep working.

## Quick start

```bash
npm install
cp .env.example .env          # the Bar's address and password go here, once
cp wm.config.example.json wm.config.json
npm run dev
```

`.env` is the only place the Bar's credentials live now. The apps behind the
proxy are handed a `BUSY_ADDR` that points at the daemon, and whatever
credentials they send are replaced on the way out.

## The manifest

```json
{
  "apps": [
    {
      "name": "dota",
      "rank": 40,
      "cwd": "../busybar-dota",
      "command": "npm",
      "args": ["start"]
    },
    {
      "name": "nowplaying",
      "rank": 20,
      "cwd": "../busybar-nowplaying",
      "command": "npm",
      "args": ["start"]
    },
    {
      "name": "livesplit",
      "rank": 60,
      "cwd": "../busybar-livesplit",
      "command": "npm",
      "args": ["start"],
      "autostart": false
    }
  ]
}
```

| Field                           |                             |                                                                                                                           |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `name`                          | required                    | The `application_name` the app puts on its own draws. This is the only identity the Bar's API carries, so it is the join. |
| `rank`                          | `10`                        | Higher takes the screen.                                                                                                  |
| `command`, `args`, `cwd`, `env` | —                           | How to start it. Leave `command` out for an app you start yourself.                                                       |
| `autostart`                     | true, if there is a command |                                                                                                                           |
| `restart`                       | `true`                      | Restart on exit, backing off by doubling.                                                                                 |

Paths are relative to the manifest file, not to wherever you started the daemon.

An app that draws under a name no manifest claims still gets to the screen — it
joins unmanaged, at rank 0. Nothing starts or stops it, and it is judged stale
`WM_STALE_MS` after its last draw, since no process here proves it is alive.

## Profiles

A manifest pointing at checkouts means every app is a repository you keep on
disk, with its dev toolchain — six of those cost about half a gigabyte, of
which the code is six megabytes. A **profile** is the other way round: one
directory holding the whole setup, with the apps as installed packages.

```
~/.busybar/
  package.json          the apps you chose, as dependencies
  node_modules/         one copy, production dependencies only
  wm.config.json
  mydota/.env
  dota/.env  dota/schedule.json
  flights/.env  flights/flights.json
```

```bash
busybar-wm --profile ~/.busybar        # or WM_PROFILE=~/.busybar
```

With a profile, a manifest entry can be nothing but a name and a rank:

```json
{
  "apps": [
    { "name": "mydota", "rank": 50 },
    { "name": "flights", "rank": 15 }
  ]
}
```

- **`command`** becomes the bin that app's package installed here. The name is
  the `application_name` the app draws with, so `busybar-mydota` is found from
  `mydota` — and a bin under the plain name wins if there is one.
- **`cwd`** becomes `<profile>/<name>/`, created on startup if missing. Every
  app already reads its `.env` from its working directory, so a packaged app
  finds its settings exactly where a checked-out one always did. Nothing inside
  the apps changes.

Both are only ever filled in. A manifest that names a `command` or a `cwd`
keeps it, so a checkout you are working on sits in the same profile as the
packages you are not:

```json
{
  "apps": [
    { "name": "flights", "rank": 15 },
    {
      "name": "mydota",
      "rank": 50,
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "../busybar-mydota"
    }
  ]
}
```

A bare `command` is looked up in the profile too, so `"command": "busybar-dota"`
means the package installed here rather than whatever is on `PATH`. Anything
with a path separator is taken literally.

Without `--profile` or `WM_PROFILE` nothing is filled in and the manifest works
exactly as it always did.

## Who gets the screen

1. An app **pinned** by hand wins, until it stops drawing or the pin expires.
2. Otherwise the highest **rank** wins.
3. Ties fall to the app's own **draw priority** — the `priority` on its frame,
   which is how an app escalates itself without a config change.
4. Then to whoever drew most recently.

A frame stays for at least `WM_MIN_HOLD_MS` before an _equal_-ranked app can
take over, so two apps that both redraw every 200ms do not trade the screen at
200ms. A higher rank interrupts immediately — that is what rank is for.

Only one app's elements are ever on the device. They persist there by id, so a
handover clears the outgoing app before the incoming one draws.

### By hand

With `WM_INPUT=1` (the default) the Bar's own buttons switch apps:

- **OK** — step to the next app that has something to show,
- **BACK** — give the choice back to the policy.

The **knob is left alone** by default. Apps bind it themselves —
`busybar-nowplaying` makes it the system volume — and taking it at this level
would break them. `WM_KNOB=1` if you would rather turn to switch.

## Without a Bar

The device is one of a kind and it sits on a desk. `npm run mock` stands up a
fake one that writes down what it was asked to draw:

```bash
npm run mock                                  # a BUSY Bar on :4110
BUSY_ADDR=http://127.0.0.1:4110 npm run dev   # the real daemon, fake hardware
```

The test suite does the same thing with real `@busy-app/busy-lib` clients
standing in for apps, which is why `busy-lib` is a devDependency here: the
daemon speaks the wire protocol itself and needs no client at runtime.

## Configuration

Everything is in [.env.example](.env.example). The ones worth knowing:

|                       |                                                                 |
| --------------------- | --------------------------------------------------------------- |
| `WM_PORT`             | Where the apps think the Bar is. Default `4111`.                |
| `WM_MIN_HOLD_MS`      | Shortest a frame may stay against an equal rank.                |
| `WM_PIN_MS`           | How long an OK-button choice sticks. `0` keeps it until BACK.   |
| `WM_STALE_MS`         | How long an unsupervised app is believed after its last draw.   |
| `WM_INPUT`, `WM_KNOB` | The Bar's buttons and knob.                                     |
| `WM_PROFILE`          | A directory holding the whole setup. See [Profiles](#profiles). |

## Known edges

- **A clear that names no application is ignored — from an app.** Under the
  window manager an app only speaks for itself, and a global clear from one of
  them would take the screen from whoever holds it. The daemon does sweep the
  display once on startup, which is a different thing: see below.
- **Apps keep polling while off screen.** They are whole processes and they do
  not know they are hidden, so a background app goes on asking Steam or Stratz
  for updates. Ranking is not rate limiting.
- **`WM_KNOB=1` fights any app that uses the knob.** See above.

## Two things that pile up, and no longer do

**Elements the Bar was never told to forget.** They persist on the device by id,
under the name of whoever drew them, and a clear only ever names one app — so an
app that died without cleaning up, or one from a previous run of this daemon,
left its elements there for as long as the Bar stayed up. Enough of those and a
draw comes back `508 Resource Limit Reached`, which is not even a documented
answer for `/display/draw`. The daemon now sweeps the display once on startup,
before it begins arbitrating: nothing of ours is legitimately on screen at that
moment, which is what makes an unnamed clear right there and wrong everywhere
else. It touches only what the API drew, not the Bar's own apps.

**Apps that outlived the daemon.** Kill the daemon hard — close the terminal,
crash it — and the apps it started keep running: holding their ports, so the
next `busybar-mydota` cannot bind 3080 and crash-loops instead, and drawing into
a screen they no longer own. Every child is now written to `children.json` in
the profile as it starts, and the next daemon reads that note and clears up
before it spawns anything. A note older than the machine's own uptime is
ignored, because by then the pid belongs to somebody else.

## Layout

```
src/proxy/     the Bar, as far as an app is concerned — server and socket tunnel
src/wm/        registry (who wants the screen), arbiter (who gets it),
               compositor (making it so), supervisor (the processes)
src/bar/       the one connection that reaches the hardware, and its input socket
src/mock-bar.ts a BUSY Bar that is not a BUSY Bar
```

The arbiter is a pure function and the registry is a plain state machine, on
purpose: the entire policy of the window manager is testable without a device,
a socket, or a clock.

## License

MIT
