# dsh-cua-linux

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
✓ 动作点附近发生变化（7471 像素 / 31.21%）      verified
⚠ 动作点附近与窗口均无变化                       dispatched, no visible feedback
? 无法判定：该区域本身在动（转圈/视频）            undecidable — not guessed
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

---

# dsh-cua-linux（中文）

给 DeepSeek Harness 补上 Linux（X11 / XWayland）的 computer-use 后端。

官方 `dsh-computer-use` 走 `cua-driver` 原生驱动，没有 Linux provider：在 Linux 上 AX 树为空、
点击落不到目标窗口、文本输入被拒绝。本插件补的就是这一层，并且额外提供浏览器该走的那条通道。

## 安装

```sh
dsh plugin add ethanrise/dsh-cua-linux
```

要求：X11 会话（或 XWayland）、Node ≥ 22.18。不需要 `xdotool`、ImageMagick、Python。

## 两条通道

| 通道 | 适用 | 原理 |
|---|---|---|
| **CDP** | Chromium / Edge / Electron 页面 | DevTools Protocol，走 Node 内置 `fetch` + `WebSocket`，零依赖 |
| **X11** | 其他一切 | 纯 JS 的 `x11` 包直连 X server，XTEST 注入 |

浏览器场景不要用像素：selector 定位、`insertText` 免输入法、视口坐标与窗口是否可见无关。
实测同一个搜索任务，X11 通道输中文要 1263ms（剪贴板握手），CDP 是 `insertText` 立即完成。

## 动作闭环

注入类工具最大的问题是「静默成功」。每个动作都带一条可复核的判定：

- X11：比动作点**附近**的区域（点击 90px、滚动 220px），整窗作为兜底
- 先采两帧（间隔 250ms）测「自发变化率」，光标闪烁不再被当成动作生效
- 浏览器 `fill` 读回 `element.value` 严格比对；`click` / `key` 看 DOM 突变与 URL 变化

三种结论刻意分开：`✓` 生效 / `⚠` 已发出但无反馈 / `?` 无法判定（转圈、视频等大面积动画）。

## 已知边界

- **只支持 X11**。原生 Wayland 窗口收不到 XTEST 事件；`cua_linux_probe` 会报告 `/dev/uinput`
  和 libei 的可用性，Wayland 后端尚未实现
- **X11 下无法输入非 ASCII**（XTEST 只能发 keycode），浏览器请走 CDP
- **X11 注入是全局的**：事件发给焦点窗口，所以工具默认会先激活目标窗口（代价是抢焦点）
- **新工具要重启才生效**：宿主不会对已加载的插件重跑 `apply()`，升级包后需重启 DSH

## 踩过的坑（写给下一个维护者）

1. **XTEST `FakeInput` 的第 4 个参数是 root window，不是可选的窗口 id。**
   传 `0` 时鼠标移动和点击居然还能用，按键却会被服务器静默丢弃。

2. **`X.require('xtest')` 必须传回调**，不传会在扩展加载完成时抛
   `TypeError: callback is not a function`，栈指向 xcore 内部。

3. **`XRaiseWindow` 在 mutter 下无效**，置顶必须发 EWMH `_NET_ACTIVE_WINDOW`，
   且 `source indication` 用 `2`（pager）才不会被防焦点窃取拦下。

4. **对子窗口 `GetImage` 在 compositor 下常拿到黑图**，稳定做法是抓 root 再按窗口几何裁剪。

5. **只等 selector 出现会截到空白页**。点提交后页面开始导航，旧文档里的 selector 仍然命中，
   于是读/截到的是导航后的新页。必须等「readyState=complete 且 body 文本长度稳定」。

6. **同一 profile 不能起第二个 Chrome**：单例锁会把新进程变成"把 URL 转给已有实例然后退出"，
   `--remote-debugging-port` 自然起不来。

7. **`pkill -f <pattern>` 会匹配到执行它的 shell 自己**，用 `pkill -f 'cua-[a-z0-9]'` 规避。

8. **目标输入框开着中文输入法时，ASCII 会进入候选串**（composition）而不是直接上屏，
   这是真实环境行为，不是插件 bug。

## License

MIT
