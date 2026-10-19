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
uploading and the Bar's own controls keep working. Uploads are moved on the way:
see [One canvas](#one-canvas).

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
      "name": "livesplit",
      "cwd": "../busybar-livesplit",
      "command": "npm",
      "args": ["start"],
      "autostart": false
    },
    {
      "name": "dota",
      "cwd": "../busybar-dota",
      "command": "npm",
      "args": ["start"]
    },
    {
      "name": "nowplaying",
      "cwd": "../busybar-nowplaying",
      "command": "npm",
      "args": ["start"]
    }
  ]
}
```

**The order of the list is the priority.** The app listed first takes the
screen over every app below it — so above, a running speedrun beats the match,
and the match beats the music. There are no numbers to keep straight; drag an
app in the deck, or move its entry in the file.

A manifest from before this carries a `rank` on each app. It still works: the
numbers are sorted on when the file is read, so it means what it always meant,
and the deck writes it back as a plain order the first time it changes it.

| Field                           |                             |                                                                                                                           |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `name`                          | required                    | The `application_name` the app puts on its own draws. This is the only identity the Bar's API carries, so it is the join. |
| `command`, `args`, `cwd`, `env` | —                           | How to start it. Leave `command` out for an app you start yourself.                                                       |
| `autostart`                     | true, if there is a command |                                                                                                                           |
| `restart`                       | `true`                      | Restart on exit, backing off by doubling.                                                                                 |

Paths are relative to the manifest file, not to wherever you started the daemon.

An app that draws under a name no manifest claims still gets to the screen — it
joins unmanaged, below every app in the manifest. Nothing starts or stops it, and it is judged stale
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

With a profile, a manifest entry can be nothing but a name:

```json
{
  "apps": [{ "name": "mydota" }, { "name": "flights" }]
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
    {
      "name": "mydota",
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "../busybar-mydota"
    },
    { "name": "flights" }
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
2. Otherwise the app listed **highest in the manifest** wins.
3. Apps outside the manifest share the bottom place; between those, the app's
   own **draw priority** — the `priority` on its frame — decides.
4. Then whoever drew most recently.

A frame stays for at least `WM_MIN_HOLD_MS` before an app in the _same_ place
can take over, so two apps that both redraw every 200ms do not trade the screen
at 200ms. An app higher in the list interrupts immediately — that is what the
order is for.

### One canvas

The Bar's canvas has a single owner: a draw under another name needs a strictly
higher priority, and then wipes whatever the previous owner had. So the device
only ever sees one application, `busybar-wm`, and each app's element ids carry
its name — `nowplaying/legacy:title`. What the canvas holds is remembered here, so
a new frame, or a handover between apps, reaches the device as the difference:
what changed is drawn, what went is deleted by id, and the screen is never
blanked in between.

An image's `path` resolves inside the drawing application's own folder on the
Bar, so uploads are moved into `busybar-wm`'s: `cover.png` from nowplaying is
stored as `nowplaying/cover.png`, and the app's image elements are pointed at it.
Sounds an app uploaded are played from there too. Nothing changes in the apps.

A short BACK on the device, or a move of the switch, closes the canvas whatever
is on it. The daemon hears it on the input socket and draws the frame again a
moment later, instead of waiting for the app to change something.

### By hand

With `WM_INPUT=1` (the default) the Bar's own buttons switch apps:

- **holding OK** — step to the next app that has something to show,
- **BACK** — give the choice back to the policy.

A short OK, START and the knob are the apps'. An app on the display socket asks
for the ones it wants — `focused`, to hear them while it is on screen, or
`always`, to hear them whatever is — and gets them over the socket; only one
app can hold a key `always`. `busybar-nowplaying` holds the knob that way, as
the system volume. Apps behind the proxy read the status socket themselves and
hear every press, as before.

`WM_KNOB=1` makes the knob the window manager's instead: turning it switches
apps, and no app can ask for it.

## The display socket

An app can do better than draw and hope. `ws://127.0.0.1:4111/wm/v1/display`
speaks the display protocol: the app names itself, creates a surface per panel,
and commits whole frames; the daemon says when a surface is shown or hidden, and
sends `frame` when a draw would be seen — so an app off screen renders nothing.
The session is the app's life: when it closes, its frames go.

Every supervised app is given `WM_ADDR` and its own `WM_TOKEN`, and
`busybar-kit/display` is the client. Apps behind the proxy and apps on the
socket share one scene and one policy. The design, and why each message
exists, is in [docs/display-server.md](docs/display-server.md).

| Variable      |                                                              |
| ------------- | ------------------------------------------------------------ |
| `WM_FRAME_MS` | The fastest a shown surface is asked to draw. Default `100`. |

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
| `WM_MIN_HOLD_MS`      | Shortest a frame may stay against an app in the same place.     |
| `WM_PIN_MS`           | How long an OK-button choice sticks. `0` keeps it until BACK.   |
| `WM_STALE_MS`         | How long an unsupervised app is believed after its last draw.   |
| `WM_INPUT`, `WM_KNOB` | The Bar's buttons and knob.                                     |
| `WM_PROFILE`          | A directory holding the whole setup. See [Profiles](#profiles). |
| `WM_LOG`              | `verbose` shows every line apps print. See below.               |

The terminal shows one line per event: the time, who said it — each app in its
own colour — and what. By default it holds back what several apps say over and
over: their name on start, their news about reaching the Bar (under the window
manager that is this process; the wm reports on the device itself), and any
line that repeats. A repeated line is shown once, then at most every five
minutes, with a count of how often it came round. `WM_LOG=verbose` shows it all.
Colour is on in a terminal and off in a file or pipe; `NO_COLOR=1` turns it off.

## Known edges

- **A clear that names no application is ignored — from an app.** Under the
  window manager an app only speaks for itself, and a global clear from one of
  them would take the screen from whoever holds it. The daemon does sweep the
  display once on startup, which is a different thing: see below.
- **Apps keep polling while off screen.** They are whole processes and they do
  not know they are hidden, so a background app goes on asking Steam or Stratz
  for updates. Ranking is not rate limiting.
- **`WM_KNOB=1` fights any app that uses the knob.** See above.
- **An app deleting its assets is answered, not obeyed.** Every app's uploads
  share `busybar-wm`'s folder on the Bar, and the device can only delete a
  folder whole, so a `DELETE /assets/upload` would take everyone's covers. The
  files stay; nothing draws them once the app stops naming them.
- **A hundred elements in all.** That is the device's limit for the canvas, and
  it now counts every app's elements on screen together — which, while one app
  is shown at a time, is the same as before.

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
src/wm/        scene (who wants the screen, and with what), arbiter (who gets
               it), canvas (what the device should hold), compositor (making
               it so), supervisor (the processes)
src/bar/       the one connection that reaches the hardware, and its input socket
src/mock-bar.ts a BUSY Bar that is not a BUSY Bar
```

The arbiter and the canvas are pure functions and the scene is a plain state machine, on
purpose: the entire policy of the window manager is testable without a device,
a socket, or a clock.

## License

MIT
