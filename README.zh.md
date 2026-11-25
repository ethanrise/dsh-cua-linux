# dsh-cua-linux（中文）

[English](README.md)

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

三种结论刻意分开，实测输出如下（工具报文统一用英文，便于国际化）：

```
✓ Area around the action point changed (7471 px / 31.21%)      生效
⚠ nothing changed around the action point or elsewhere …        已发出但无反馈
? Undecidable: the region changes on its own (1.20%) …          无法判定（转圈/视频）
```

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
