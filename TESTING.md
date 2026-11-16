# Plaid — Scaling & Resolution Test Campaign

Purpose: verify Plaid's behavior across display resolutions and scale factors.
Every config is a separate login (Wayland). Work through the matrix top to
bottom; fill the status table; paste the journal excerpts back.

## How to set a config

- **Resolution**: Settings → Displays → Resolution (the TV accepts 4K, 1440p,
  1080p). A live resolution change mid-session exercises T6.
- **Scale**: Settings → Displays → Scale. Fractional values (1.25 / 1.5 /
  1.75) require *Experimental features → Fractional scaling* enabled.
- Scale changes apply on the next login — that login is your test run.

## The matrix

| #   | Config                        | Focus                                                        |
|-----|-------------------------------|--------------------------------------------------------------|
| T1  | 4K @ 2.0                      | baseline (known green — re-confirm)                          |
| T2  | 4K @ 1.0                      | everything at scale 1 on a big panel                         |
| T3  | 1440p @ 1.25 or 1.5           | mid config                                                   |
| T4  | 1080p @ 1.0                   | classic laptop                                               |
| T5  | 1080p @ 1.75                  | small HiDPI — fonts                                          |
| T6  | 4K → 1080p → 4K mid-session   | live monitor change: BGAPP refill, retile, clone             |

## Per-config checklist

### Background app
- [x] Parked at login (journal: `reserved ws0 parking`, `parked ws=0->0`)
- [x] Clone full-bleed, edge to edge (journal: `clone at (0,0,W,H)`)
- [x] Click-through (clicks pass to windows; no pointer interaction with it)
- [x] Present on every workspace; workspace cycling never lands on parking
- [x] Toggle (disable/enable) still works without a relogin

### Tiling
- [x] All five layouts (Spiral / Dwindle / Master-stack / Centered Master /
      Floating) with 3–5 windows — gaps look right
- [x] Maximize respects per-edge gaps
- [x] Float toggle restores exact geometry
- [x] Mouse resize / swap
- [ ] Mouse resize from an edge near its corner (Resize From Edge Corners,
      on by default; Corner Zone, default 20% of the edge at each end): on a
      tiled window, pressing an edge inside the zone resizes both ways, as
      the corner would — both dividers follow the pointer; at mid-edge only
      the edge's own divider moves; with the switch off or the zone at 0,
      every edge press resizes one way. Floating windows resize one way
- [x] Nested dwindle trees: min-size windows hold their slots — no
      oscillation, no give-up floats (changed 2026-10-04)

### Spiral layout
- [ ] Tiles are exactly their slots: minimum sizes (the client's,
      `min-window-sizes`, learned ones) are ignored
- [ ] `Super+G` toggles the focused split's direction; `Super+Shift+G`
      swaps the two sides of the split
- [ ] GNOME's "Move window one monitor to the left/right/up/down" shortcut
      (`Super+Shift+Arrow` by default) moves the window within the layout
      (movewindow); in the other layouts it moves the window to the monitor
      in that direction

### Floating layout
- [x] `Super+Shift+E` cycles to Floating (popup shows "Layout: Floating")
- [x] New windows fade in at GNOME's placement, cursor warps to them
- [x] Float-listed apps (nautilus/Settings/Characters) open at their
      remembered size — never auto-maximized on map (changed 2026-10-04)
- [x] Windows keep positions — no re-tiling, no slot-snapping on resize
- [x] Move-focus (H/J/K/L) navigates spatially; resize grows/shrinks the
      focused window; swap is inert
- [x] Switch back to a tiling layout re-tiles normally
- [x] All Flair (borders, rounded corners, blur) stays on

### Borders & corners
- [x] Gradient border renders (active/inactive colors), animation smooth
- [x] Rounded corners + mask on all windows
- [x] Window blur: parity with 4K look (radius/opacity — see suspects)
- [ ] Dragging a frameless XWayland window (Zoom with `xwayland=true` in
      `~/.config/zoomus.conf`) leaves no border trails: an X11 window's
      border is kept inside its buffer

### Apps with popup windows (Zoom)
- [ ] `popup-window-apps` (default `zoom`): Zoom's main and meeting windows
      tile; its menus, toolbars and other small windows float (a listed
      app's window tiles only when it declares a minimum of at least
      200×200)
- [ ] Holds for XWayland Zoom and native Wayland Zoom (`xwayland=false`,
      app id `Zoom`)
- [ ] "More" and the breakout-room picker stay open while the pointer
      travels to them, with focus on hover on

### Scratchpad
- [x] Add (`Super+Shift+S`) → window minimizes, `scratch add: added`
- [x] Toggle (`Super+Ctrl+S`) shows/hides
- [x] Yellow double border (ring outside the gradient border, rounded)
- [x] Toggle does not re-animate the tiled layout; reveal fly-in keeps its
      animation with no blur smear (changed 2026-10-04)
- [x] Lock/unlock keeps scratchpad members + toggle-float state
      (changed 2026-10-04)
- [x] Master-stack/centered drop: below a column lands at the column's
      bottom; drops land right with floats interleaved (changed 2026-10-04)
- [x] Directional focus/swap reaches narrow panes (few-px overlap)
      (changed 2026-10-04)

### Workspace pill
- [x] Numbers correct (parking never shown), app icon on active, title fits
- [x] No overflow in the top bar at this scale

### Overview
- [x] Parking card hidden (workspace row + app grid)
- [x] Workspace switch keys (1..12, last) land on visible workspaces

### Drop-down terminal
- [x] Drops at ~33% height, live height updates follow the setting

### Journal hygiene
- [x] `journalctl -b -o cat | grep '\[plaid\]'` — zero errors, no JS exceptions

## Known suspects (eyeball specifically)

1. **Blur radius parity** — `window-blur-radius` (capped at 100) × the
   scale of the window's monitor keeps physical consistency; confirm it
   still looks good at scale 1.

## Performance findings (v50.41)

### Mode-change freeze — SOLVED
- **Symptom**: changing resolution *down* (2160p → 1440p → 1080p) with
  windows open froze the system (hard power-down required). Up-changes
  worked; empty-desktop worked; tiling disabled (`toggle-tiling`) worked.
- **Root cause**: the blur sibling size-mismatch handler removed and
  re-created blur effects *synchronously* during the window
  re-configuration flood of a shrinking mode change (`sW > monitorW + 64`
  only fires on shrink — hence the asymmetry). The compositor stalled
  before the extension's `monitors-changed` handler ever ran.
- **Fix**: the mismatch re-attach is now deferred to an idle (per-window
  `_reAttachPending` guard), letting mutter finish the mode change first.
- **Signature**: `[plaid] blur: sibling mismatch → deferred re-attach …`
- **Validated**: 2160 → 1440 → 1080 and back, blur on, all smooth.
- **Related**: the map-time placement race (dropped `move_resize_frame` on
  freshly mapped windows) was fixed with deferred new-window placement +
  verified landing + bounded retries (`anim: landing mismatch …` →
  `landing retry N`); new windows now materialize in their slots, invisible
  at the map position, with cursor warp only after verified placement.

### Blur at 4K-class configs
- Blur at rest is cheap — the earlier freezes were attach/re-sync churn,
  not steady-state cost. Radius is `min(setting, 100) × scale`.
- Fractional scaling (1.25/1.5/1.75) renders at the integer scale
  internally — up to 2.56× the pixels — worth keeping in mind for
  performance expectations on 4K-class fractional configs.

### Final verdict (v50.43)
- **Resolution and scale changes validated across the full range**
  (2160p / 1440p / 1080p, integer and fractional scales, live changes in
  both directions) **with BGAPP, blur, and the full effect stack active —
  zero failures.**

## Status table

| Config | Date | Result | Journal excerpt / notes |
|--------|------|--------|-------------------------|
| T1     | 08-04 | PASS   | 4K@2.0 daily config; mode-change freeze fixed (blur deferral) |
| T2–T5  | 08-04 | PASS   | 2160p / 1440p / 1080p, integer + fractional scales — validated with BGAPP, blur, and the full effect stack |
| T6     | 08-04 | PASS   | live 2160 ↔ 1440 ↔ 1080 changes (blur on) |

## Follow-ups (filled in after each config)

- (none yet)

## Known limitations

- **Multi-monitor**: every monitor tiles its own windows, per workspace, with
  its own layout (see the checklist below). With mutter's
  `workspaces-only-on-primary` on, only the primary tiles. Unplugging and
  replugging a monitor is covered by unit tests only (the headless shell
  cannot hotplug).
- **X11**: Plaid is Wayland-only; on an X11 session it loads inert and shows
  a pinned critical notification ("Plaid requires Wayland").
- **Known upstream issue (not Plaid)**: logging out with Steam running can
  delay or hang the session on Wayland compositors — suspected XWayland
  teardown interop with Steam's X11 clients. Affects mutter too (observed in
  click focus mode). Out of Plaid's scope; evidence in
  `Projects/mutter-4892-comment.md`.

## Stacking model

- Floating windows sit visually above the tiled set via a Plaid-managed
  compositor layer: the restacked re-assert repositions window actors in the
  window group (`set_child_above_sibling`) — **no meta "Always on Top" state
  is ever applied**, so app popup surfaces (Qt included) stack naturally with
  their parents.
- Windowed transients of floating windows are kept above their parents by the
  same re-assert (one-time `stack reassert` log per window as a guard).
- Known GNOME quirk (reproducible without Plaid): GNOME's own "Always on Top"
  can place some Qt app popup surfaces behind their parent. Plaid never
  applies that state; users who want hard-sticky windows can use GNOME's
  feature knowingly.
- The drop-down terminal keeps its dedicated always-on-top behavior (a real
  window with no popups — unaffected by the quirk).

## Window minimum sizes

Three tiers of protection keep tiled slots from ever targeting a size a
window physically cannot take (verified end-to-end against steam, whose
main window declares a 1364px minimum the compositor misreports).

- **Tier 1 — `min-window-sizes` overrides (deterministic, any window
  type).** Entries in the form `"name:WxH"` (e.g. `Steam:1364x810`),
  matched case-insensitively by lookup order **wm_class_instance → wm_class
  → GTK application id → window title**. A title-keyed entry applies only
  when no class entry matches, so `Steam:1364x810` (which matches steam's
  `steam` class) also covers its other windows, e.g. `Friends List`.
- **Tier 2 — the compositor API (`get_min_size()`).** Reliable for native
  Wayland windows (the `xdg_toplevel` minimum). XWayland windows are
  unreliable: mutter returns a `[0, width]`-shaped value with the significant
  width in the second slot, so the API path applies `Number.isFinite`
  normalization and the override is consulted **first** and wins
  unconditionally (the width must never be treated as a height).
- **Tier 3 — observe-and-adjust (the universal net).** After a landing
  mismatch, if a window's frame provably did not move across retries (the
  pinned evidence), the layout bends to the frame: the dwindle walker
  adjusts split ratios, master/stack windows adjust the master ratio or
  their stack weights. Compositing-agnostic — the frame is the truth.
  Guarded by the grab gate (no verdicts mid-drag) and the direction guard
  (only genuine shrink refusals trigger it).

Where it applies:

- **Dwindle** — split ratios clamped to subtree minimum sizes before every
  layout; the drag loop clamps its bounds the same way, so the drag
  physically stops at a window's floor.
- **Master-stack** — the master ratio clamped so the master slot never goes
  below the master window's minimum and the stack column always fits its
  widest window; stack heights clamp to each window's minimum.
- **Centered master-stack** — same, with per-column bounds (each side column
  is only half the remaining width, so the bound is
  `1 − 2·max(colMinW)/basis` — the flat bound would leave a 1364px window in
  a ~700px column).
- **Verdict insurance** — `windowSlotRect` min-clamps every reported slot
  (all layouts but Spiral), so a landing target below a window's minimum
  can never be produced.
- **Spiral** — minimums are ignored: a tile is exactly its slot.
- **Floating** — no clamping needed (windows keep their own size).

Verification status: all four layouts verified with steam's 1364/306 floors
(v50.53 → v50.57) — drags hard-stop at both, zero give-up floats, zero
mismatch churn.

## Per-monitor tiling

- [ ] GNOME's "Move window one monitor to the left/right/up/down" shortcut
      (Super+Shift+Arrow by default; any layout but Spiral, or tiling off)
      moves a window to the monitor in that direction: it joins that
      monitor's layout and stays there
- [ ] Drag a window onto a window on another monitor (and onto an empty
      monitor): the preview and the drop are on the pointer's monitor
- [ ] Super + scroll while dragging: the window lands on the new workspace in
      the layout of the monitor it is dropped on
- [ ] Focus/swap keys at a screen edge cross to the neighbouring monitor
- [ ] Cycle layout and resize change only the focused window's monitor
- [ ] Unplug a monitor: its windows join the remaining layout; plug it back:
      windows moved there get its old layout and arrangement
- [ ] Log out and in: each monitor keeps its layout per workspace

## Focus on Hover (v50.65)

Plaid's own focus-on-hover — the window the mouse enters gains focus.
Implemented with a 200ms poll + `Meta.Window.focus()` (no X11 time
roundtrips) and a scan-based window resolver; a window is focused once, when
the pointer enters it, never again while the pointer moves over it.

Test checklist:

- [ ] Hover ghostty / firefox / emacs — focus follows on arrival
- [ ] An app menu that takes focus as its own window (Zoom's "More") stays
      open while the pointer crosses the window it opened from
- [ ] Chromium-family windows (Electron, CEF, Steam) never take hover focus
      (their menus are web overlays that close on a focus call)
- [ ] Works with GNOME focus mode set to `click` (the mutter #4892 workaround)
- [ ] Multi-monitor: hover windows on any monitor, focus follows
- [ ] Background App on AND off — focus still works (parked window + parking
      workspace excluded from the resolver)
- [ ] Drop-down terminal never takes hover focus (intended)
- [ ] Scratchpad windows take hover focus when SHOWN (changed 2026-10-02 —
      the v50.65 exclusion was removed); hidden (minimized) ones still never
      intercept hover
- [ ] Toggle off — no behavior change; click focus mode unaffected
- [ ] Journal hygiene: `pointer focus: <win>` only with debug on, no
      `pointer focus: scan failed`

## Auto Update (v50.66)

GNOME-style automatic updates: check at login (~15s), silent download +
install, passive notification, loads on next login. Off by default
(`release-check-enabled`); turn Auto Update on to run this checklist.

Test checklist:

- [ ] Login with a newer release available → silent install → notification
      "Plaid vX.Y available — log out and back in to apply."
- [ ] Relog → new version loaded, no second notification (no spam)
- [ ] Auto Update off → no check, no notification on login
- [ ] Failure paths: offline / rate-limited GitHub → silent (no crash);
      bad download / install failure → error notification
- [ ] System-wide install (`/usr/share`) → check skipped entirely (PlaidOS
      path — updates come via `bootc upgrade`)
- [ ] Zip lands in `~/Downloads/plaid@plyply99.zip`
- [ ] Crash check: logout/login after auto-install → 0 SIGABRT, ~9s logouts

## Test protocol

1. Set config → log out/in.
2. Run the checklist.
3. Paste `journalctl -b -o cat | grep '\[plaid\]'` output.
4. Fixes land as commits; the status table tracks each config.
5. Every round ends with a journal-hygiene check: zero `[plaid]` failures,
   no JS exceptions (shell-internal `windowManager.js` destroy-animation
   errors are a known non-Plaid quirk).
