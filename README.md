# dsh-cua-linux

[Chinese](README.zh.md)

A Linux (X11 / XWayland) computer-use backend for [DeepSeek Harness](https://github.com/deepseek-ai).

The official `dsh-computer-use` plugin drives the desktop through the `cua-driver` native
agent, which has no Linux provider: on Linux its accessibility tree comes back empty, clicks
never reach the target window, and text input is refused. This plugin fills that gap, and adds
a second channel that browsers deserve.

Two channels, picked by target:

| Channel | Used for | How |
|---|---|---|
| **CDP** | Chromium / Edge / Electron pages | DevTools Protocol over the built-in `fetch` + `WebSocket`. No extra dependency. |
| **X11** | everything else | Raw X11 protocol via the pure-JS `x11` package; XTEST for input. |

## Install

```sh
dsh plugin add ethanrise/dsh-cua-linux
```

Requirements: Linux with an X11 session (or XWayland for X11 clients), Node ≥ 22.18.
No `xdotool`, no ImageMagick, no Python.

## Tools

| Tool | What it does |
|---|---|
| `cua_linux_probe` | Read-only: session type, X11 sockets, XTEST, `/dev/uinput`, libei, external tools, open DevTools ports |
| `cua_linux_windows` | Enumerate visible windows: id, WM_CLASS, title, position, size, stacking order |
| `cua_linux_screenshot` | PNG of the whole screen or one window (root capture, cropped — child-window `GetImage` returns black under a compositor) |
| `cua_linux_click` | Click at window-local coordinates; activates the window first; left/middle/right, repeated |
| `cua_linux_key` | Key combos and named keys (`ctrl+t`, `Return`, `Escape`) |
| `cua_linux_type` | ASCII text via XTEST. Non-ASCII is refused explicitly — XTEST cannot produce an IME commit |
| `cua_linux_scroll` | Wheel, vertical or horizontal |
| `cua_browser_launch` | Start a Chromium with `--remote-debugging-port` on an isolated profile |
| `cua_browser_pages` | List page targets |
| `cua_browser_goto` | Navigate and wait for quiescence |
| `cua_browser_fill` | Fill a field through `Input.insertText` — CJK and emoji land directly, no IME, no clipboard |
| `cua_browser_click` | Real mouse events at the element's centre (`dispatchMouseEvent`, not `el.click()`) |
| `cua_browser_key` | Enter / Tab / Escape / Backspace / arrows |
| `cua_browser_read` | `innerText` of a selector, or the whole body |
| `cua_browser_screenshot` | PNG through the render pipeline; works while the window is hidden |

## Every action verifies itself

An injection tool that returns `ok` without looking is worse than useless: the model keeps
acting on a state it never reached. Each action therefore reports what was observed.

- X11: a **region** around the action point is compared before/after (90 px for clicks,
  220 px for scrolls); the whole window is a fallback tier so "the change happened elsewhere"
  is reported rather than missed.
- A **noise baseline** is taken first (two frames 250 ms apart), so a blinking caret is not
  mistaken for a successful action. The decision is signal-to-noise, not raw difference.
- Browser `fill` reads `element.value` back and fails on mismatch.
- Browser `click` / `key` watch DOM mutations and URL changes.

Three outcomes, deliberately distinct:

```
✓ Area around the action point changed (7471 px / 31.21%)
⚠ nothing changed around the action point or elsewhere — the event was dispatched
  but no feedback was observed; it may be a repeat action, a non-interactive
  target, or an operation that does not repaint
? Undecidable: the region changes on its own (1.20%), while the action changed
  only 0.13%
```

`⚠` says the event **was** sent; it does not say the operation failed. A second click on an
already-focused field legitimately changes nothing, and wording it as "failed" invites a retry
that can be harmful.

## Known limits

- **X11 only.** Native Wayland windows ignore XTEST. `cua_linux_probe` reports whether
  `/dev/uinput` or libei are available; a Wayland backend is not implemented yet.
- **Non-ASCII input over X11 is not supported.** Use the CDP channel for browsers, or the
  plugin will tell you why instead of dropping characters.
- **X11 injection is global.** Events go to the focused window, so the target must be
  activated — which the tools do by default, at the cost of stealing focus.
- **New tools need a restart.** The harness does not re-run a plugin's `apply()` for an
  already-loaded bundle, so upgrading the package requires restarting DSH.

## License

MIT
