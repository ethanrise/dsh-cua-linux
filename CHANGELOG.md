# Changelog

## 0.3.0 — verification quality

- Region-based verification: compare only the area around the action point
  (90 px radius for clicks, 220 px for scrolls); the whole window is a fallback tier.
- Noise baseline: two frames captured before the action (250 ms apart) measure how much
  the region changes on its own, so a blinking caret no longer reads as "something happened".
- Signal-to-noise decision, three outcomes: `✓` verified, `⚠` dispatched but no visible
  feedback, `?` undecidable (large animation).
- Fixed: the `✓` prefix was printed twice for browser-side verdicts.

## 0.2.0 — act/verify loop

- Every action now reports what was observed: pixel diff for X11, read-back value for
  `fill`, MutationObserver + URL change for browser clicks and keys.
- Out-of-bounds coordinates fail before any event is sent.

## 0.1.0 — CDP channel

- 8 tools driving Chromium over the DevTools Protocol with no extra dependencies
  (Node's built-in `fetch` and `WebSocket`): launch, pages, goto, fill, click, key, read, screenshot.
- `Input.insertText` writes CJK and emoji without a clipboard or an input method.

## 0.0.2 — X11 channel

- Window enumeration, activation via EWMH `_NET_ACTIVE_WINDOW`, screenshots (root capture
  cropped to the window), clicks, key combos, ASCII typing, scrolling.

## 0.0.1 — first installable bundle

- `cua_linux_probe`: read-only report of session type, X11 sockets, XTEST, uinput, libei,
  external tools, and open DevTools ports.
