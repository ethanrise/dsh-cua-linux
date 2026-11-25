/**
 * verify.js —— 动作生效的判定原语。
 *
 * 为什么需要它：注入类工具最大的问题是「静默成功」——点没点中、输没输进去、
 * 页面跳没跳，接口都返回 success。模型看不到界面变化，就会在错误的状态上继续操作，
 * 错误还会累积。所以每个动作至少要留下一条可复核的痕迹。
 */

/**
 * 逐像素比较两张 RGBA，返回变化比例。threshold 用来吃掉抗锯齿/光标噪声。
 * opts.width + opts.box 可只比一块区域（在整帧缓冲上切片，不需要额外抓图）。
 * @param {Buffer} a
 * @param {Buffer} b
 * @param {number} threshold
 * @param {{width?:number, box?:{x:number,y:number,w:number,h:number}}} opts
 */
export function diffRGBA(a, b, threshold = 8, opts = {}) {
  if (!a || !b) return null
  if (a.length !== b.length) return { changed: Infinity, ratio: 1, incomparable: true }

  const { width, box } = opts
  const fullFrame = !box || !width
  let x0 = 0, y0 = 0, x1 = 0, y1 = 0
  if (fullFrame) {
    x1 = a.length / 4
  } else {
    const fh = a.length / (width * 4)
    x0 = Math.max(0, Math.floor(box.x))
    y0 = Math.max(0, Math.floor(box.y))
    x1 = Math.min(width, Math.ceil(box.x + box.w))
    y1 = Math.min(fh, Math.ceil(box.y + box.h))
    if (x1 <= x0 || y1 <= y0) return { changed: 0, total: 0, ratio: 0, empty: true }
  }

  let changed = 0
  let total = 0
  if (fullFrame) {
    for (let i = 0; i < a.length; i += 4) {
      total++
      if (Math.abs(a[i] - b[i]) > threshold ||
          Math.abs(a[i + 1] - b[i + 1]) > threshold ||
          Math.abs(a[i + 2] - b[i + 2]) > threshold) changed++
    }
  } else {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4
        total++
        if (Math.abs(a[i] - b[i]) > threshold ||
            Math.abs(a[i + 1] - b[i + 1]) > threshold ||
            Math.abs(a[i + 2] - b[i + 2]) > threshold) changed++
      }
    }
  }
  return { changed, total, ratio: total ? changed / total : 0 }
}

/**
 * 把变化比例翻译成一句人话 + 一个判断。
 * @param {{ratio:number, changed:number}} d
 * @param {{minRatio?:number, label?:string}} opts
 */
export function judgeVisual(d, { minRatio = 0.0005, label = '界面' } = {}) {
  if (!d) return { verified: null, text: `${label}：无基线可比较` }
  if (d.incomparable) return { verified: null, text: `${label}：前后分辨率不一致，无法比较` }
  const pct = (d.ratio * 100).toFixed(2)
  if (d.ratio >= minRatio) {
    return { verified: true, text: `${label}发生变化（${d.changed} 像素 / ${pct}%）` }
  }
  return {
    verified: false,
    // 措辞很重要：动作**已经发出**，只是没观察到变化。写成"失败"会诱导模型重试，
    // 在已聚焦/重复点击这类场景下重试反而危险。
    text: `${label}无变化（${d.changed} 像素 / ${pct}%）——动作已发出，但未观察到界面反馈；可能是重复操作、目标不可交互，或该操作本就不改画面`,
  }
}

/**
 * 判定一个区域在**动作之前**是否本身就在变（光标闪烁、加载动画、视频）。
 * 不稳的区域上做前后比对没有意义，必须如实说"无法判定"，而不是随便给个 ✓/⚠。
 */
export function judgeStability(d, { noiseRatio = 0.0008 } = {}) {
  if (!d) return { stable: null, text: '区域稳定性：无基线' }
  if (d.incomparable) return { stable: null, text: '区域稳定性：尺寸不一致' }
  if (d.ratio >= noiseRatio) {
    return {
      stable: false,
      text: `动作前该区域就在变化（${(d.ratio * 100).toFixed(2)}%）——光标闪烁/动画/视频，无法据画面判定`,
    }
  }
  return { stable: true, text: '区域稳定' }
}

/**
 * 两级判定（信噪比思路）：
 *   noise  = 动作前该区域自身的变化率（光标闪烁/动画）
 *   signal = 动作后相对"动作前最后一帧"的变化率
 *
 * 判定顺序：
 *   1. signal 显著高于 noise（>5 倍且超过绝对阈值）→ 动作确实改变了画面
 *   2. noise 本身就大 → 无法判定（不猜）
 *   3. 区域没变但整窗变了 → 影响在别处，仍算生效
 *   4. 都没有 → 警告"已发出但无反馈"
 */
export function judgeTwoTier({ noise = 0, signal, window: winDiff, areaLabel = '点击处' }) {
  const sig = signal || {}
  const sigRatio = sig.ratio || 0
  if (sigRatio > 0.0005 && sigRatio > noise * 5) {
    return { verified: true, text: `${areaLabel}发生变化（${sig.changed || 0} 像素 / ${(sigRatio * 100).toFixed(2)}%）` }
  }
  // 分档：噪声很小时（光标闪烁约 0.1~0.3%）按"无变化"处理更有用；
  // 只有大面积动画（>0.5%，转圈/视频/滚动）才真的无法逐点比对。
  if (noise > 0.005) {
    return {
      verified: null,
      text: `无法判定：该区域本身在动（${(noise * 100).toFixed(2)}%），而动作带来的变化只有 ${(sigRatio * 100).toFixed(2)}%`,
    }
  }
  if (winDiff && winDiff.ratio !== undefined && winDiff.ratio > 0.0005) {
    return {
      verified: true,
      text: `${areaLabel}本身没变，但窗口其他区域变化 ${(winDiff.ratio * 100).toFixed(2)}%——动作影响在别处（弹窗/列表刷新等）`,
    }
  }
  return {
    verified: false,
    text: `${areaLabel}与窗口均无变化——动作已发出但未观察到反馈；可能是重复操作、目标不可交互，或该操作本就不改画面`,
  }
}

/** DOM 侧：装一个 MutationObserver 计数器，动作后读突变数与 URL 变化。 */
export const WATCH_BEGIN = `(() => {
  window.__cuaMut = 0;
  window.__cuaUrl = location.href;
  if (!window.__cuaMo) {
    window.__cuaMo = new MutationObserver((ms) => { window.__cuaMut += ms.length });
    window.__cuaMo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }
  return true;
})()`

export const WATCH_READ = `(() => ({
  mutations: window.__cuaMut || 0,
  urlChanged: (window.__cuaUrl || '') !== location.href,
  url: location.href,
}))()`

/**
 * 把 DOM 侧观测结果翻译成判定。
 * 注意：0 突变不代表失败——有些操作（聚焦、选中）不产生 DOM 突变。
 */
export function judgeDom(w, { minMutations = 1 } = {}) {
  if (!w) return { verified: null, text: '页面：未取得观测' }
  if (w.urlChanged) return { verified: true, text: `页面发生导航 → ${w.url}` }
  if (w.mutations >= minMutations) {
    return { verified: true, text: `DOM 有 ${w.mutations} 处变化` }
  }
  return {
    verified: false,
    text: `DOM 无变化（0 处突变、URL 未变）——可能点到了不可交互区域，或该操作本就不产生 DOM 变化`,
  }
}
