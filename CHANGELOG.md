# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## 0.3.0

### X11 desktop overlays

- The translucent upper-right progress card shows the overall task, current CUA step, and result. The new `cua_linux_progress` tool lets an agent set a task title and an optional step count, or report the final outcome.
- X11 clicks and scrolls show a brief “DSH 鼠标接管中” notice at the top of the pointer's monitor. Clicks also show a blue ring and arrow centered on the actual click location.
- The overlays preserve keyboard focus and pass mouse input through. X11 screenshots and action feedback samples temporarily hide them.

The overlays use GTK 3 and Cairo bindings for system Python. On Debian and Ubuntu, install `gir1.2-gtk-3.0` and `python3-gi-cairo`. Set `DSH_CUA_PROGRESS=0` before starting the host to disable the overlays. Existing CUA tools can run without the overlay dependencies.

The right-hand card was confirmed in a DSH Desktop session. The mouse banner and click marker were verified in the X11 smoke test, including exact click position, input pass-through, and screenshot exclusion.

## 0.2.0

- Added AT-SPI window observation and element actions, including Unicode text replacement with read-back verification.
- Added X11 window activation without a click, focus and pointer target checks, and Unicode clipboard paste.
- Window lists now return decimal IDs ready to pass to tools. Screenshots can be attached directly on DSH routes with image input and attachment storage.
- Shortened coordinate-action waits and distinguished visible feedback from confirmation of the intended result.
- Fixed an X11 error handling bug that could terminate the DSH host when a window disappeared during a request.
- Verified GTK controls, WeChat's coordinate fallback, screenshot attachments, and Chromium CDP Unicode form submission.

X11 screenshots capture visible desktop pixels, so overlapping windows can obscure the target. Chrome's address bar can occasionally require a second Return after X11 text entry. The desktop progress overlay remains in the backlog.

## 0.1.0 — first public release

Two channels, chosen by target: X11 for the desktop, the DevTools Protocol for Chromium.

**Desktop (X11 / XWayland)** — 7 tools

- `cua_linux_probe` reports what the session can actually do: session type, X11 sockets,
  XTEST, `/dev/uinput`, libei, external tools and open DevTools ports. Read-only.
- `cua_linux_windows` lists visible windows with WM_CLASS, title, position, size and
  stacking order.
- `cua_linux_screenshot` captures the screen or one window as PNG. It captures the root
  and crops, because `GetImage` on a child window returns black under a compositor.
- `cua_linux_click` / `cua_linux_scroll` act at window-local coordinates and activate the
  window first — under X11 the pointer hits the topmost window, so an unactivated click
  lands somewhere else without any error.
- `cua_linux_key` / `cua_linux_type` drive XTEST. Non-ASCII input is refused explicitly:
  XTEST can only send keycodes and cannot produce an IME commit.

**Browser (CDP)** — 8 tools

- `cua_browser_launch`, `cua_browser_pages`, `cua_browser_goto`, `cua_browser_fill`,
  `cua_browser_click`, `cua_browser_key`, `cua_browser_read`, `cua_browser_screenshot`.
- Built on Node's own `fetch` and `WebSocket`: no extra dependency.
- `Input.insertText` writes CJK and emoji without an input method or the clipboard.
- Clicks are real mouse events at the element's centre, not `el.click()`.
- Works while the window is hidden or covered, because it never touches pixels.

**Verification**

Every action reports what it observed instead of a bare `ok`:

- X11: the region around the action point is compared before and after, with a noise
  baseline taken first so a blinking caret is not mistaken for a successful action; the
  whole window is a fallback tier so an effect elsewhere is still reported.
- Browser: `fill` reads `element.value` back and fails on mismatch; clicks and keys watch
  DOM mutations and URL changes.
- Three outcomes are kept distinct: verified, dispatched-without-feedback, undecidable.

**Known limits**

- X11 only. Native Wayland windows ignore XTEST; `cua_linux_probe` reports whether
  `/dev/uinput` or libei are available.
- ASCII only on the desktop channel; use CDP for browsers.
- X11 injection is global, so tools activate the target window (and steal focus).
- Upgrading the package requires restarting DSH: the host does not re-run `apply()` for an
  already-loaded bundle.

---

## Pre-public development

Versions `0.0.1` through `0.3.1` below were local iterations, never published. They are
kept for the maintainer's record; the public history starts at `0.1.0`.

#### 0.3.1 — English tool messages

- Every model-facing string (verification verdicts, action results, error paths, probe
  report) is English. Tool descriptions stay Chinese, matching other plugins in this list.

#### 0.3.0 — verification quality

- Region-based verification, noise baseline, signal-to-noise decision.
- Fixed: the `✓` prefix was printed twice for browser-side verdicts.

#### 0.2.0 — act/verify loop

- Pixel diff for X11, read-back for `fill`, MutationObserver and URL for browser clicks.
- Out-of-bounds coordinates fail before any event is sent.

#### 0.1.0 — CDP channel

- 8 tools over the DevTools Protocol with no extra dependency.

#### 0.0.2 — X11 channel

- Window enumeration, EWMH activation, root-capture screenshots, clicks, keys, typing.

#### 0.0.1 — first installable bundle

- `cua_linux_probe`.
