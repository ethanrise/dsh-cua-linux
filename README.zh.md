# dsh-cua-linux（中文）

[English](README.md)

给 DeepSeek Harness 补上 Linux（X11 / XWayland）的 computer-use 后端。

## 安装

```sh
dsh plugin add ethanrise/dsh-cua-linux
```

要求：X11 会话（或 XWayland）、Node ≥ 22.18。AT-SPI 工具需要系统 Python 3 和 GObject/AT-SPI 绑定（Ubuntu/Debian 对应 `python3-gi`、`gir1.2-atspi-2.0`）。X11 和 CDP 工具可独立运行。

## 操作通道

| 通道 | 适用 | 原理 |
|---|---|---|
| **CDP** | Chromium / Edge / Electron 页面 | DevTools Protocol，走 Node 内置 `fetch` + `WebSocket`，零依赖 |
| **AT-SPI** | 暴露可访问控件的桌面应用 | 按窗口读控件树、执行控件动作、写入并读回 Unicode |
| **X11** | 其他一切 | 纯 JS 的 `x11` 包直连 X server，XTEST 注入 |

浏览器场景不要用像素：selector 定位、`insertText` 免输入法、视口坐标与窗口是否可见无关。
实测同一个搜索任务，X11 通道输中文要 1263ms（剪贴板握手），CDP 是 `insertText` 立即完成。

## 桌面操作流程

1. 用 `cua_linux_windows` 找到目标窗口，再用 `cua_linux_observe` 读取控件。
2. 将返回的快照和元素 ID 传给 `cua_linux_element`，执行控件动作或替换文本。动作后重新观察，文本替换会报告读回是否一致。
3. 控件缺失时，用 `cua_linux_screenshot` 截图并按坐标操作。截图前可用 `cua_linux_activate` 激活窗口并确认焦点，避免点击浏览器标签栏。支持图像且配置附件存储的 DSH 模型可以直接收到截图。点击和滚动会校验指针命中。键盘工具传入 `wid` 后会校验焦点。可用 `cua_linux_paste` 粘贴 Unicode，工具会替换系统剪贴板。
4. X11 动作后会短时采样画面，有像素变化时提前返回。动画也会引起变化，继续操作前仍需确认实际结果。

## 已知边界

- **只支持 X11**。原生 Wayland 窗口收不到 XTEST 事件；`cua_linux_probe` 会报告 `/dev/uinput`
  和 libei 的可用性，Wayland 后端尚未实现
- **窗口和控件覆盖取决于应用**。AT-SPI 按 X11 窗口的 PID 和标题匹配。窗口唯一时，也可匹配其子进程暴露的同名控件树。X11 截图取自可见桌面，会包含遮挡。
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
