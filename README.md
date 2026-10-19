# busybar-wm

> [!IMPORTANT]
> **Unofficial community project.** Built and maintained by [@viirtualp1](https://github.com/viirtualp1), **not** an official Flipper Devices / BUSY product, and not affiliated with, endorsed by, or supported by them. "BUSY Bar" remains their trademark. For the real hardware and official apps, visit **[busy.app](https://busy.app/)**.

**A window manager for the [BUSY Bar](https://busy.bar).** One device, one screen,
as many apps as you like. Every app believes it owns the display; busybar-wm
decides which one actually does — Dota while a match is live, the album cover
the rest of the time, the Bar's own screen when nobody has anything to say.

- **Works with apps as they are.** It is a reverse proxy in front of the Bar.
  Point an app's `BUSY_ADDR` at it and nothing else changes — not a line of code.
- **Speaks a real display protocol** to apps that want more: they learn when
  they are shown or hidden, draw only when it would be seen, and get the
  buttons they asked for. Think Wayland, for a 72×16 strip.
- **Draws by difference.** The device sees one canvas, updated element by
  element — no blank frame between apps, no flicker, layers kept.
- **Runs your apps.** Starts them, restarts them with backoff, and cleans up
  whatever a crashed run left behind, on the device and in the process table.

## How it works

```
                     BUSY_ADDR (HTTP)
 apps as they are  ───────────────────┐
                                      ▼
                     ws /wm/v1/display    scene ──► arbiter ──► compositor ──► BUSY Bar
 apps on the socket ◄────────────────►  who wants   who gets    the diff, by id
                     configure · frame · input
```

The **scene** holds every app's last frame, shown or not, so switching back is
instant and nobody is asked to redraw. The **arbiter** is a pure function, and
the **canvas** diff is one too: the whole policy is tested without a device, a
socket or a clock. What it relies on about the device was measured on a real Bar —
see [docs/display-server.md](docs/display-server.md).

## Quick start

```bash
mkdir -p ~/.busybar && cd ~/.busybar && npm init -y
npm install busybar-wm busybar-nowplaying busybar-dota
echo '{ "apps": [{ "name": "dota" }, { "name": "nowplaying" }] }' > wm.config.json
BUSY_ADDR=10.0.4.20 npx busybar-wm --profile ~/.busybar
```

A **profile** is one folder for the whole setup: the apps as packages, the
manifest, and a folder per app for its own `.env`. A manifest entry can be just
a name — the command and working directory are filled in. Put `BUSY_ADDR`, and
the Bar's password if it has one, in `~/.busybar/.env`; apps never see it.

The deck, a control page for all of it, is at `http://127.0.0.1:4111/deck/`.

## Who gets the screen

1. An app **pinned** by hand, until it stops drawing.
2. The app **highest in the manifest** — order is priority, no numbers.
3. Among equals: `urgent` first, then the app's own draw priority, then the
   most recent.

An app on the socket that is only `idle` — paused music, say — keeps its frame
and is shown only when nothing else wants the screen. `WM_MIN_HOLD_MS` stops two
apps of equal rank from trading the screen every frame.

## Buttons

| On the Bar      |                                                                                      |
| --------------- | ------------------------------------------------------------------------------------ |
| hold **OK**     | next app                                                                             |
| **BACK**        | back to automatic                                                                    |
| everything else | to the app that asked: `focused` while it is on screen, `always` whatever is showing |

nowplaying holds the knob `always`, as the system volume. Apps behind the proxy
read the Bar's status socket themselves, as before. `WM_KNOB=1` makes the knob
switch apps instead.

## The display protocol

JSON over `ws://127.0.0.1:4111/wm/v1/display`. The session is the app's life:
when the socket closes, its frames go.

| app → wm                      | wm → app                               |
| ----------------------------- | -------------------------------------- |
| `hello` with `WM_TOKEN`       | `welcome` — panels, frame rate, budget |
| `surface.create` per panel    | `configure` — shown or hidden          |
| `surface.commit`, whole frame | `frame` — now a draw would be seen     |
| `surface.want` idle · urgent  | `input` — a press the app asked for    |
| `input.grab` focused · always | `error`                                |

The supervisor hands every app `WM_ADDR` and its own `WM_TOKEN`.
[`busybar-kit/display`](https://github.com/viirtualp1/busybar-kit) is the
client, and survives the daemon restarting:

```ts
const display = connectDisplay({ app: 'nowplaying' });
const strip = display.surface('strip', { display: 'front' });

strip.onFrame(() => strip.commit(render()));
display.grab(['encoder'], 'always');
display.onInput((event) => volume(event));
```

## Configuration

All of it is in [.env.example](.env.example). The ones worth knowing:

|                       |                                                      |
| --------------------- | ---------------------------------------------------- |
| `BUSY_ADDR`           | The Bar. `10.0.4.20` over USB.                       |
| `WM_PORT`             | Where apps think the Bar is. Default `4111`.         |
| `WM_PROFILE`          | The profile folder, same as `--profile`.             |
| `WM_MIN_HOLD_MS`      | Shortest a frame stays against an app of equal rank. |
| `WM_PIN_MS`           | How long a hand-picked app stays. `0`: until BACK.   |
| `WM_FRAME_MS`         | Fastest a shown surface is asked to draw.            |
| `WM_INPUT`, `WM_KNOB` | The Bar's buttons; the knob for switching.           |
| `WM_LOG`              | `verbose` for every line the apps print.             |

## Development

```bash
npm run mock                                  # a fake Bar on :4110
BUSY_ADDR=http://127.0.0.1:4110 npm run dev   # the real daemon against it
npm run check                                 # lint, types, tests
```

```
src/proxy/     the Bar, as far as an app is concerned
src/protocol/  the display socket
src/wm/        scene, arbiter, canvas, compositor, gestures, supervisor
src/bar/       the one connection to the hardware, and its input
```

## Known edges

- Apps behind the proxy keep polling while hidden — they do not know. Apps on
  the socket do.
- The Bar holds a hundred elements on its canvas, for everything shown at once.
- An app deleting its assets is answered, not obeyed: every app's uploads share
  one folder on the Bar, and the device can only delete it whole.

## License

MIT
