# A display server, not a proxy

A plan for turning the window manager from something that reads what apps want
out of their traffic into something they talk to — the way an X or Wayland
client talks to its server.

## Where things stand

The trick today is that apps do not know the window manager exists. Drawing is
the request for the screen, the `DELETE /display/draw` every app already sends
is the release, and the last frame is kept here and replayed. That is what let
every app join without a line of it changing, and it is worth keeping.

But everything the daemon knows is inferred, and every inference has an edge —
most of them are in the README already:

| the daemon needs to know  | how it finds out today                                        | where that goes wrong                                                                      |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| an app wants the screen   | it drew                                                       | drawing and wanting are the same act, so an app cannot keep a frame current without asking |
| an app is alive           | its process exists, or `WM_STALE_MS` since its last draw      | a hand-started app that goes quiet is dropped; one that died lingers until the timeout     |
| an app is on screen       | it is never told                                              | apps off screen keep polling Steam and Stratz, and keep rendering frames nobody sees       |
| who the buttons belong to | everyone: the status socket is tunnelled through to every app | `WM_KNOB=1` fights nowplaying, and OK is taken from any app that might have wanted it      |
| who is speaking           | `application_name` in the body                                | any process can draw as any app                                                            |
| how much of the screen    | all of it                                                     | one app at a time — no notification over the top, nothing beside anything                  |

The traffic only flows one way. Apps talk, the daemon listens, and every row
above is the cost of it having no way to answer.

## The idea

Give the daemon a voice. An app opens a session, asks for a surface, and draws
into it; the server tells it what happened to that surface — shown, hidden,
resized, focused, handed a button press, asked to go.

```
            hello, create surface, commit frame
  app  ────────────────────────────────────────►  busybar-wm  ──────►  BUSY Bar
       ◄────────────────────────────────────────
            configure, frame, input, close
```

This is the X11 shape, and the Wayland refinement of it is the part worth
copying: the server owns the screen, and a client only ever learns its own size
and state — never where it is, or who else is there.

Two corrections to the shape as first proposed.

**Not plain HTTP — a WebSocket.** What an app says fits a request. What the
server says back — you were hidden, you were resized — happens when the server
decides, and a request/response API has nowhere to put it. SSE plus POSTs could
carry it, but then an app's liveness lives in two connections. One socket per
session, and **the connection is the lifetime**: the socket closes, the app's
surfaces are gone, at once. `WM_STALE_MS` stops being needed for anything that
speaks the protocol.

**The proxy stays, as the compatibility layer.** XWayland is what made Wayland
adoptable: old X clients run unchanged inside the new server. The proxy already
is that. A legacy app gets an implicit fullscreen surface named after its
`application_name`, created by its first draw and released by its `DELETE`.
Both kinds of app are surfaces in one scene, arbitrated by one policy. Nothing
that works today stops working, and apps move over one at a time, when they have
a reason to.

---

## Phase 0 — what the device actually allows

**Where:** a scratch script against the real Bar.
**Unlocks:** knowing which of the later phases are possible at all.

**Done, 2026-10-19,** against a Bar on USB (`10.0.4.20`, API `27.14.0`), and
read against the firmware source (`applications/services/canvas/canvas.c`,
`web_server/http_api/api_display.c`, `api_assets.c`). Checked, rather than
assumed:

| question                              | answer                                                                                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| two `application_name`s on screen?    | **No.** The canvas has one owner. A draw from another name needs a strictly higher `priority`; it then destroys every element the previous owner had. At equal priority the device holds the draw for 1.5 s, then answers `409`              |
| clear by a name that is not the owner | `400` — "this application_name is currently not displaying anything"                                                                                                                                                                         |
| is a draw a replacement?              | **No, an upsert by element id.** An id left out of the next draw stays on screen                                                                                                                                                             |
| removing single elements              | `DELETE /display/draw` with `{ application_name, element_ids: [...] }` works. One unknown id fails the whole request with `400`                                                                                                              |
| clipping                              | **Text clips to `width`** — `x: 30, width: 20` lit exactly columns 30–49 — and scrolls with `scroll_rate`. Rectangles have a size; images are only checked against the whole display. `z_index` orders elements                              |
| assets by application?                | **Yes.** An image `path` resolves to `/ext/user_assets/<application_name>/<path>`; another app's file fails to decode, and `../` is refused. But `file` on upload may contain a folder: `file=nowplaying/cover.png` uploads, and draws, fine |
| how fast                              | 40 sequential one-element draws: p50 8 ms, p90 20 ms. 20 in parallel: 140 ms, all `200`. Not a constraint                                                                                                                                    |
| how much                              | 100 elements on the canvas **in total**, counting the ones that persist from earlier draws; past that, `400 Elements number limit exceeded`                                                                                                  |
| the panels                            | front 72×16 RGB; back 160×80, 4-bit grey. When the API draws nothing on the back, the device shows its own "ACTIVE" card there                                                                                                               |
| buttons while an API frame is up      | The canvas swallows all input, so the Bar's own UI does not react — but every press still streams over `/api/status/ws`                                                                                                                      |
| BACK while an API frame is up         | **A short BACK closes the canvas** and wipes every element; the Bar goes back to its own screen. So do the switch positions (BUSY, CUSTOM, OFF, APPS, SETTINGS)                                                                              |

What follows from it:

- **Several surfaces on screen are possible — but only as one draw.** Since the
  canvas has a single owner, the compositor has to draw everything under its own
  name, `busybar-wm`, with element ids namespaced by surface. That is phase 1,
  below, not phase 4: it also makes the ordinary handover between two apps one
  diff instead of a clear followed by a draw.
- **Assets have to be re-homed.** An app's upload goes to
  `busybar-wm/<app>/<file>`, and its image paths are rewritten to match. The
  proxy already sees every upload on the way through, so legacy apps need no
  change for it.
- **The compositor diffs, it does not repaint.** Upsert what changed, delete by
  `element_ids` what disappeared — and only ids it knows are there, since one
  stale id fails the whole delete.
- **Regions are enforceable.** Text gets `width` clamped to its rect; images and
  rectangles have sizes the compositor can check. No font metrics needed here.
- **Elements are a budget.** A hundred across everything visible, so a surface
  gets a share, and a commit over it is refused rather than truncated.
- **A bug today.** BACK unpins in the daemon, and in the same moment the device
  wipes the screen. The compositor still believes its last frame is up
  (`pushedKey` matches), so nothing is redrawn until the app's frame changes —
  a second for nowplaying, possibly minutes for dota. Whatever BACK should mean,
  the device having dropped the canvas has to be an event the compositor knows
  about.

---

## Phase 1 — surfaces inside, nothing changes outside

**Where:** `src/wm/`.
**Unlocks:** a model the protocol can be bolted onto without a rewrite.

**Done, 2026-10-19,** not yet released: `src/wm/scene.ts`, `src/wm/canvas.ts`,
`src/proxy/legacy.ts`, the compositor drawing as `busybar-wm`. Checked on the
Bar on USB as well as against the mock: the device refuses a clear under the
app's own name (so the draw really is `busybar-wm`'s), an image uploaded by an
app draws from its new folder, a handover is one delete by id plus one draw,
and after a BACK pressed through `POST /api/input` the frame is back within a
second and a half.

A refactor with no change an app can see: every existing test stays green, and
the one thing the device sees differently is who the draws are from.

| today                                                  | becomes                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Registry` — apps by name, one frame each              | `Scene` — clients, each holding surfaces; a surface has a role, a frame and a state                                                                                            |
| `decide()` → one name                                  | `layout()` → for every surface, a rect or hidden. Still pure. Today's policy — pin, rank, priority, hold — is the `stack` layout: the winner gets the display, the rest hidden |
| `Compositor` pushes one app's frame                    | pushes the scene: each visible surface's frame, moved into its rect. With one fullscreen surface that is exactly today's push                                                  |
| `ProxyServer.onDraw` / `onClear` write to the registry | the legacy adapter: a draw creates or updates the surface `legacy:<name>`, a `DELETE` releases it                                                                              |

`managed`, `running` and the stale timeout stay, but only for legacy surfaces. A
protocol surface is alive exactly as long as its socket.

### One owner on the device

Phase 0 decided this: the compositor stops drawing under each app's name and
draws everything as `busybar-wm`.

- every element id becomes `<surface>:<id>`, so two apps' `title` never collide
- the compositor keeps what the device holds — ids and their JSON — and pushes a
  diff: one draw for what is new or changed, one `element_ids` delete for what
  went. A handover between apps is that same diff, with no blank frame between
- uploads through the proxy are rewritten: `application_name=nowplaying&file=x`
  becomes `application_name=busybar-wm&file=nowplaying/x`, and image `path`s in
  that app's frames are rewritten to match
- the startup sweep stays, and now clears `busybar-wm` too
- input decides when the canvas was dropped by the device (BACK, the switch):
  the compositor forgets what it believed was there, so the next flush is a full
  push rather than a no-op

To an app this is invisible, which is why it belongs in phase 1. The mock Bar
needs to learn upserts, `element_ids` and asset folders so the tests check what
the device actually does.

Kept on purpose: the layout is a pure function and the scene a plain state
machine, which is the promise the README makes for the arbiter and the registry
today. The whole policy stays testable without a device, a socket or a clock.

---

## Phase 2 — the protocol, fullscreen only

**Where:** `busybar-wm` on `ws://…/wm/v1/display`, and a client in `busybar-kit`.
**Unlocks:** apps that know whether anyone can see them.

**Done, 2026-10-20,** not yet released, in three repos: the server in
`busybar-wm/src/protocol/`, the client as `busybar-kit/display`, and nowplaying
moved over (`src/bar/wm.ts`). Checked on the Bar on USB with nowplaying's real
`App` and `WmDisplay` under the supervisor, a fixture standing in for the
player: it drew both panels, cover included; paused, it went `idle` and kept the
screen while nobody else wanted it; a legacy app drawing took the screen at
once; playing again, nowplaying had it back in the same second.

Where it came out different from the plan below:

- **`close` and `input` are not in v1 yet.** `input` is phase 3; nothing needs
  `close` until the daemon asks an app to go.
- **`ack` is carried, not enforced.** Every surface is fullscreen, so no frame
  can be laid out for the wrong size yet. The serial is in every configure and
  commit, so enforcing it later breaks nobody.
- **An empty commit is "nothing to show".** That is how nowplaying gives the
  screen back after `IDLE_MS`, which a frame at `idle` would not do — `idle`
  means shown when nobody else wants the screen, and a frozen track is what
  nowplaying blanks to avoid.
- **`priority` stays, optional, on a commit.** The manifest's order decides
  between apps; the priority only matters against the Bar's own sessions, as
  it always did.
- **`urgent` wins ties within a rank and interrupts a hold**; it does not jump
  the manifest's order.
- **The fallback lives in the app.** `busybar-kit` has no Bar client of its own
  and should not grow one, so `displayAddr()` says whether there is a window
  manager, and nowplaying picks `WmDisplay` or the `BarDisplay` it always had.
- **The socket is `ws`**, the daemon's one new dependency. The kit's client
  uses Node's own `WebSocket` and needs nothing.
- **Found on the way:** the supervisor gives apps a placeholder password, and a
  daemon with no password of its own — a Bar on USB — passed it on, so every
  app got `403`. It is dropped now when the daemon has nothing to replace it
  with.

### Messages

JSON, one object per WebSocket message, `type` first. Every server message that
changes a surface carries a `serial`.

From the app:

```
hello            { protocol: 1, app, token }
surface.create   { surface, role: "fullscreen", display?: "front" | "back" }
surface.commit   { surface, ack, elements, led_notification_color? }
surface.want     { surface, level: "idle" | "normal" | "urgent" }
surface.destroy  { surface }
```

From the server:

```
welcome          { displays: [{ id, width, height }] }
configure        { surface, serial, width, height, visible, focused }
frame            { surface }                  now is a good time to draw
input            { surface, event }           the same InputEvent src/bar/input.ts decodes
close            { surface, graceMs }         please go; destroyed after graceMs regardless
error            { code, message }
```

A session, as nowplaying would have it — one surface per panel, since it draws
the progress on the front and the cover on the back:

```
→ hello           { protocol: 1, app: "nowplaying", token: "…" }
← welcome         { displays: [{ id: "front", width: 72, height: 16 },
                               { id: "back", width: 160, height: 80 }] }
→ surface.create  { surface: "strip", role: "fullscreen", display: "front" }
→ surface.create  { surface: "cover", role: "fullscreen", display: "back" }
← configure       { surface: "strip", serial: 1, visible: false, focused: false, … }
← configure       { surface: "cover", serial: 2, visible: false, focused: false, … }

   … a track starts …

→ surface.commit  { surface: "cover", ack: 2, elements: [ …art, title… ] }
→ surface.commit  { surface: "strip", ack: 1, elements: [ …title, time… ] }
→ surface.want    { surface: "strip", level: "normal" }
← configure       { surface: "strip", serial: 3, visible: true, focused: true, … }
← frame           { surface: "strip" }
→ surface.commit  { surface: "strip", ack: 3, elements: [ …0:01… ] }
← frame           { surface: "strip" }
→ surface.commit  { surface: "strip", ack: 3, elements: [ …0:02… ] }

   … paused, and left …

→ surface.want    { surface: "strip", level: "idle" }
← configure       { surface: "strip", serial: 4, visible: false, … }
```

The `frame` / `commit` pair is the render loop nowplaying runs today on
`FRAME_MS`, except that it stops on its own the moment the strip is hidden.

### Decisions, and why

- **A commit is the whole frame, not a diff.** That is what apps send today, a
  scene is a handful of elements, and the registry already keys frames by their
  JSON. Working out what actually changed on the device is the compositor's job,
  in one place.
- **Hidden surfaces still take commits.** The replay is the best thing about the
  current design: switching is instant because the frame is already here. A
  hidden app is _told_ it is hidden; what it does about that is its own business.
  Dota can stop asking Stratz every few seconds. A clock can carry on.
- **`frame` is the throttle.** Wayland's frame callback: the server says when a
  draw would actually be seen. A visible surface gets one at most every
  `WM_FRAME_MS`, set from the ceiling phase 0 measures; a hidden one gets none.
  An app that only draws on `frame` can never flood the Bar, and renders nothing
  while nobody is looking. The device takes a draw in about 8 ms, so the limit
  is about what is worth showing, not what the Bar can take: 100 ms to start.
- **`configure` and `ack`.** A commit names the last serial it was drawn for. A
  frame laid out for the old size is not shown in a new rect; the compositor
  keeps the previous one until an acknowledged commit arrives. Meaningless while
  everything is fullscreen, essential the day it is not — and impossible to add
  later without breaking every client, so it is in v1.
- **`want` takes over from inferring it.** Over the protocol, drawing and
  wanting are separate acts: nowplaying keeps its cover current at `idle` and
  asks only when the track changes. The policy still decides — pin, order and
  hold work as they do now, and `want` is one more input to `layout()`, the way
  `priority` is today. `urgent` is the hook phase 4 hangs notifications on.
- **Identity is a token, not a name.** The supervisor already sets `BUSY_ADDR`
  for each child; it sets `WM_ADDR` and a per-app `WM_TOKEN` beside it. A hello
  that claims a manifest name with the wrong token is refused. A client with no
  token joins unmanaged, below the manifest, the way a stranger's draws do now.
- **Assets stay on HTTP.** Uploads are binaries; nothing in them needs
  arbitrating. They go through the daemon, which re-homes them under its own
  name as phase 1 does for legacy apps. The socket carries small JSON and
  nothing else.
- **A commit has an element budget.** The canvas holds a hundred elements in
  all, so `configure` carries the surface's share, and a commit over it gets an
  `error` instead of a cut-off frame.
- **Versioned from the first message.** `protocol: 1` in the hello. A server
  that does not speak it says so in an `error` and closes. The same reasoning as
  `specVersion` in [the config plan](config-api-and-gui.md): cheap now,
  impossible to retrofit.

### The client

`busybar-kit/display`:

```ts
const display = await connectDisplay({ app: 'nowplaying' });
const strip = display.surface('strip', { role: 'fullscreen', display: 'front' });
const cover = display.surface('cover', { role: 'fullscreen', display: 'back' });

strip.on('frame', () => strip.commit(frontElements(frame())));
player.on('track', (track) => {
  cover.commit(backElements(frame()));
  strip.want('normal');
});
player.on('idle', () => strip.want('idle'));
```

The important part is what it does **without** a window manager. With no
`WM_ADDR` in the environment it talks to the Bar directly, as a surface that is
always visible and always focused, with `frame` on a timer. An app ported to it
still runs on its own — which every app does today, and must go on doing.

It reconnects with backoff when the daemon restarts, creates its surfaces again
and recommits the last frame, so a restart of the daemon is invisible from the
app.

### Moving an app over

**Nowplaying first.** It is the hardest of the apps, which is the point: if the
protocol carries nowplaying, it carries the rest. It uses both panels, uploads a
cover per track, redraws continuously, gives the screen back when idle, and
owns the knob and START. Everything in it maps:

| nowplaying today (`src/bar/display.ts`, `src/app.ts`)            | over the protocol                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `renderLoop` pushes a frame every `FRAME_MS`, seen or not        | draws on `frame`; nothing while hidden                                                 |
| `BarDisplay.push` dedups by JSON and serialises draws            | `commit`; dedup, ordering and the diff are the compositor's                            |
| one draw carrying both `display: 'front'` and `'back'` elements  | two surfaces, `strip` and `cover`, so the policy can give the panels to different apps |
| a clear before every new cover, "the only way to be sure"        | gone — the commit is the whole frame, and the compositor deletes the old `art` by id   |
| `blank()` sends `DELETE` after `IDLE_MS`                         | `want('idle')`; the frame stays here, ready                                            |
| `uploadArt` as `nowplaying`                                      | the same call; the daemon re-homes it                                                  |
| `BarInput` opens the status socket itself for the knob and START | unchanged in phase 2; moves to `input` in phase 3                                      |
| `priority` from its config                                       | dropped; the manifest's order and `want` say it                                        |

Outside the daemon, `connectDisplay` falls back to the Bar directly, so
`npm start` on its own behaves exactly as today. The order after it:
**dota, mydota, livesplit last** — each of them a smaller subset of what
nowplaying already proved.

---

## Phase 3 — input goes to whoever has focus

**Where:** `src/bar/input.ts`, becoming an input router in the daemon.
**Unlocks:** the knob, without the fight.

**Done, 2026-10-20,** not yet released: `src/wm/gestures.ts` for what the
window manager keeps, `input.grab` / `input.release` and `input` on the socket,
the same in `busybar-kit/display`, and nowplaying holding the knob `always` and
START `focused`. Checked on the Bar: START reached nowplaying while it was on
screen and nobody once it was not; the knob reached it whatever was showing;
a short OK went to nobody, since nothing asked for it.

Where it came out different from the plan below:

- **Input is opt-in.** An app hears only the keys it grabbed, `focused` or
  `always`; one that asks for nothing is sent nothing.
- **`input` names no surface.** A grab belongs to the session, which is the
  app; the surfaces are panels and do not have keys.
- **One `always` grab per key, first come.** A second app gets `grab_taken`
  naming the holder, and the key is free again when the holder lets go or
  leaves. Ranking grabs by the manifest is easy to add if two apps ever want
  the knob.
- **A hold is 600 ms.** A short OK reaches the app at its release, as a press
  and a release together, because until then it might still become a hold.
- **The device cannot fake a hold.** `POST /api/input?key=…` sends a press and
  a release in one event, so the hold is covered by the tests and has to be
  tried by hand on the Bar. `up` and `down` there arrive as knob turns, which
  is how the knob was checked.

Today every app that wants the knob opens the status socket itself, through the
tunnel, and gets every turn whether it is on screen or not. That is why
`WM_KNOB` is off by default: the daemon cannot take the knob without taking it
from nowplaying.

With focus in the protocol, the daemon reads the socket once — it already does,
for OK and BACK — and hands each event to the focused surface as `input`. It
keeps a few gestures for itself, the way a desktop keeps Alt-Tab:

- **holding OK** — the next app. The device reports press and release, so a
  hold is a timer between the two
- **BACK** — automatic again. The device itself drops the canvas on a short
  BACK, so the daemon cannot make BACK mean anything else; it can only decide
  what comes after (see the open questions)
- everything else goes to the app on screen

Focus alone is wrong for nowplaying, though. The knob is the system volume, and
turning it while dota is on screen should still turn the volume — it does
today, by accident of every app hearing everything. So an app can **grab** an
input regardless of focus:

```
input.grab       { keys: ["encoder"], when: "always" }
input.grab       { keys: ["start"],   when: "focused" }
```

One `always` grab per key, given in the manifest's order; a second app asking
for the same key gets an `error` naming who holds it. The daemon's own gestures
are never grabbable. That replaces `WM_KNOB` with a rule that says who owns the
knob instead of a switch that breaks one app or the other.

Tested with `POST /api/input?key=…`, which presses a button on the device —
the same path the daemon's tests can use against real hardware.

Legacy apps keep their tunnelled socket and keep seeing everything. Nothing
changes for them, and they cannot be stopped from hearing a button — which is
one more reason to move over, not a reason to break them.

---

## Phase 4 — more than one surface on screen

**Where:** `layout()` and the compositor.
**Unlocks:** a notification over the top, a clock beside the score.
**Depends on:** phase 0 — which came back yes, by way of one owner on the device.

New roles, each a rule in `layout()` rather than a new mechanism:

| role         | gets                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| `fullscreen` | the whole display, when it wins. Today's behaviour                                                           |
| `overlay`    | a strip over whoever is on screen, for a few seconds — a match found, a timer done — then it is hidden again |
| `tile`       | a share of the display beside other tiles, split in the manifest's order                                     |

The compositor moves each surface's elements into its rect — ids are already
namespaced from phase 1 — and enforces the rect with what phase 0 found: a
text's `width` is clamped to the rect, images and rectangles that cannot fit are
dropped and logged, and `z_index` puts an overlay above whatever it covers.

Worth being honest about the value. On a display this small a split is a good
demo and an overlay is a feature. Overlay first, and the first overlay is
nowplaying's again: the volume. Today turning the knob makes nowplaying draw its
volume strip and compete for the whole screen; as an overlay it is a few rows
over dota's score for a second and a half, and dota is never hidden. Tiles when
someone actually wants two things on screen at once.

---

## Phase 5 — the deck sees the whole scene

The daemon holds every surface's last frame, visible or not, so the deck could
show all of them — a thumbnail per app rather than only the one on screen — with
the reordering it already does.

The catch is that today's live picture is the device's own capture from
`/screen`. A hidden surface has never reached the device, so its thumbnail needs
the elements drawn in the browser: a renderer for the Bar's element format,
which is a piece of work of its own. Worth it if it gets used for previews
elsewhere too; not before.

---

## What stays as it is

- the supervisor, profiles, `children.json`, the sweep on startup
- every legacy app, through the proxy, unchanged
- `/deck`, and pass-through for everything that is not a draw
- the Bar's credentials, which live in the daemon's `.env` and nowhere else

## Open questions

- ~~**What does `idle` mean?**~~ Settled in phase 2: a candidate of last
  resort, shown only when nobody else wants the screen.
- **Who owns the LED?** `led_notification_color` rides on a draw today, but it is
  one light, not part of a region. The focused surface, or an `urgent` one, or
  an overlay while it is up — it needs a rule before phase 4.
- **The gestures in phase 3.** Pressing OK to switch is muscle memory now. Moving
  it to a hold frees the short press for apps and retrains a hand.
- **What comes after BACK?** The device has already dropped the canvas and gone
  to its own screen. Push the winner straight back — BACK is then a blink — or
  stay off until something new asks, at `normal` or above, so BACK means "leave
  me the Bar's own screen". The second reads as what the person meant.
- **Per panel, or per app?** With surfaces per display, the cover can stay on
  the back while dota has the front. Natural for the policy, and possibly odd
  to look at; the `stack` layout could also hand both panels to one winner.
- **Re-homed assets and their deletion.** `DELETE /assets/upload` removes a
  whole application's folder, and the device has no call for one subfolder. An
  app clearing its assets would, re-homed, clear everyone's — so the daemon
  answers that delete itself, and keeps the device's folder in check by
  forgetting a cover once no frame names it.
- **TCP or a unix socket?** A socket file is faster and its permissions are an
  identity for free. Loopback TCP with a token works the same on Windows and
  from a browser, which is where the deck and a future GUI live. TCP, unless
  there is a reason not to.
- **One session per app, or per surface?** Per app: it is one process, it fails
  as one, and it is one token.

## Order

|     | phase                | why it comes here                                                                          |
| --- | -------------------- | ------------------------------------------------------------------------------------------ |
| 0   | ask the device       | done. One owner per canvas, upserts by id, text clips, assets per app with folders allowed |
| 1   | surfaces inside      | done. The compositor draws as itself, by diff; assets re-homed; BACK fixed                 |
| 2   | protocol, fullscreen | done. Server, `busybar-kit/display`, and nowplaying on it                                  |
| 3   | input by focus       | done. Grabs `focused` and `always`; holding OK switches apps                               |
| 4   | several surfaces     | possible since phase 0; the volume overlay first                                           |
| 5   | deck previews        | needs a renderer the rest of the plan does not                                             |

Apps move in this order: **nowplaying**, then dota, mydota and livesplit last.

Phases 1 and 2 are the substance. Phase 3 is small because of them, and phases
4 and 5 are optional because of everything before.
