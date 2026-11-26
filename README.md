# dsh-cua-linux

[Chinese](README.zh.md)

A Linux (X11 / XWayland) computer-use backend for [DeepSeek Harness](https://github.com/deepseek-ai).

Use Chromium's CDP for web content. For desktop windows, use AT-SPI controls when the application exposes them and X11 screenshots or input for the rest.

## Install

```sh
dsh plugin add ethanrise/dsh-cua-linux
```

Requirements: Linux with an X11 session (or XWayland for X11 clients), Node ≥ 22.18.
AT-SPI tools additionally use system Python 3 with GObject and AT-SPI bindings (Ubuntu/Debian: `python3-gi` and `gir1.2-atspi-2.0`). X11 and CDP tools run without Python.

## Tools

| Tool | What it does |
|---|---|
| `cua_linux_probe` | Read-only: session type, X11 sockets, XTEST, `/dev/uinput`, libei, external tools, open DevTools ports |
| `cua_linux_windows` | Enumerate visible windows: id, WM_CLASS, title, position, size, stacking order |
| `cua_linux_screenshot` | PNG of the whole screen or one window (root capture, cropped — child-window `GetImage` returns black under a compositor) |
| `cua_linux_activate` | Bring the target window forward and confirm focus without clicking or switching browser tabs |
| `cua_linux_observe` | Read a window’s AT-SPI control snapshot and element IDs |
| `cua_linux_element` | Invoke a listed action or replace an editable control’s Unicode text and read it back |
| `cua_linux_paste` | Paste Unicode into a focused window, replacing the system clipboard |
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

## Desktop workflow

1. List windows with `cua_linux_windows`, then observe the chosen window with `cua_linux_observe`.
2. Pass the returned snapshot and element ID to `cua_linux_element`. Observe again after dispatch. Text replacement reports whether read-back matched.
3. If the window or control is unavailable through AT-SPI, take a screenshot. Image-capable DSH routes with an attachment store can receive the PNG directly. Coordinate actions check the actual pointer target. For keyboard actions pass `wid` to require the target to have focus.
4. X11 samples post-action pixels for up to 400 ms of scheduled waits. Changes are observations and may come from animations. Confirm the intended result before repeating an action.

## Known limits

- **X11 only.** Native Wayland windows ignore XTEST. `cua_linux_probe` reports whether
  `/dev/uinput` or libei are available; a Wayland backend is not implemented yet.
- **Control coverage depends on the application.** Window matching uses the X11 PID and title. An unambiguous window may also match an AT-SPI frame with the same title exposed by a descendant process. The X11 screenshot is cropped from the visible desktop and can include overlapping windows.
- **X11 input uses the system pointer and keyboard focus.** Click and scroll request focus by default if the target is not already focused. `cua_linux_type` takes ASCII. For Unicode use an editable element or `cua_linux_paste` where the app accepts Ctrl+V.
- **New tools need a restart.** The harness does not re-run a plugin's `apply()` for an
  already-loaded bundle, so upgrading the package requires restarting DSH.

## License

MIT
