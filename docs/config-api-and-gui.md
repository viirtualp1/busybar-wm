# A config API, and a GUI on top of it

A plan for getting from the terminal editor we have to something with a screen —
without either of them knowing what a flight is.

## Where things stand

`busybar-config` already solves the hard half. An app describes its own settings
in a spec, the editor discovers installed packages that carry one, and renders
the questions. Nothing about flights lives in the editor; `busybar-flights` is
what knows that a route reads `SVO-JFK`.

```
busybar-kit/config-spec     the type an app describes itself with
busybar-<app>               "busybar": { "config": "./dist/config-spec.js" }
busybar-config              discovery, the stores, the prompts
```

The stores are the part worth protecting: `.env` files keep every comment and
line, and a JSON config keeps every key it had — including the `_comment` block
that explains its own format. That behaviour is covered by tests and by a
round-trip against the real files, and none of what follows should touch it.

A GUI has the same requirement the CLI had — do not hardcode the settings — so
it should stand on the same specs rather than grow its own copy.

## The obstacle

Specs are JavaScript modules, and two fields in them are functions:

```ts
validate: matching(/^[A-Za-z]{3}-[A-Za-z]{3}$/, 'three letters, a dash, three'),
summary: (entry) => `${entry.number}  ${entry.route}  ${entry.departure}`,
```

Dart cannot call those. Neither can a browser, on its own. While a spec is code,
every client has to be a Node process — which rules out the two clients we
actually want.

Everything below follows from fixing that first.

---

## Phase 1 — the spec becomes data

**Where:** `busybar-kit`, then the five app specs.
**Unlocks:** any client in any language can read what an app is configurable by.

### What changes

`validate` becomes a list of rules. The validators written so far were already
parameterised helpers rather than arbitrary closures, on purpose, so they all
reduce to data with nothing lost:

| today                              | as data                                                                |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `required('A flight number')`      | `{ "kind": "required" }`                                               |
| `matching(/^\d+$/, 'digits only')` | `{ "kind": "pattern", "pattern": "^\\d+$", "message": "digits only" }` |
| `integerIn(1024, 65535)`           | `{ "kind": "integer", "min": 1024, "max": 65535 }`                     |
| `localDateTime`                    | `{ "kind": "datetime", "format": "local" }`                            |

`summary` becomes a template. This is the only place that genuinely loses
expressiveness, because flights does `route ?? from-to`, so the syntax needs a
fallback:

```
"summary": "{number}  {route|from-to}  {departure}  {aircraft}"
```

Rules for the template, kept deliberately small:

- `{key}` — the value, or nothing
- `{a|b}` — `a` if it has a value, else `b`
- `{a-b}` — joined with the literal between them, dropped entirely if either is
  missing, so a half-filled route does not render as `SVO-`
- runs of whitespace left by a missing value collapse

Anything more expressive than that is a sign the app should be storing a
different shape.

### The artefact

Each app's build emits `config-spec.json` beside the module, and `package.json`
points at both:

```json
"busybar": {
  "config": "./dist/config-spec.js",
  "configJson": "./dist/config-spec.json"
}
```

The TypeScript helper stays for authoring — `defineConfigSpec` with real types
and autocompletion — it just produces data now rather than closures. A small
build step serialises it. Keeping both means Node clients skip a parse and
everyone else has a file they can read with nothing installed.

### Versioning

The moment something outside this repo reads a spec, its shape is a contract.
Every spec carries a version from the first day:

```json
{ "specVersion": 1, "name": "flights", "sections": [...] }
```

A client refuses a version it does not know, with a message naming the package
that needs updating. Cheap now, impossible to retrofit.

### Migration

Five specs to rewrite (flights, dota, mydota, livesplit, nowplaying) plus the
validator helpers in the kit and the `askField` renderer in `busybar-config`,
which now interprets rules instead of calling a function. The specs are two days
old, so this is the cheapest this change will ever be.

**Breaking:** `busybar-kit` goes to 2.0.0 — `ConfigField.validate` disappears.
Apps go to 1.2.0. Nothing outside these repos consumes the type yet, so the
blast radius is entirely our own.

---

## Phase 2 — a config API on the daemon

**Where:** `busybar-wm`, on a `/wm` prefix.
**Unlocks:** any GUI at all.

### Why the daemon and not a new process

It is already running, it already knows the profile and the manifest, and it is
the only thing that knows **live state** — which app is on screen right now,
which are alive, what the pin is. A separate config server would have to ask it
anyway.

It is also already an HTTP server. The proxy forwards everything except
`/display/draw` straight to the device, which has two consequences:

- a new API has to sit on a prefix the proxy handles locally — hence `/wm`;
- **a client pointed at the daemon gets the Bar's own API for free**, including
  `GET /screen?display=0`, a single captured frame. A live picture of the Bar in
  the GUI costs nothing but an `<img>`.

### Endpoints

```
GET  /wm/apps
     → [{ name, packageName, rank, installed, running, onScreen,
           spec: <the declarative spec> }]

GET  /wm/apps/:name/config
     → { sections: { ".env": { STEAM_ID: "7656…", STEAM_API_KEY: { set: true, length: 32 } },
                     "flights.json": [ {...}, {...} ] } }

PUT  /wm/apps/:name/config
     { section: ".env", values: { STEAM_ID: "7656…" } }
     { section: "flights.json", entries: [ {...} ] }
     → { saved: true, restartRequired: true }

POST /wm/apps/:name/restart
POST /wm/pin/:name            the same thing OK on the device does
DELETE /wm/pin                back to the policy, like BACK
```

`busybar-config` becomes a library plus a CLI client of the same code. The
discovery, the stores and the lossless round-trip are written and tested; the
daemon imports them. Two implementations of "write a `.env` without wrecking it"
is exactly the duplication this whole set of repos exists to avoid.

### Secrets never leave

A secret is reported as `{ set: true, length: 32 }` and never as its value —
the same rule the CLI already follows on screen. Writes go one way. This is not
optional politeness: a Steam key and the Bar's HTTP password are in these files.

### Restarting after a change

Checked, rather than assumed:

| app                                    | picks up a change                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| **dota** — `schedule.json`             | **live.** `json.ts` re-reads inside `poll()`, so an edit lands within the schedule poll |
| dota — `.env`                          | restart                                                                                 |
| flights — `flights.json` and `.env`    | restart. `config.ts` reads the file once, at startup                                    |
| mydota, livesplit, nowplaying — `.env` | restart                                                                                 |

So `restartRequired` is real and mostly true. The spec should say it per section
(`"reloads": "live" | "restart"`) rather than the API guessing, and the GUI
offers the restart the supervisor can already perform.

The alternative — teach every app to watch its own files — is more work in five
places for a worse result, since a restart is instant and the WM replays the
last frame anyway.

---

## Phase 3 — a web UI, served by the daemon

**Where:** `busybar-wm`, static files behind `/wm/ui`.
**Unlocks:** the phone, with nothing installed.

Not a JSON editor — a remote control, because the device API is right there:

- what is on screen now, with the **live frame** from `/screen`
- switch app, pin, unpin — the same actions as the buttons
- ranks, and start/stop for anything the manifest supervises
- each app's settings, rendered from its spec
- brightness and volume, which are the device's own endpoints

It is one page and no build step worth the name. Serving it from the daemon
means no separate release cycle: it ships inside `busybar-wm`.

---

## Phase 4 — Flutter, if it still appeals

**Unlocks:** an app with an icon, offline shell, better touch.

Nothing from phases 1–3 is wasted: the same declarative specs, the same `/wm`
API. The Flutter client renders fields from `spec.sections[].fields[]` exactly as
the web page does.

Worth being honest about the split: **the API is most of the work and it is
identical either way.** A web page is a day; a Flutter project is a project —
another language in a stack that is otherwise all TypeScript, plus Windows and
Android packaging, plus its own versioning. Doing the web page first also tests
the API against a real client before a second one is committed to it.

So this stays a phase, not a prerequisite.

---

## Security, once anything has a screen

Today the daemon listens on `127.0.0.1` and holds no secrets of its own beyond
`.env`. A GUI for the phone changes both.

1. **Keep the default.** `127.0.0.1` unless someone deliberately opens it.
2. **A token for anything else.** `WM_API_TOKEN`, required on every `/wm` route
   when the bind address is not loopback. Refuse to listen on `0.0.0.0` without
   one — an accidental open port here exposes a Steam key and the Bar password.
3. **Secret values never travel.** Set/not-set, as above.
4. **`/wm` is not proxied.** It must be handled locally and never forwarded, or
   a path confusion turns into a request against the device.

## Open questions

- **Does the GUI edit `wm.config.json` too?** Ranks and autostart are settings
  like any other, and the manifest is the one config with no spec. Giving the WM
  a spec for itself would make it uniform — worth doing, but it is its own
  decision.
- **One profile or several?** Everything assumes a single profile directory. A
  GUI naturally invites "switch to my travel setup", which is a bigger idea than
  it looks.
- **Validation in two places.** With declarative rules the client can validate as
  you type; the server must still validate on write, since it cannot trust a
  client. That is fine, but the rule interpreter should live in one module in the
  kit and be used by both.
- **What happens to an app that is running while you edit it.** Currently: the
  file changes under it and nothing tells it. The restart path covers this, but
  the GUI should say so rather than leaving it to be discovered.

## Order

|     | phase            | why it comes here                                                                                             |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | declarative spec | blocks every client that is not Node; also the only breaking change, so it goes first while the specs are new |
| 2   | `/wm` API        | blocks every GUI; reuses stores that already exist and are tested                                             |
| 3   | web UI           | proves the API against a real client, and answers "change my flight from the airport"                         |
| 4   | Flutter          | additive, and better decided once there is something to compare against                                       |

Phases 1 and 2 are the substance. Phase 3 is small because of them, and phase 4
is optional because of phase 3.
