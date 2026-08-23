/**
 * sidebar.js - Webview 前端交互逻辑
 *
 * **渲染架构：**
 * ClassDoc 数据按源码顺序渲染，两层结构：
 *   1. 类型卡片（可折叠） — class/interface/enum 各一个卡片
 *   2. 成员列表（源码顺序） — 合并 methods + fields + enumConstants，按 startLine 排序
 *
 * 每个成员用类型徽章标注：C=构造函数 M=方法 F=字段 E=枚举常量
 * Unknown 卡片显示文件级声明，虚线边框样式与真实类型区分。
 *
 * @author xiaowu
 * @since 2026/02/04
 */

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  // #region debug-point X:report-helper
  // 调试插桩：webview 受 CSP（default-src 'none'）限制，日志经 postMessage
  // 上报扩展宿主，由扩展侧打印到 F5 调试面板的 Debug Console（仅调试会话期间存在）
  function __dbg(hyp, loc, msg, data) {
    try {
      console.log('[CS-DEBUG]', 'hyp=' + hyp, 'loc=' + loc, 'msg=' + msg, data || {});
      vscode.postMessage({ type: '__debug', payload: { hyp: hyp, loc: loc, msg: msg, data: data || {} } });
    } catch (e) { /* 调试上报失败不影响业务 */ }
  }
  // #endregion

  // ========== 状态 ==========
  let currentClassDoc = null;
  let currentMarkdownImageMap = {};
  const collapsedMethods = new Set();
  const collapsedTypeGroups = new Set(); // 记录被折叠的类型组（多类型文件）
  // 视图模式初始值由扩展注入 <body data-view-mode="compact|detail">，
  // 源自 globalState（跨会话记忆用户偏好）；缺省为简洁模式（true）
  let isCompactMode = document.body.dataset.viewMode !== 'detail';
  let isLocked = false;
  // 当前高亮目标（用于切换视图模式后恢复焦点）
  // { kind: 'method', id } | { kind: 'field', line } | null
  let currentHighlight = null;
  // 用户主动滚动侧边栏的最近时间戳（Date.now()）。
  // 点击卡片跳转后编辑器会回传高亮消息触发 scrollToItem 居中定位；若用户在
  // 跳转后立即拖动侧边栏，须抑制这次自动定位以免"弹回原地"。仅"用户真的滚动过"
  // （handleSidebarScroll 的用户路径）才记录时间戳并抑制，点击本身不抑制——
  // 否则点击卡片永远无法自动滚动居中。
  let lastUserScrollAt = 0;
  const USER_SCROLL_SUPPRESS_MS = 400;
  // 滚动同步：防止反馈循环的标志
  let isScrollingFromExtension = false;
  // 节流状态（sidebar → editor 方向）
  let sidebarScrollThrottleId = null;
  let sidebarScrollLastFire = 0;
  const SIDEBAR_SCROLL_THROTTLE_MS = 30;
  // 当前是否为 Markdown 预览模式（决定是否允许反向同步）
  let isMarkdownMode = false;
  // 内容放大预览（全屏遮罩）是否打开：打开期间暂停滚动同步与交互
  let isPreviewOpen = false;
  // 预览层状态（null 表示未打开）：
  // { overlay, viewport, content, scale, tx, ty, naturalW, naturalH, dragState }
  let previewState = null;
  // 常驻顶栏高度：锚点 y 预减此值，使目标卡片自然落在顶栏下方
  const STICKY_HEADER_HEIGHT = 35;
  // 外层驻留卡片头高度：.type-group-header min-height: 40px，滚动时驻留在
  // 顶栏下方（top: 35px）。成员卡片位于类型卡片内，锚点需连同此高度一并清开，
  // 否则超长卡片顶部对齐时会被驻留的类型头遮住。
  const TYPE_GROUP_HEADER_HEIGHT = 40;
  // 滚动锚点缓存（内容重新渲染时失效）
  // scrollAnchorsCache 按 line 升序（正向插值用）
  // scrollAnchorsByY 按 y 升序（反向插值用，解耦 line/y 排序假设）
  let scrollAnchorsCache = null;
  let scrollAnchorsByY = null;
  // 平滑滚动动画状态（编辑器→侧边栏同步使用 RAF 缓动追逐目标）
  let scrollRafId = null;
  let scrollTargetY = 0;
  // 缓动系数：每帧追近目标的 25%，约 4-6 帧（70-100ms）收敛，兼顾平滑与跟手
  const SCROLL_EASE_FACTOR = 0.25;

  // ========== 初始化 ==========
  /**
   * 根据编辑器明暗 + 用户设置（body[data-hljs-dark/light]）启用对应的
   * 代码高亮主题样式表。所有主题的 <link> 预加载进 HTML，只启用一套。
   */
  function updateHljsTheme() {
    const isLight =
      document.body.classList.contains('vscode-light') ||
      document.body.classList.contains('vscode-high-contrast-light');
    const themeName = isLight
      ? document.body.dataset.hljsLight
      : document.body.dataset.hljsDark;
    const enabledId = themeName ? 'hljs-' + themeName : '';
    document.querySelectorAll('link[id^="hljs-"]').forEach(function (link) {
      link.disabled = link.id !== enabledId;
    });
  }

  function init() {
    window.addEventListener('message', handleMessage);
    // #region debug-point D:errors
    // 运行时错误 / 未处理 Promise 拒绝采集（崩溃现场）
    window.addEventListener('error', function (e) {
      __dbg('D', 'window.onerror', 'uncaught error', { message: e.message, file: e.filename, line: e.lineno, stack: (e.error && e.error.stack) || '' });
    });
    window.addEventListener('unhandledrejection', function (e) {
      __dbg('D', 'unhandledrejection', 'unhandled rejection', { reason: String(e.reason), stack: (e.reason && e.reason.stack) || '' });
    });
    // #endregion
    // #region debug-point B:css
    // 样式表与 body 主题 class 状态（判断 !important 覆盖是否就绪）
    __dbg('B', 'init', 'stylesheets & bodyClass', {
      bodyClass: document.body.className,
      links: Array.prototype.map.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) {
        return { href: (l.href || '').split('/').pop(), disabled: l.disabled };
      }),
    });
    // #endregion
    window.addEventListener('scroll', handleSidebarScroll, { passive: true });
    // 窗口尺寸变化时锚点位置失效，清空缓存下次重建
    window.addEventListener('resize', invalidateScrollAnchors);
    // Markdown 图片异步加载会改变布局高度，失效锚点缓存
    // load 事件不冒泡，用捕获阶段监听（capture: true）确保能收到
    root.addEventListener('load', function (e) {
      if (e.target && e.target.tagName === 'IMG') {
        invalidateScrollAnchors();
      }
    }, true);
    // 用户主动滚动时取消编辑器同步触发的平滑动画，避免与用户意图争夺控制权
    window.addEventListener('wheel', cancelScrollAnimation, { passive: true });
    window.addEventListener('touchstart', cancelScrollAnimation, { passive: true });
    window.addEventListener('keydown', function (e) {
      if (
        e.key === 'PageUp' || e.key === 'PageDown' ||
        e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
        e.key === 'Home' || e.key === 'End' || e.key === ' '
      ) {
        cancelScrollAnimation();
      }
    });
    // 预览层 Esc 退出
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isPreviewOpen) {
        closePreview();
      }
    });
    // 预览层全局拖拽平移（持久监听，通过 previewState 判活，避免重复绑定）
    window.addEventListener('mousemove', function (e) {
      const s = previewState;
      if (!s || !s.dragState) return;
      s.tx = s.dragState.tx + (e.clientX - s.dragState.startX);
      s.ty = s.dragState.ty + (e.clientY - s.dragState.startY);
      applyPreviewTransform();
    });
    window.addEventListener('mouseup', function () {
      const s = previewState;
      if (!s || !s.dragState) return;
      s.dragState = null;
      s.viewport.classList.remove('dragging');
    });
    // 点击监听在初始化时绑定一次，确保代码和 Markdown 模式下都生效
    bindEvents();
    // 编辑器明暗（vscode-light/dark）变化时，重新选择启用的代码高亮主题
    new MutationObserver(updateHljsTheme).observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
    updateHljsTheme();
    const lockBtn = document.getElementById('lock-btn');
    if (lockBtn) {
      lockBtn.addEventListener('click', toggleLock);
    }
    const viewToggle = document.getElementById('viewToggle');
    if (viewToggle) {
      viewToggle.addEventListener('click', toggleViewMode);
    }
    updateLockButton();
    updateViewToggle();

    // 调试面板关闭按钮
    var debugClose = document.getElementById('debug-close');
    if (debugClose) {
      debugClose.addEventListener('click', hideDebugPanel);
    }

    // 注册 KaTeX 渲染回调 —— KaTeX auto-render 加载完成后调用。
    // scope 参数：注释 / Markdown 预览 / 放大预览三处共用；KaTeX 未加载时
    // 统一降级为源码样式（.md-math-fallback），避免原始 $..$ / $$..$$ 裸露在
    // 正文中造成渲染效果不一致。
    window.__renderMath = function (scope) {
      scope = scope || root;
      try {
        if (window.renderMathInElement && scope) {
          // 清除此前降级标记，KaTeX 就绪后恢复标准渲染形态
          scope.querySelectorAll('.md-math-fallback').forEach(function (el) {
            el.classList.remove('md-math-fallback');
          });
          window.renderMathInElement(scope, {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '$', right: '$', display: false },
            ],
            throwOnError: false,
          });
          // KaTeX 渲染会改变行高/布局，失效锚点缓存
          invalidateScrollAnchors();
        } else if (scope) {
          // KaTeX 未加载：统一降级为源码样式（重复调用只打标一次）
          scope.querySelectorAll('.md-math-block:not(.md-math-fallback), .md-math-inline:not(.md-math-fallback)')
            .forEach(function (el) {
              el.classList.add('md-math-fallback');
            });
        }
      } catch (e) {
        // #region debug-point D:katex
        __dbg('D', '__renderMath.catch', 'katex render failed', { err: String((e && e.message) || e) });
        // #endregion
        // KaTeX 未加载或渲染失败，静默忽略
      }
    };

    // 注册 Mermaid 初始化回调 —— mermaid.js 加载完成后调用
    window.__initMermaid = function () {
      try {
        if (window.mermaid) {
          const isLight = document.body.classList.contains('vscode-light');
          // #region debug-point A:theme
          // 主题判定观测：isLight 是否与真实主题一致（深色下误判为浅色会产生黑箭头/黑文字）
          (function () {
            var tv = null;
            try { tv = window.mermaid.mermaidAPI.getConfig().themeVariables; } catch (e) { /* ignore */ }
            __dbg('A', '__initMermaid', 'theme decide', {
              isLight: isLight,
              theme: isLight ? 'default' : 'dark',
              bodyClass: document.body.className,
              noteBorderColor: tv ? tv.noteBorderColor : null,
              signalColor: tv ? tv.signalColor : null,
              sequenceNumberColor: tv ? tv.sequenceNumberColor : null,
            });
          })();
          // #endregion
          window.mermaid.initialize({
            startOnLoad: false,
            theme: isLight ? 'default' : 'dark',
            securityLevel: 'loose',
            themeVariables: isLight ? {
              primaryColor: '#e8f0fe',
              primaryTextColor: '#1e1e1e',
              primaryBorderColor: '#4a90d9',
              secondaryColor: '#f0f0f0',
              tertiaryColor: '#ffffff',
              // 提高连线对比度：浅色背景用深灰，避免 #555 在浅色节点旁偏淡
              lineColor: '#333333',
              textColor: '#1e1e1e',
              edgeLabelBackground: '#ffffff',
              // sequenceDiagram 消息线颜色：与 lineColor 一致，避免深色主题下箭头偏黑
              signalColor: '#333333',
              signalTextColor: '#1e1e1e',
              clusterBkg: 'rgba(0,0,0,0.05)',
              clusterBorder: '#888',
              // subgraph 标题文字色：显式设置避免主题回退到不可读颜色
              clusterTextColor: '#1e1e1e',
              // 浅色主题下显式声明 note/alt/标签框与序列号颜色，与深色分支保持
              // 一致的习惯，避免切换主题时出现隐性漂移
              noteBorderColor: '#888',
              noteBkgColor: '#f6f6f6',
              noteTextColor: '#1e1e1e',
              labelBoxBkgColor: '#f6f6f6',
              labelBoxBorderColor: '#4a90d9',
              altBackground: '#f0f0f0',
              activationBkgColor: '#e8f0fe',
              sequenceNumberColor: '#333',
              fontFamily: 'var(--vscode-editor-font-family)',
            } : {
              primaryColor: '#1e3a5f',
              primaryTextColor: '#e0e0e0',
              primaryBorderColor: '#5a9fd4',
              secondaryColor: '#2a2a2a',
              tertiaryColor: '#333333',
              // 提高连线对比度：深色背景用更亮的灰，避免 #bbb 在深色节点旁偏暗
              lineColor: '#cccccc',
              textColor: '#e0e0e0',
              edgeLabelBackground: '#2a2a2a',
              // sequenceDiagram 消息线颜色：深色主题下默认 signalColor 偏黑，
              // 显式设为亮灰保证箭头线条清晰可见
              signalColor: '#cccccc',
              signalTextColor: '#e0e0e0',
              clusterBkg: 'rgba(255,255,255,0.05)',
              clusterBorder: '#777',
              // subgraph 标题文字色：深色主题下默认回退为黑色，显式设为亮色保证可读
              clusterTextColor: '#e0e0e0',
              // 深色主题内置 noteBorderColor 为近黑（hsl 18%），note/alt 框边框在
              // 深底上几乎不可见，文字像浮在框外；显式提亮边框与背景色修正
              noteBorderColor: '#888',
              noteBkgColor: 'rgba(255,255,255,0.08)',
              noteTextColor: '#e0e0e0',
              // flowchart 标签框默认背景 #1f2020 与节点背景同色，提亮区分
              labelBoxBkgColor: '#1e3a5f',
              labelBoxBorderColor: '#5a9fd4',
              // sequenceDiagram alt 框 / 激活框 / 序列号：覆盖 dark 内置的
              // altBackground #555、activationBkgColor 深灰、sequenceNumberColor black
              altBackground: '#333333',
              activationBkgColor: '#2a4a6a',
              sequenceNumberColor: '#e0e0e0',
              fontFamily: 'var(--vscode-editor-font-family)',
            },
          });
          // 初始化后立即渲染待处理的图表（修复竞态：mermaid 加载晚于内容渲染）
          if (window.__renderMermaid) window.__renderMermaid();
        }
      } catch (e) {
        // mermaid 初始化失败，静默忽略
      }
    };

    // 监听主题变化，重新初始化 Mermaid 主题
    const themeObserver = new MutationObserver(function () {
      if (window.mermaid && window.__initMermaid) {
        window.__initMermaid();
      }
    });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // 渲染 Mermaid 图表。
    // scope 参数：注释 / Markdown 预览 / 放大预览三处共用；mermaid 未加载时
    // 统一降级为源码样式（.md-mermaid-fallback），与放大预览的源码兜底表现
    // 一致，避免原始图表源码裸露造成观感不一致。
    window.__renderMermaid = function (scope) {
      scope = scope || root;
      try {
        if (window.mermaid && scope) {
          const elements = scope.querySelectorAll('.mermaid:not([data-processed])');
          if (elements.length > 0) {
            // 渲染前缓存图表源码：mermaid.run 会用 SVG 覆盖 pre.mermaid 内容，
            // 放大预览需要从源码重新矢量渲染，先保存到容器上
            elements.forEach(function (pre) {
              const container = pre.closest('.md-mermaid');
              if (container) {
                container.__mermaidSource = pre.textContent;
              }
            });
            // mermaid 异步渲染 SVG，完成后高度变化，失效锚点缓存。
            // catch：mermaid.run 的 promise 可能被拒绝（语法错误/渲染异常），
            // 不捕获会产生 unhandled rejection；失败时保留降级标记（源码样式兜底），
            // 仅在成功时由 finally 移除
            var rendered = false;
            Promise.resolve(window.mermaid.run({ nodes: elements })).then(function () {
              // #region debug-point C:computed
              // 渲染后采样关键元素的计算色：sidebar.css !important 覆盖是否真实命中
              (function () {
                var samples = [];
                elements.forEach(function (pre) {
                  var svg = pre.querySelector('svg');
                  if (!svg) return;
                  var pick = function (sel) {
                    var el = svg.querySelector(sel);
                    if (!el) return null;
                    var cs = window.getComputedStyle(el);
                    return { fill: cs.fill, stroke: cs.stroke };
                  };
                  samples.push({
                    cls: (pre.closest('.md-mermaid') && pre.closest('.md-mermaid').className) || '',
                    marker: pick('.marker'),
                    arrowMarkerPath: pick('.arrowMarkerPath'),
                    edgePath: pick('.edgePath path'),
                    flowLink: pick('path.flowchart-link'),
                    messageLine0: pick('.messageLine0'),
                    transition: pick('.transition'),
                    relation: pick('.relation'),
                    note: pick('.state-note') || pick('.note') || pick('.statediagram-note rect'),
                    text: pick('text'),
                  });
                });
                __dbg('C', '__renderMermaid.afterRun', 'computed colors', { count: samples.length, samples: samples });
              })();
              // #endregion
              rendered = true;
            }).catch(function (err) {
              // #region debug-point E:reject
              __dbg('E', '__renderMermaid.catch', 'mermaid.run rejected', { err: String((err && err.message) || err), stack: (err && err.stack) || '' });
              // #endregion
              // 渲染失败：给容器补回降级标记，保持与未加载一致的源码样式兜底
              scope.querySelectorAll('.md-mermaid:not(.md-mermaid-fallback)').forEach(function (el) {
                el.classList.add('md-mermaid-fallback');
              });
            }).finally(function () {
              if (rendered) {
                scope.querySelectorAll('.md-mermaid-fallback').forEach(function (el) {
                  el.classList.remove('md-mermaid-fallback');
                });
              }
              invalidateScrollAnchors();
            });
          }
        } else if (scope) {
          // Mermaid 未加载：统一降级为源码样式（重复调用只打标一次）
          scope.querySelectorAll('.md-mermaid:not(.md-mermaid-fallback)').forEach(function (el) {
            el.classList.add('md-mermaid-fallback');
          });
        }
      } catch (e) {
        // mermaid 渲染失败，静默忽略
      }
    };

    // highlight.js 代码高亮回调
    // 统一使用 highlightElement：注释、Markdown 预览、放大预览三处渲染一致
    // Markdown 预览代码块的 pre 仍保留 data-line/data-line-end 块级锚点（用于滚动联动）
    window.__highlightCode = function (scope) {
      scope = scope || root;
      try {
        if (window.hljs && scope) {
          let changed = false;
          scope.querySelectorAll('pre.md-code-block code').forEach(function (block) {
            if (block.dataset.highlighted) return;
            window.hljs.highlightElement(block);
            block.dataset.highlighted = 'true';
            changed = true;
          });
          // 高亮 token 可能改变行高，失效锚点缓存
          if (changed) invalidateScrollAnchors();
        }
      } catch (e) {
        // 高亮失败，静默忽略
      }
    };

    vscode.postMessage({ type: 'webviewReady' });
  }

  /**
   * 统一触发三方异步增强渲染（KaTeX / Mermaid / highlight.js）。
   *
   * 注释渲染、Markdown 文件预览、放大预览三处共用同一入口，
   * 保证渲染时机与降级表现一致：组件未加载时由各回调统一降级为源码样式。
   *
   * @param scope - 目标容器（缺省为 #root）
   */
  function applyAsyncEnhancers(scope) {
    scope = scope || root;
    if (window.__renderMath) window.__renderMath(scope);
    if (window.__renderMermaid) window.__renderMermaid(scope);
    if (window.__highlightCode) window.__highlightCode(scope);
  }

  /**
   * 本地 vendor 组件（KaTeX / Mermaid / highlight.js）加载失败提示。
   *
   * 挂在 body 下而非 #root 内，不随内容重渲染丢失；提示一次后可手动关闭。
   * 组件缺失时各渲染回调已统一降级为源码样式，此处仅作显式告知，避免静默失败。
   *
   * @param name - 组件显示名（公式 / 图表 / 代码高亮）
   */
  window.__vendorError = function (name) {
    try {
      if (document.getElementById('vendor-error-notice')) return;
      const notice = document.createElement('div');
      notice.id = 'vendor-error-notice';
      notice.className = 'vendor-error-notice';
      const text = document.createElement('span');
      text.textContent = name + '组件未加载，相关内容将以源码形式展示';
      const closeBtn = document.createElement('button');
      closeBtn.className = 'vendor-error-close';
      closeBtn.title = '关闭';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', function () {
        notice.remove();
      });
      notice.appendChild(text);
      notice.appendChild(closeBtn);
      document.body.appendChild(notice);
    } catch (e) {
      // 提示失败不影响主体功能
    }
  };

  /**
   * 跳转到代码行（用户点击卡片触发的跳转）。
   * 不在此抑制侧边栏自动定位——是否抑制由"用户是否真的滚动过侧边栏"决定
   * （见 handleSidebarScroll 的 lastUserScrollAt 与 USER_SCROLL_SUPPRESS_MS）。
   */
  function jumpToLine(line) {
    vscode.postMessage({ type: 'jumpToLine', payload: { line } });
  }

  // ========== 滚动同步 ==========

  /**
   * 平滑滚动侧边栏到目标位置（RAF 缓动追逐）。
   *
   * 编辑器滚动时高频触发同步，若用浏览器原生 behavior:'smooth' 会因
   * 动画无法干净打断而抖动。此处用 requestAnimationFrame 自定义缓动：
   * 每帧向目标追近 SCROLL_EASE_FACTOR，动画进行中仅更新目标不重启，
   * 让侧边栏像有惯性般平滑跟随编辑器。
   *
   * 每帧 scrollTo 前标记 isScrollingFromExtension，屏蔽随之而来的
   * 侧边栏 scroll 事件，避免 Markdown 模式下触发反向同步形成反馈循环。
   *
   * 用户主动滚动（wheel/touch/滚动键）时通过 cancelScrollAnimation 取消，
   * 避免动画与用户意图争夺滚动控制权。
   *
   * @param targetY - 目标滚动位置（已含偏移调整）
   */
  function animateScrollTo(targetY) {
    scrollTargetY = Math.max(0, targetY);
    // 动画进行中：仅更新目标，让正在跑的缓动循环追逐新位置
    if (scrollRafId !== null) return;

    // 动画自律检测：记录"上一帧预期的滚动落点"。若下一帧实际滚动位置
    // 偏离预期（>1px 容差，覆盖 scrollTo 取整误差），说明用户主动滚动
    // 介入（拖动滚动条/滚轮/触摸），立即停止动画让位用户，避免被弹回。
    // 不依赖 scroll 事件与 isScrollingFromExtension 标志判定（拖滚动条
    // 的 scroll 事件会被动画帧的标志误判，导致取消失效）。
    let prevTargetY = window.scrollY;

    function step() {
      const current = window.scrollY;
      if (Math.abs(current - prevTargetY) > 1) {
        scrollRafId = null;
        return;
      }
      const diff = scrollTargetY - current;
      // 收敛判定：差距不足 0.5px 视为到达，精确归位后结束
      if (Math.abs(diff) < 0.5) {
        isScrollingFromExtension = true;
        window.scrollTo(0, scrollTargetY);
        scrollRafId = null;
        return;
      }
      const next = current + diff * SCROLL_EASE_FACTOR;
      prevTargetY = next;
      isScrollingFromExtension = true;
      window.scrollTo(0, next);
      scrollRafId = requestAnimationFrame(step);
    }
    scrollRafId = requestAnimationFrame(step);
  }

  /**
   * 取消正在进行的平滑滚动动画（用户主动滚动时调用）。
   */
  function cancelScrollAnimation() {
    if (scrollRafId !== null) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
    }
  }

  /**
   * 侧边栏可视区域（sticky header 下缘到视口底部）的垂直中心。
   *
   * 同步滚动以"中间对齐"为基准：目标锚点位置（buildScrollAnchors 编码的
   * 元素内偏移点，行/卡片中间或距顶部半屏处）对齐到该位置，使"编辑器
   * 屏幕中间的内容"恰好出现在"侧边栏可视区域中间"。
   *
   * @returns {number} 可视区域中心的 y（相对视口顶部）
   */
  function getViewportMidY() {
    return (window.innerHeight - STICKY_HEADER_HEIGHT) / 2;
  }

  /**
   * 目标卡片上方需要清开的 sticky 元素总高度。
   *
   * 滚动时存在两层驻留：
   *   1. 常驻顶栏（#sticky-header，top: 0，高约 STICKY_HEADER_HEIGHT）
   *   2. 外层驻留卡片头（.type-group-header，top: 35px，高约
   *      TYPE_GROUP_HEADER_HEIGHT）——仅对位于类型卡片内的成员生效
   *      （.method-item / .field-item）；.type-group 卡片自身、文件头注释
   *      （.class-comment）与 Markdown 逐行锚点不在类型卡片内，不受其遮挡，
   *      只需清开常驻顶栏。
   *
   * @param {Element|null} el - 目标锚点元素（[data-line] / [data-line-end] 承载者）
   * @returns {number} 需要预减的 sticky 总高度
   */
  function getStickyStackHeight(el) {
    const group = el && el.closest ? el.closest('.type-group') : null;
    // 自身是类型卡片（.type-group）时，其顶部即卡片头，只需清开常驻顶栏
    const inTypeGroup = !!group && group !== el;
    return STICKY_HEADER_HEIGHT + (inTypeGroup ? TYPE_GROUP_HEADER_HEIGHT : 0);
  }

  /**
   * 处理来自编辑器的滚动同步消息。
   *
   * 代码文件和 Markdown 均使用锚点线性插值：
   * 以编辑器可见区域中间行为基准，映射到侧边栏对应元素锚点位置，
   * 并以"中间对齐"滚动（锚点落在可视区域垂直中心，行/卡片内容垂直居中）。
   * 开头无缝衔接：编辑器滚到文件开头时侧边栏同步滚到开头（0）。
   * 编辑器顶部在开头过渡区（约半屏行数）内时，目标位置在"顶部 0"与
   * "正常中间对齐"之间线性混合，避免"中间对齐"把开头内容钉在可视中心、
   * 侧边栏停在半路，也避免 topLine 0→1 时从 0 直接跳变到正常插值位置。
   * 不切换聚焦 —— 聚焦仅由光标位置变化驱动。
   *
   * @param payload - { topLine, bottomLine, totalLines } 编辑器可见区域
   */
  function handleSyncScroll(payload) {
    // 预览打开期间阻塞编辑器→侧边栏滚动同步
    if (isPreviewOpen) return;
    if (!payload) return;
    const topLine = payload.topLine;
    const bottomLine = payload.bottomLine;
    if (typeof topLine !== 'number') return;

    const anchors = buildScrollAnchors();
    if (anchors.length === 0) return;

    // 开头过渡区（编辑器行数）：编辑器顶部从 0 滚过约"半屏行数"期间，
    // 目标位置在"顶部 0"与"正常中间对齐"之间线性混合，保证与顶部特殊
    // 处理无缝衔接（bottomLine 无效时回退 20 行）。
    const viewportLines = (typeof bottomLine === 'number' && bottomLine > topLine)
      ? bottomLine - topLine
      : null;
    const blendZone = viewportLines ? Math.max(8, viewportLines / 2) : 20;
    // 过渡比例 t：topLine=0 → 0（完全顶部对齐 0），topLine=blendZone → 1（完全正常插值）
    const t = Math.max(0, Math.min(1, topLine / blendZone));

    // 以编辑器可见区域中间行为基准（而非顶部行），
    // 与侧边栏"可视区域中间对齐"的目标严格对称。
    // 优先使用扩展端算出的视觉中心行（小数行号）：自动折行下长逻辑行
    // 占多个可视行，(topLine + bottomLine) / 2 是逻辑行中位数而非视觉
    // 中心，折行严重时中心会落在长行中部，导致侧边栏上下跳。
    const midLine = typeof payload.centerLine === 'number'
      ? payload.centerLine
      : (typeof bottomLine === 'number' ? (topLine + bottomLine) / 2 : topLine);
    const anchorY = interpolateScrollPosition(anchors, midLine);
    if (anchorY === null) return;
    // 锚点即"对准可视中心的定位点"：已在 buildScrollAnchors 中编码元素内
    // 偏移（可容纳时锚点在元素中间、不可容纳时距元素顶部半屏；Markdown
    // 行锚点同样编码行中点），因此目标位置 = 锚点 - 可视中心，滚动后锚点
    // 恰好落在可视区域中心，元素顶部随之完整显示（短元素居中、超长元素
    // 顶部贴齐可视区域顶部）。
    const viewportMid = getViewportMidY();
    const normalY = anchorY - viewportMid;

    // 无缝衔接公式：targetY = max(0, normalY) * t。
    // normalY 随 midLine 单调不减、t 随 topLine 单调不减且两者均非负，
    // 乘积单调不减 → 从顶部 0 平滑逼近正常插值，无跳变、无回退。
    // t=0（编辑器在开头）时恒为 0；t=1（离开过渡区）后与纯中间对齐完全一致。
    const targetY = Math.max(0, normalY) * t;

    // 始终用 RAF 缓动追逐（平滑跟手）；用户主动滚动时由
    // cancelScrollAnimation 立即取消，不与用户意图争夺控制权
    animateScrollTo(targetY);
  }

  /**
   * 使滚动锚点缓存失效（DOM 布局变化后调用，下次同步时重建）。
   *
   * 折叠/展开卡片、KaTeX/Mermaid/highlight 异步渲染、窗口 resize 等都会改变
   * 侧边栏元素的高度或位置。若继续使用旧锚点，滚动同步会按过期布局插值而失真。
   */
  function invalidateScrollAnchors() {
    scrollAnchorsCache = null;
    scrollAnchorsByY = null;
  }

  /**
   * 构建滚动锚点列表。
   *
   * 每个锚点是一对 (sourceLine, y)，y = rect.top/bottom + scrollY - getStickyStackHeight(el)。
   * 卡片锚点（[data-line]）取元素顶部并叠加"对准可视中心的元素内偏移"；
   * 收尾锚点（[data-line-end]）取元素底部。
   * 预减目标元素上方需要清开的 sticky 总高度（常驻顶栏 + 外层驻留卡片头，
   * 见 getStickyStackHeight），使目标卡片在正向同步时自然落在 sticky 下方，
   * 且正/反向插值使用同一映射，严格对称（避免文件头区域双向漂移）。
   *
   * **data-line 只承载在非 sticky 元素上：** .method-header / .type-group-header
   * 是 position: sticky，被钉住时 rect.top 恒为 CSS top，rect.top + scrollY 会
   * 失真成"当前滚动位置"；若此时重建锚点缓存，污染值会成为 y 单调性过滤的
   * 分水岭，吞掉其后所有成员锚点（长文件越滚越偏的根因）。因此 data-line 统一
   * 放在非 sticky 的 .method-item / .type-group / .class-comment
   * 上，rect 测量恒为自然布局位置。
   *
   * **锚点以卡片为单位：** 每个卡片/成员只带一个 data-line 锚点（方法内容
   * .method-content 不再单独建锚点），锚点 y 编码"对准可视中心的元素内偏移"：
   * 元素可完全容纳（height/2 <= viewportMid）时锚点在元素中间（居中显示、
   * 顶部完整可见）；不可容纳时锚点距元素顶部半个可视区域高度（顶部贴齐
   * 可视区域顶部，顶部不溢出视口）。这样点击跳转后卡片顶部始终完整显示。
   * Markdown 逐行锚点（md-line / md-code-line）同样编码行中点偏移，行内容
   * 垂直居中于可视区域中心，双向同步与代码模式统一、严格对称。
   *
   * **同 line 去重：** 多个元素可能带相同 data-line（如 type-group 与其首个
   * 成员同起始行），同 line 不同 y 会污染反向插值。这里按 line 聚合，同 line
   * 保留最小 y（靠上的 item）。
   *
   * **y 单调性过滤：** 源码行号顺序与 DOM 渲染顺序不一致时（文件头注释与类注释
   * 之间的散落声明），按 line 排序后 y 可能非单调。这里剔除破坏 y 单调（允许相等）
   * 的锚点，保证插值永远非负斜率，从根上消除"编辑器往下滚、侧边栏反而向上滚"
   * 的反向现象。允许相等：连续成员"上一内容底部 data-line-end"与"下一成员头
   * data-line"可能精确相等，严格递增会稀疏化锚点、加剧插值非线性。
   *
   * **双排序缓存：** 正向（line→y）用按 line 升序的 scrollAnchorsCache；
   * 反向（y→line）用按 y 升序的 scrollAnchorsByY，解耦"line 与 y 必同序"的假设。
   *
   * **合成起点锚点：** 始终在开头插入 {line: 0, y: 0}，使文件头注释区域参与线性插值。
   *
   * @returns {Array<{line: number, y: number}>} 按行号排序的锚点列表
   */
  function buildScrollAnchors() {
    // 命中缓存：内容未重新渲染时直接复用，避免滚动时频繁 DOM 查询
    if (scrollAnchorsCache) return scrollAnchorsCache;

    // 收集两类锚点元素：
    //   [data-line]     卡片锚点 —— 卡片/成员/行起始，取元素顶部并叠加"对准可视中心的
    //                   元素内偏移"（可容纳时锚点在元素中间，不可容纳时距元素顶部半屏）
    //   [data-line-end] 收尾锚点 —— 文件头注释结束行 / Markdown 块结束行，取元素底部
    // 同 line 保留最小 y（靠上的 .method-item / .type-group / .class-comment）。
    // y 用 getBoundingClientRect + scrollY 计算文档绝对位置（替代 offsetTop，
    // 避免 offsetParent 非 body（存在 position 祖先）时定位偏差）。
    const lineToMinY = new Map(); // line -> y
    const elements = root.querySelectorAll('[data-line], [data-line-end]');
    for (const el of elements) {
      // 折叠的卡片/方法内容 display:none，无布局盒子，跳过避免污染锚点
      if (el.getClientRects().length === 0) continue;
      const rect = el.getBoundingClientRect();
      const docY = window.scrollY;
      // 卡片锚点 [data-line]：元素顶部（文件头注释起始行 / 卡片 / 成员）
      if (el.dataset.line !== undefined) {
        const line = parseInt(el.dataset.line, 10);
        if (!isNaN(line)) {
          // data-line 只承载在非 sticky 元素上（.type-group / .method-item /
          // .class-comment），rect.top + scrollY 恒为自然布局位置；
          // sticky 元素不再携带 data-line，避免被钉住时 y 失真成当前滚动位置。
          // 锚点位置编码"对准可视中心的元素内偏移"：
          //   元素可完全容纳（height/2 <= viewportMid）→ 锚点在元素中间，
          //   不可容纳 → 锚点距元素顶部半个可视区域高度（保证顶部不溢出视口）。
          //   Markdown 逐行锚点（行元素）同样编码行中点偏移，行内容垂直
          //   居中于可视区域中心，与代码模式统一、双向严格对称。
          const height = el.offsetHeight || 0;
          const anchorOffset = Math.min(height / 2, getViewportMidY());
          const y = rect.top + docY - getStickyStackHeight(el) + anchorOffset;
          const prev = lineToMinY.get(line);
          if (prev === undefined || y < prev) {
            lineToMinY.set(line, y);
          }
        }
      }
      // 收尾锚点 [data-line-end]：元素底部（文件头注释结束行 / Markdown 块结束行）
      if (el.dataset.lineEnd !== undefined) {
        const line = parseInt(el.dataset.lineEnd, 10);
        if (!isNaN(line)) {
          const y = rect.bottom + docY - getStickyStackHeight(el);
          const prev = lineToMinY.get(line);
          if (prev === undefined || y < prev) {
            lineToMinY.set(line, y);
          }
        }
      }
    }

    const anchors = [];
    for (const [line, y] of lineToMinY) {
      anchors.push({ line, y });
    }
    // 按 line 升序（正向插值用）
    anchors.sort((a, b) => a.line - b.line);
    // 合成起点锚点：确保文件头注释区域参与线性滚动
    if (anchors.length === 0 || anchors[0].line > 0) {
      anchors.unshift({ line: 0, y: 0 });
    }
    // y 单调性过滤：剔除破坏 y 单调（允许相等）的锚点。
    // 当 DOM 顺序与源码行号顺序不一致时（如"文件头注释与类注释之间"的散落声明，
    // 其 data-line 与 DOM 位置冲突），按 line 排序后 y 会非单调，
    // 导致编辑器往下滚动时侧边栏反而向上滚（反向）。
    // 过滤后插值永远非负斜率，反向现象从根上消除。
    // 允许相等：连续成员"上一内容底部 data-line-end"与"下一成员头 data-line"
    // 可能精确相等，严格递增会稀疏化锚点、加剧插值非线性。
    const monotonicAnchors = [];
    for (const a of anchors) {
      const prev = monotonicAnchors[monotonicAnchors.length - 1];
      if (!prev || a.y >= prev.y) {
        monotonicAnchors.push(a);
      }
    }
    scrollAnchorsCache = monotonicAnchors;
    // 按 y 升序副本（反向插值用，解耦 line/y 排序假设）
    scrollAnchorsByY = monotonicAnchors.slice().sort((a, b) => a.y - b.y);
    return monotonicAnchors;
  }

  /**
   * 根据源码行号线性插值侧边栏滚动位置。
   *
   * 锚点按行号升序排列，使用二分查找定位目标区间，线性映射行号到滚动位置。
   * 卡片锚点已在 buildScrollAnchors 中编码"对准可视中心的中间偏移"（可容纳时
   * 锚点在卡片中间、不可容纳时距卡片顶部半屏），此处只需纯线性插值。
   *
   * @param anchors - 锚点列表（按行号排序）
   * @param line - 源码行号
   * @returns {number|null} 插值滚动位置，无锚点时返回 null
   */
  function interpolateScrollPosition(anchors, line) {
    if (anchors.length === 0) return null;
    if (anchors.length === 1) return anchors[0].y;

    // 在锚点范围之前 / 之后：钳制到端点
    if (line <= anchors[0].line) return anchors[0].y;
    if (line >= anchors[anchors.length - 1].line) {
      return anchors[anchors.length - 1].y;
    }

    // 二分查找：定位 line 所在的两个锚点区间
    let lo = 0;
    let hi = anchors.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid].line <= line) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const a1 = anchors[lo];
    const a2 = anchors[hi];
    const ratio = a2.line > a1.line ? (line - a1.line) / (a2.line - a1.line) : 0;
    return a1.y + (a2.y - a1.y) * ratio;
  }

  /**
   * 处理侧边栏滚动事件（Markdown 双向同步）。
   *
   * 使用节流（非防抖）确保滚动过程中持续同步，而非等滚动结束后才触发。
   * 通过锚点反向插值将侧边栏滚动位置映射到源码行号。
   * 代码文件不反向滚动编辑器。
   */
  function handleSidebarScroll() {
    // 预览打开期间阻塞侧边栏→编辑器反向滚动同步
    if (isPreviewOpen) return;
    if (isScrollingFromExtension) {
      isScrollingFromExtension = false;
      return;
    }
    // 记录用户主动滚动时间戳：后续高亮消息若落在此窗口内，跳过自动定位，
    // 避免把用户正在拖动的滚动条弹回（详见 highlightMethod / highlightField）
    lastUserScrollAt = Date.now();
    // 此处一定是用户主动滚动（wheel/触摸/拖动滚动条/键盘），
    // 取消正在进行的正向同步缓动动画，否则动画的 scrollTargetY 仍指向
    // 编辑器对应位置，松手后下一帧会把侧边栏弹回原地。
    cancelScrollAnimation();
    // 代码文件：不反向滚动编辑器
    if (!isMarkdownMode) return;

    const now = Date.now();
    const elapsed = now - sidebarScrollLastFire;

    if (elapsed >= SIDEBAR_SCROLL_THROTTLE_MS) {
      // 超过节流间隔，立即发送
      sidebarScrollLastFire = now;
      sendScrollEditorFromAnchors();
    } else if (!sidebarScrollThrottleId) {
      // 在节流间隔内，安排一次延迟发送（保证最后一次位置同步）
      sidebarScrollThrottleId = setTimeout(function () {
        sidebarScrollThrottleId = null;
        sidebarScrollLastFire = Date.now();
        sendScrollEditorFromAnchors();
      }, SIDEBAR_SCROLL_THROTTLE_MS - elapsed);
    }
  }

  /**
   * 根据当前侧边栏滚动位置，通过锚点反向插值计算源码行号，
   * 发送 scrollEditor 消息同步编辑器。
   */
  function sendScrollEditorFromAnchors() {
    buildScrollAnchors();
    const byY = scrollAnchorsByY;
    if (!byY || byY.length === 0) return;

    // 以侧边栏可视区域中间为基准反向映射（与正向"中间对齐"严格对称）：
    // 正向把"屏幕中间行"对应元素的锚点（元素内偏移点）滚到可视中心，
    // 反向从可视中心读出该锚点行号，编辑器端再以 InCenter reveal 回
    // 编辑器视口中间。
    // 锚点 y = 元素顶 + 元素内偏移 - sticky header 高度；视口中心对应的
    // 文档位置 = scrollY + 可视中心，与锚点对照即可反插值出目标行；
    // 使用按 y 升序的副本，确保二分查找正确性。
    const viewMidY = window.scrollY + getViewportMidY();
    const rawLine = interpolateLineFromScroll(byY, viewMidY);
    if (rawLine === null) return;

    // 开头过渡区（侧边栏像素）：与正向过渡区对称，scrollY 在 [0, 半屏像素]
    // 内时目标行按比例从 0 平滑增长到正常反插值结果，消除 scrollY 0→1px
    // 时行号从 0 直接跳到可视中心行号的跳变（InCenter reveal 前的一瞬）。
    // 过渡区外（t=1）与纯反向插值完全一致。
    const blendZonePx = getViewportMidY();
    const t = Math.max(0, Math.min(1, window.scrollY / blendZonePx));
    // 保留小数行号（不四舍五入）：反向插值结果可能落在长逻辑行中部，
    // 扩展端按行内字符比例 reveal，折行下编辑器精确居中到对应字符位置
    const targetLine = rawLine * t;

    vscode.postMessage({ type: 'scrollEditor', payload: { line: targetLine } });
  }

  /**
   * 根据侧边栏滚动位置线性插值源码行号（反向映射）。
   *
   * 锚点按 y 升序排列（scrollAnchorsByY），使用二分查找定位目标区间。
   *
   * @param anchors - 锚点列表（按 y 升序）
   * @param scrollY - 侧边栏滚动位置
   * @returns {number|null} 源码行号
   */
  function interpolateLineFromScroll(anchors, scrollY) {
    if (anchors.length === 0) return null;
    if (anchors.length === 1) return anchors[0].line;

    if (scrollY <= anchors[0].y) return anchors[0].line;
    if (scrollY >= anchors[anchors.length - 1].y) return anchors[anchors.length - 1].line;

    // 二分查找：定位 scrollY 所在的两个锚点区间
    let lo = 0;
    let hi = anchors.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid].y <= scrollY) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const a1 = anchors[lo];
    const a2 = anchors[hi];
    const ratio = a2.y > a1.y ? (scrollY - a1.y) / (a2.y - a1.y) : 0;
    // 不四舍五入：保留小数行号，扩展端按行内字符比例精确 reveal
    return a1.line + (a2.line - a1.line) * ratio;
  }

  // ========== 消息处理 ==========
  function handleMessage(event) {
    const message = event.data;

    switch (message.type) {
      case 'updateView':
        if (isLocked) break;
        isMarkdownMode = false;
        currentClassDoc = message.payload;
        renderClassDoc(message.payload);
        break;

      case 'highlightMethod':
        highlightMethod(message.payload.id);
        break;

      case 'highlightField':
        highlightField(message.payload.line);
        break;

      case 'clearHighlight':
        clearHighlight();
        break;

      case 'syncScroll':
        handleSyncScroll(message.payload);
        break;

      case 'setHighlightTheme':
        // 用户修改深/浅色代码高亮主题设置：更新 body dataset 并重新启用主题
        document.body.dataset.hljsDark = message.payload.dark;
        document.body.dataset.hljsLight = message.payload.light;
        updateHljsTheme();
        break;

      case 'clearView':
        if (isLocked) break;
        currentClassDoc = null;
        renderEmptyState('打开支持的文件以查看文档');
        break;

      case 'updateMarkdown':
        if (isLocked) break;
        isMarkdownMode = true;
        currentClassDoc = null;
        currentMarkdownImageMap = message.payload.imageMap || {};
        renderMarkdown(
          message.payload.content,
          message.payload.fileName,
          currentMarkdownImageMap,
        );
        break;

      case 'debugInfo':
        showDebugPanel(message.payload.content);
        break;
    }
  }

  // ========== 渲染函数 ==========

  function renderEmptyState(message) {
    invalidateScrollAnchors();
    const stickyTitle = document.getElementById('sticky-title');
    if (stickyTitle) {
      stickyTitle.textContent = '';
    }
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${getEmptyIcon()}</div>
        <div class="empty-state-text">${escapeHtml(message)}</div>
      </div>
    `;
  }

  /**
   * Markdown 预览渲染
   */
  function renderMarkdown(content, fileName, imageMap) {
    invalidateScrollAnchors();
    const htmlContent = markdownToHtml(content, imageMap || {}, true);
    // 更新 sticky header 标题
    const stickyTitle = document.getElementById('sticky-title');
    if (stickyTitle) {
      stickyTitle.textContent = fileName || '';
    }
    root.innerHTML = `
      <div class="markdown-view">
        <div class="markdown-body">${htmlContent}</div>
      </div>
    `;
    applyAsyncEnhancers();
    injectPreviewButtons();
  }

  // ========== 卡片语义模型 ==========
  // 统一描述"类卡片"与"散落卡片（Unknown）"，消除渲染与锚点的不对称：
  // 每张卡片都有 anchorLine，使滚动锚点连续无间隙。

  /**
   * @typedef {Object} CardNode
   * @property {string} key - 分组 key（类名 或 'Unknown'）
   * @property {'class'|'scattered'} kind - 类卡片 vs 散落卡片
   * @property {string} name - 显示名
   * @property {object|undefined} typeInfo - 类型注释/标签（仅类卡片）
   * @property {Array} members - 成员条目列表
   * @property {number} anchorLine - 卡片滚动锚点行（必有，用于 data-line）
   * @property {number} startLine - 卡片起始行（min 成员 startLine / commentStartLine）
   */

  /**
   * 由 ClassDoc 构建结构化卡片模型。
   *
   * 沿用既有"allMembers 按 startLine 排序 + 连续同 key 合并"分组逻辑，
   * 但把每个分组提升为 CardNode，并为每张卡片计算 anchorLine：
   *   - 类卡片：typeInfo.commentStartLine ?? typeInfo.startLine
   *   - 散落卡片：min(members.startLine)（无注释，用首个成员行作锚点）
   *
   * @param {object} classDoc - ClassDoc 数据
   * @returns {{cards: CardNode[], isMultiGroup: boolean, shouldWrapTypeGroup: boolean}}
   */
  function buildCardModel(classDoc) {
    const allMethods = classDoc.methods || [];
    const allFields = classDoc.fields || [];
    const allEnumConstants = classDoc.enumConstants || [];

    // 没有类/接口/枚举的文件（typeGroups 为空）也套一个 "Unknown" 类型卡片
    const hasNoTypeGroups = !classDoc.typeGroups || classDoc.typeGroups.length === 0;
    const fallbackKey = hasNoTypeGroups ? 'Unknown' : (classDoc.className || 'Unknown');

    // 合并所有成员为统一结构
    const allMembers = [];
    for (const m of allMethods) {
      allMembers.push({
        key: m.belongsTo || fallbackKey,
        type: m.kind,
        data: m,
        startLine: m.startLine,
      });
    }
    for (const f of allFields) {
      allMembers.push({
        key: f.belongsTo || fallbackKey,
        type: 'field',
        data: f,
        startLine: f.startLine,
      });
    }
    for (const ec of allEnumConstants) {
      allMembers.push({
        key: ec.belongsTo || fallbackKey,
        type: 'enumConstant',
        data: ec,
        startLine: ec.startLine,
      });
    }

    // 按 startLine 排序（源码顺序）
    allMembers.sort((a, b) => a.startLine - b.startLine);

    // 构建类型注释映射：typeName → {comment, tags, startLine, commentStartLine}
    const typeGroupMap = new Map();
    if (classDoc.typeGroups) {
      for (const tg of classDoc.typeGroups) {
        typeGroupMap.set(tg.typeName, tg);
      }
    }

    // 按连续相同 key 分组（连续的同组成员合并为一个卡片）
    const rawGroups = [];
    let currentGroup = null;
    for (const m of allMembers) {
      if (!currentGroup || currentGroup.key !== m.key) {
        currentGroup = { key: m.key, members: [] };
        rawGroups.push(currentGroup);
      }
      currentGroup.members.push(m);
    }

    // 提升为 CardNode：计算 kind / anchorLine / startLine
    const cards = rawGroups.map(function (group) {
      const typeInfo = typeGroupMap.get(group.key);
      const kind = typeInfo ? 'class' : 'scattered';
      const memberStartLines = group.members.map(function (m) { return m.startLine; });
      const minMemberLine = memberStartLines.length
        ? Math.min.apply(null, memberStartLines)
        : 0;
      // 类卡片锚点优先用类注释起始行；散落卡片用首个成员行
      const anchorLine = typeInfo
        ? (typeInfo.commentStartLine != null ? typeInfo.commentStartLine : typeInfo.startLine)
        : minMemberLine;
      // 卡片起始行：类卡片取 min(注释起始, 成员起始)；散落卡片取首个成员行
      const startLine = typeInfo
        ? Math.min(
            typeInfo.commentStartLine != null ? typeInfo.commentStartLine : typeInfo.startLine,
            minMemberLine,
          )
        : minMemberLine;
      return {
        key: group.key,
        kind: kind,
        name: group.key,
        typeInfo: typeInfo,
        members: group.members,
        anchorLine: anchorLine,
        startLine: startLine,
      };
    });

    const isMultiGroup = cards.length > 1;
    // 总是用类型卡片包装：确保类注释（与文件头不同时）在各自卡片内渲染。
    // collectTypeGroups 已对与文件头重复的类注释去重，不会重复显示。
    const shouldWrapTypeGroup = true;

    return { cards: cards, isMultiGroup: isMultiGroup, shouldWrapTypeGroup: shouldWrapTypeGroup };
  }

  /**
   * 渲染单张卡片（统一类卡片与散落卡片）。
   *
   * @param {CardNode} card - 卡片语义节点
   * @returns {string} HTML
   */
  function renderCard(card) {
    const contentHtml = renderSourceOrderList(card.members);
    const isCollapsed = collapsedTypeGroups.has(card.key);
    const collapsedClass = isCollapsed ? 'collapsed' : '';
    const isScattered = card.kind === 'scattered';
    // data-line 统一用 card.anchorLine：散落卡片也拥有锚点，消除滚动间隙。
    // 放在非 sticky 的 .type-group 上而非 sticky 的 .type-group-header：
    // 后者被钉住时 rect.top 失真，会把锚点 y 污染成当前滚动位置（详见 buildScrollAnchors）
    const dataLine = `data-line="${card.anchorLine}"`;

    // 类型注释（仅类卡片有）
    let commentHtml = '';
    if (card.typeInfo) {
      const body = renderCommentBody(card.typeInfo.comment, card.typeInfo.tags);
      if (body) {
        commentHtml = `<div class="type-comment">${body}</div>`;
      }
    }

    // 散落卡片：附加统计标签；类卡片：无附加标签
    const label = isScattered ? generateStatsLabel(card.members) : '';

    return `
      <div class="type-group ${isScattered ? 'type-group-unknown' : ''} ${collapsedClass}" data-type="${escapeHtml(card.name)}" ${dataLine}>
        <div class="type-group-header" data-type="${escapeHtml(card.name)}">
          <span class="type-collapse-icon">${getCollapseIcon()}</span>
          <span class="type-icon">${getTypeIcon()}</span>
          <span class="type-name">${escapeHtml(card.name)}</span>
          <span class="type-meta">${escapeHtml(label)}</span>
        </div>
        <div class="type-group-content">
          ${commentHtml}
          ${contentHtml}
        </div>
      </div>
    `;
  }

  /**
   * 主渲染入口 —— 按卡片语义模型渲染
   *
   * 单一类型（常见于 Java 单类文件）：标题 + 构造函数/方法/字段三组。
   * 多类型（C++ 多 struct、JS 多组件等）：每个类型一个分隔标题 + 各自的分组。
   */
  function renderClassDoc(classDoc) {
    invalidateScrollAnchors();
    if (!classDoc) {
      renderEmptyState('未识别到可显示的成员');
      return;
    }

    const allMethods = classDoc.methods || [];
    const allFields = classDoc.fields || [];
    const allEnumConstants = classDoc.enumConstants || [];

    const hasContent = allMethods.length > 0 || allFields.length > 0
      || allEnumConstants.length > 0;

    // 预先计算文件头注释 + 作者/元数据信息：无成员时仍可展示已有信息
    const classCommentHtml = renderClassComment(classDoc);
    const authorInfoHtml = renderAuthorInfo(classDoc);
    const hasHeaderInfo = !!(classCommentHtml || authorInfoHtml);

    // 更新 sticky header 标题
    const stickyTitle = document.getElementById('sticky-title');
    if (stickyTitle) {
      stickyTitle.textContent = classDoc.className || '';
    }

    // 无可显示成员时：若存在文件头注释/元数据/git 信息，则展示已有信息，
    // 不再显示"未识别到可显示的成员"空状态
    if (!hasContent) {
      if (hasHeaderInfo) {
        root.innerHTML = classCommentHtml + authorInfoHtml;
        applyAsyncEnhancers();
        injectPreviewButtons();
        restoreHighlight();
        return;
      }
      renderEmptyState('未识别到可显示的成员');
      return;
    }

    // 构建结构化卡片模型（统一类卡片与散落卡片）
    const model = buildCardModel(classDoc);
    const cards = model.cards;
    const shouldWrapTypeGroup = model.shouldWrapTypeGroup;

    let html = '';

    // 文件级注释：
    // 单类型 → 顶部显示该类型的注释（与之前行为一致）
    // 多类型 → 顶部仅显示文件头注释（如果有），各类型注释在各自卡片内渲染
    html += classCommentHtml;
    if (authorInfoHtml) {
      html += authorInfoHtml;
    }

    html += '<div class="member-groups">';

    for (const card of cards) {
      if (shouldWrapTypeGroup) {
        html += renderCard(card);
      } else {
        // 单类型单组：不包裹卡片，直接渲染成员列表（与历史行为一致）
        html += renderSourceOrderList(card.members);
      }
    }

    html += '</div>';

    root.innerHTML = html;
    applyAsyncEnhancers();
    injectPreviewButtons();
    // 切换视图模式/重新渲染后恢复焦点定位
    restoreHighlight();
  }

  /**
   * 按源码顺序渲染成员列表（无子分组）
   */
  function renderSourceOrderList(members) {
    if (!members || members.length === 0) return '';

    let itemsHtml = '';
    for (const member of members) {
      itemsHtml += renderMemberItem(member);
    }

    return `
      <div class="source-order-list ${isCompactMode ? 'compact-mode' : 'detail-mode'}">
        ${itemsHtml}
      </div>
    `;
  }

  /**
   * 渲染单个成员项（根据类型分发）
   */
  function renderMemberItem(member) {
    switch (member.type) {
      case 'constructor':
        return applyIconColor(renderMethodItem(member.data), 'constructor');
      case 'method':
        return applyIconColor(renderMethodItem(member.data), 'method');
      case 'field':
        return applyIconColor(renderFieldItem(member.data, false), 'field');
      case 'enumConstant':
        return applyIconColor(renderFieldItem(member.data, true), 'enum');
      default:
        return '';
    }
  }

  /**
   * 给 .item-kind-icon 添加类型颜色修饰类
   */
  function applyIconColor(html, kind) {
    const classMap = {
      constructor: 'icon-constructor',
      method: 'icon-method',
      field: 'icon-field',
      enum: 'icon-enum',
    };
    const cls = classMap[kind];
    if (!cls) return html;
    // 在 .item-kind-icon 后添加颜色类
    return html.replace(
      'class="item-kind-icon"',
      `class="item-kind-icon ${cls}"`
    );
  }

  /**
   * 生成 Unknown 卡片的统计描述文本（如 "3 方法 · 2 字段"）
   */
  function generateStatsLabel(members) {
    if (!members || members.length === 0) return '文件级声明';
    const counts = { constructor: 0, method: 0, field: 0, enumConstant: 0 };
    for (const m of members) {
      if (counts[m.type] !== undefined) {
        counts[m.type]++;
      }
    }
    const parts = [];
    if (counts.constructor > 0) parts.push(`${counts.constructor} 构造`);
    if (counts.method > 0) parts.push(`${counts.method} 方法`);
    if (counts.field > 0) parts.push(`${counts.field} 字段`);
    if (counts.enumConstant > 0) parts.push(`${counts.enumConstant} 枚举`);
    return parts.length > 0 ? parts.join(' · ') : '文件级声明';
  }

  // ========== 方法/构造函数渲染 ==========

  /**
   * 渲染单个方法或构造函数项
   */
  function renderMethodItem(method) {
    return isCompactMode ? renderMethodCompact(method) : renderMethodDetail(method);
  }

  /**
   * 简洁模式
   */
  function renderMethodCompact(method) {
    const firstLine = getFirstLine(method.description);
    const returnType = method.tags?.returns?.type
      || method.returnType
      || 'void';
    const kindIcon = method.kind === 'constructor' ? getConstructorIcon() : getMethodIcon();

    const params = method.tags?.params || [];
    const paramsStr = params.length > 0
      ? params.map(p => `${p.type} ${p.name}`).join(', ')
      : (method.params || '无参数');

    // 构造函数不显示返回类型
    const returnHtml = method.kind === 'constructor' ? '' : `
      <div class="method-meta-row">
        <span class="meta-label">返回类型:</span>
        <span class="meta-value type-value">${escapeHtml(returnType)}</span>
      </div>
    `;

    return `
      <div class="method-item compact" data-id="${escapeHtml(method.id)}" data-line="${method.startLine}">
        <div class="method-compact-header">
          <span class="item-kind-icon" title="${method.kind === 'constructor' ? '构造函数' : '方法'}">${kindIcon}</span>
          <span class="method-name">${escapeHtml(method.name)}</span>
          ${method.accessModifier !== 'default' ? `<span class="access-badge">${escapeHtml(method.accessModifier)}</span>` : ''}
        </div>
        <div class="method-compact-meta">
          ${returnHtml}
          <div class="method-meta-row">
            <span class="meta-label">参数:</span>
            <span class="meta-value params-value">${escapeHtml(paramsStr)}</span>
          </div>
        </div>
        ${firstLine
          ? `<div class="method-desc-preview">${applyInlineMarkdown(firstLine, {})}</div>`
          : ''}
      </div>
    `;
  }

  /**
   * 详细模式
   */
  function renderMethodDetail(method) {
    const returnType = method.tags?.returns?.type
      || method.returnType
      || 'void';
    const kindIcon = method.kind === 'constructor' ? getConstructorIcon() : getMethodIcon();

    const params = method.tags?.params || [];
    const paramsStr = params.length > 0
      ? params.map(p => `${p.type} ${p.name}`).join(', ')
      : (method.params || '无参数');

    let contentHtml = '';

    if (method.hasComment) {
      // JSDoc: @summary（短摘要，优先显示在描述之前）
      if (method.tags.summary) {
        contentHtml += `<div class="jsdoc-summary">${escapeHtml(method.tags.summary)}</div>`;
      }

      if (method.description) {
        contentHtml += `<div class="method-description">${markdownToHtml(method.description, {})}</div>`;
      }

      // JSDoc: @description（长描述，补充说明）
      if (method.tags.description) {
        contentHtml += `<div class="jsdoc-description">${markdownToHtml(method.tags.description, {})}</div>`;
      }

      // JSDoc: 修饰符徽章（@readonly/@async/@override）
      if (method.tags.modifiers && method.tags.modifiers.length > 0) {
        contentHtml += renderModifiers(method.tags.modifiers);
      }

      if (method.tags.deprecated) {
        contentHtml += `
          <div class="deprecated-tag">
            <span class="other-tag-name">@deprecated</span>
            ${escapeHtml(method.tags.deprecated)}
          </div>
        `;
      }

      // JSDoc: @todo 待办事项（警告样式）
      if (method.tags.todo && method.tags.todo.length > 0) {
        contentHtml += renderTodoSection(method.tags.todo);
      }

      if (method.tags.doc) {
        contentHtml += renderDocSection(method.tags.doc);
      }

      if (method.tags.example) {
        contentHtml += renderExampleSection(method.tags.example);
      }

      if (method.tags.params && method.tags.params.length > 0) {
        contentHtml += renderParamsTable(method.tags.params);
      }

      if (method.tags.returns) {
        contentHtml += renderReturnsTable(method.tags.returns);
      }

      // JSDoc: @yields 生成器返回值
      if (method.tags.yields) {
        contentHtml += renderYieldsSection(method.tags.yields);
      }

      if (method.tags.throws && method.tags.throws.length > 0) {
        contentHtml += renderThrowsTable(method.tags.throws);
      }

      // JSDoc: @type 类型声明
      if (method.tags.type) {
        contentHtml += renderTypeSection(method.tags.type);
      }

      // JSDoc: @typedef 类型定义
      if (method.tags.typedef) {
        contentHtml += renderTypeDefSection(method.tags.typedef);
      }

      // JSDoc: @property 属性列表
      if (method.tags.properties && method.tags.properties.length > 0) {
        contentHtml += renderPropertiesTable(method.tags.properties);
      }

      // JSDoc: @template 泛型参数
      if (method.tags.template && method.tags.template.length > 0) {
        contentHtml += renderTemplateSection(method.tags.template);
      }

      // JSDoc: @emits / @listens 事件标签
      if (
        (method.tags.emits && method.tags.emits.length > 0) ||
        (method.tags.listens && method.tags.listens.length > 0)
      ) {
        contentHtml += renderEventTags(method.tags.emits || [], method.tags.listens || []);
      }

      contentHtml += renderOtherTags(method.tags);
    }

    // 构造函数不显示返回类型
    const returnHtml = method.kind === 'constructor' ? '' : `
      <span class="detail-meta-item">
        <span class="detail-label">返回:</span>
        <span class="detail-type">${escapeHtml(returnType)}</span>
      </span>
    `;

    // 锚点以卡片为单位：方法内容不单独建锚点，方法卡片整体由
    // .method-item 上的 data-line 提供一个锚点（详见 buildScrollAnchors）
    const contentSection = contentHtml
      ? `<div class="method-content">${contentHtml}</div>`
      : '';

    // 无注释（contentHtml 为空）的卡片不可展开/收起：不渲染折叠图标（用占位符
    // 保持与方法名对齐），不加 collapsed 类，并标记 no-comment 以豁免展开态样式
    const hasContent = !!contentHtml;
    const isCollapsed = hasContent && collapsedMethods.has(method.id);
    const collapsedClass = isCollapsed ? 'collapsed' : '';
    const noCommentClass = hasContent ? '' : 'no-comment';
    const collapseIconHtml = hasContent
      ? `<span class="collapse-icon">${getCollapseIcon()}</span>`
      : '<span class="collapse-spacer"></span>';

    // data-line 放在非 sticky 的 .method-item 上（而非 sticky 的 .method-header），
    // 避免被钉住时锚点 y 失真成当前滚动位置（详见 buildScrollAnchors）
    return `
      <div class="method-item detail ${collapsedClass} ${noCommentClass}" data-id="${escapeHtml(method.id)}" data-line="${method.startLine}">
        <div class="method-header">
          ${collapseIconHtml}
          <div class="method-info">
            <div class="method-name-row">
              <span class="item-kind-icon" title="${method.kind === 'constructor' ? '构造函数' : '方法'}">${kindIcon}</span>
              <span class="method-name">${escapeHtml(method.name)}</span>
              ${method.accessModifier !== 'default' ? `<span class="access-badge">${escapeHtml(method.accessModifier)}</span>` : ''}
            </div>
            <div class="method-detail-meta">
              ${returnHtml}
              <span class="detail-meta-item">
                <span class="detail-label">参数:</span>
                <span class="detail-params">${escapeHtml(paramsStr)}</span>
              </span>
            </div>
          </div>
        </div>
        ${contentSection}
      </div>
    `;
  }

  // ========== 字段渲染 ==========

  /**
   * 渲染字段 / 枚举常量项（共用卡片骨架）。
   *
   * 字段与枚举常量结构一致（图标 + 名称 + 元信息 + 描述），
   * 仅按类型差异渲染不同徽章：
   *   - 字段：类型、const 徽章、访问修饰符、JSDoc 标签
   *   - 枚举：参数（arguments）、名称用枚举色、无标签
   *
   * @param {object} item - 字段或枚举常量数据
   * @param {boolean} isEnum - 是否为枚举常量
   * @returns {string} HTML
   */
  function renderFieldItem(item, isEnum) {
    return isCompactMode ? renderFieldCompact(item, isEnum) : renderFieldDetail(item, isEnum);
  }

  /**
   * 字段简洁模式：首行预览 + 行内 Markdown
   */
  function renderFieldCompact(item, isEnum) {
    const icon = isEnum
      ? getEnumConstantIcon()
      : (item.isConstant ? getConstantIcon() : getFieldIcon());
    const title = isEnum ? '枚举常量' : (item.isConstant ? '常量' : '字段');
    const nameClass = isEnum ? 'field-name enum-name' : 'field-name';

    const metaHtml = isEnum
      ? (item.arguments
          ? `<span class="enum-args">${escapeHtml(item.arguments)}</span>`
          : '')
      : `
        <span class="field-type">${escapeHtml(item.type)}</span>
        ${item.isConstant ? '<span class="constant-badge">const</span>' : ''}
        ${item.accessModifier !== 'default' ? `<span class="access-badge">${escapeHtml(item.accessModifier)}</span>` : ''}
      `;

    const firstLine = getFirstLine(item.description);

    return `
      <div class="field-item" data-line="${item.startLine}">
        <div class="field-header">
          <span class="item-kind-icon" title="${title}">${icon}</span>
          <span class="${nameClass}">${escapeHtml(item.name)}</span>
          ${metaHtml}
        </div>
        ${firstLine
          ? `<div class="field-description">${applyInlineMarkdown(firstLine, {})}</div>`
          : ''}
      </div>
    `;
  }

  /**
   * 字段详细模式：完整 Markdown 渲染 + JSDoc 标签
   */
  function renderFieldDetail(item, isEnum) {
    const icon = isEnum
      ? getEnumConstantIcon()
      : (item.isConstant ? getConstantIcon() : getFieldIcon());
    const title = isEnum ? '枚举常量' : (item.isConstant ? '常量' : '字段');
    const nameClass = isEnum ? 'field-name enum-name' : 'field-name';

    const metaHtml = isEnum
      ? (item.arguments
          ? `<span class="enum-args">${escapeHtml(item.arguments)}</span>`
          : '')
      : `
        <span class="field-type">${escapeHtml(item.type)}</span>
        ${item.isConstant ? '<span class="constant-badge">const</span>' : ''}
        ${item.accessModifier !== 'default' ? `<span class="access-badge">${escapeHtml(item.accessModifier)}</span>` : ''}
      `;

    // JSDoc 标签渲染（@deprecated/@todo/@see/@type 等）
    const tagsHtml = item.tags ? renderCommentBody('', item.tags) : '';

    return `
      <div class="field-item" data-line="${item.startLine}">
        <div class="field-header">
          <span class="item-kind-icon" title="${title}">${icon}</span>
          <span class="${nameClass}">${escapeHtml(item.name)}</span>
          ${metaHtml}
        </div>
        ${item.description
          ? `<div class="field-description">${markdownToHtml(item.description, {})}</div>`
          : ''}
        ${tagsHtml ? `<div class="field-tags">${tagsHtml}</div>` : ''}
      </div>
    `;
  }

  // ========== 标签表格 ==========

  function renderParamsTable(params) {
    let rows = '';
    for (const param of params) {
      rows += `
        <tr>
          <td class="name-cell">${escapeHtml(param.name)}</td>
          <td class="type-cell">${escapeHtml(param.type)}</td>
          <td>${escapeHtml(param.description) || '-'}</td>
        </tr>
      `;
    }

    return `
      <div class="tag-section">
        <div class="tag-title">参数 Parameters</div>
        <div class="table-wrapper"><table class="tag-table">
          <thead>
            <tr>
              <th style="width: 20%">名称</th>
              <th style="width: 25%">类型</th>
              <th style="width: 55%">描述</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
    `;
  }

  function renderReturnsTable(returns) {
    return `
      <div class="tag-section">
        <div class="tag-title">返回值 Returns</div>
        <div class="table-wrapper"><table class="tag-table">
          <thead>
            <tr>
              <th style="width: 30%">类型</th>
              <th style="width: 70%">描述</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="type-cell">${escapeHtml(returns.type)}</td>
              <td>${escapeHtml(returns.description) || '-'}</td>
            </tr>
          </tbody>
        </table></div>
      </div>
    `;
  }

  function renderThrowsTable(throws) {
    let rows = '';
    for (const t of throws) {
      rows += `
        <tr>
          <td class="type-cell">${escapeHtml(t.type)}</td>
          <td>${escapeHtml(t.description) || '-'}</td>
        </tr>
      `;
    }

    return `
      <div class="tag-section">
        <div class="tag-title">异常 Throws</div>
        <div class="table-wrapper"><table class="tag-table">
          <thead>
            <tr>
              <th style="width: 40%">异常类型</th>
              <th style="width: 60%">触发条件</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
    `;
  }

  /**
   * 渲染 @see 标签内容。
   *
   * - 外部 URL（http/https）→ 外部链接
   * - 已包含 {@link} 或 Markdown 链接语法 → 交给 markdownToHtml 处理
   * - 文件路径引用（./xxx 或 xxx.ts#L10）→ md-link 本地链接
   * - 纯符号名（Foo、Foo.bar、Foo#bar）→ jsdoc-link 符号跳转
   */
  function renderSeeTag(see) {
    const trimmed = String(see || '').trim();
    if (!trimmed) return '';

    // 外部 URL
    if (/^https?:\/\//i.test(trimmed)) {
      return `<a class="md-link" href="${escapeHtml(trimmed)}" target="_blank" rel="noopener noreferrer">${escapeHtml(trimmed)}</a>`;
    }

    // 已包含 {@link} 或 Markdown 链接语法 → 交给 markdownToHtml
    if (/\{@link/.test(trimmed) || /\{@linkcode/.test(trimmed) || /\[[^\]]+\]\([^)]+\)/.test(trimmed)) {
      return markdownToHtml(trimmed, {}, false);
    }

    // 文件路径引用（./xxx、../xxx、xxx.ts、xxx#L10）
    if (/^\.\.?\/.+/.test(trimmed) || /^[^\s/#]+\.\w{1,5}(?:[#]\S*)?$/.test(trimmed)) {
      return `<a class="md-link" data-href="${escapeHtml(trimmed)}">${escapeHtml(trimmed)}</a>`;
    }

    // 纯符号名 → jsdoc-link 符号跳转
    return `<a class="jsdoc-link" data-target="${escapeHtml(trimmed)}" title="${escapeHtml(trimmed)}">${escapeHtml(trimmed)}</a>`;
  }

  function renderOtherTags(tags) {
    let html = '';

    if (tags.since || tags.author || (tags.see && tags.see.length > 0)) {
      html += '<div class="other-tags">';

      if (tags.since) {
        html += `<div class="other-tag"><span class="other-tag-name">@since</span>${escapeHtml(tags.since)}</div>`;
      }

      if (tags.author) {
        html += `<div class="other-tag"><span class="other-tag-name">@author</span>${escapeHtml(tags.author)}</div>`;
      }

      if (tags.see && tags.see.length > 0) {
        for (const see of tags.see) {
          html += `<div class="other-tag"><span class="other-tag-name">@see</span>${renderSeeTag(see)}</div>`;
        }
      }

      html += '</div>';
    }

    return html;
  }

  // ========== JSDoc 扩展标签渲染 ==========

  /**
   * 渲染修饰符徽章（@readonly / @async / @override）
   */
  function renderModifiers(modifiers) {
    if (!modifiers || modifiers.length === 0) return '';
    const badges = modifiers
      .map((m) => `<span class="modifier-badge modifier-${escapeHtml(m)}">${escapeHtml(m)}</span>`)
      .join('');
    return `<div class="modifier-badges">${badges}</div>`;
  }

  /**
   * 渲染 @todo 待办事项列表（警告样式）
   */
  function renderTodoSection(todos) {
    if (!todos || todos.length === 0) return '';
    const items = todos
      .map(
        (todo) => `
        <li class="todo-item">
          <span class="todo-icon">${getTodoIcon()}</span>
          <div class="todo-text">${markdownToHtml(todo, {})}</div>
        </li>
      `,
      )
      .join('');
    return `
      <div class="todo-section">
        <div class="tag-title">待办事项 @todo</div>
        <ul class="todo-list">${items}</ul>
      </div>
    `;
  }

  /**
   * 渲染 @type 类型声明
   */
  function renderTypeSection(typeTag) {
    if (!typeTag) return '';
    return `
      <div class="tag-section jsdoc-type-section">
        <div class="tag-title">类型 @type</div>
        <div class="jsdoc-type-block">
          <code class="jsdoc-type-code">${escapeHtml(typeTag.type)}</code>
          ${typeTag.description ? `<span class="jsdoc-type-desc">${markdownToHtml(typeTag.description, {})}</span>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * 渲染 @typedef 类型定义
   */
  function renderTypeDefSection(typedef) {
    if (!typedef) return '';
    return `
      <div class="tag-section jsdoc-typedef-section">
        <div class="tag-title">类型定义 @typedef</div>
        <div class="jsdoc-typedef-block">
          <div class="jsdoc-typedef-signature">
            ${typedef.type ? `<code class="jsdoc-type-code">${escapeHtml(typedef.type)}</code>` : ''}
            <code class="jsdoc-typedef-name">${escapeHtml(typedef.name)}</code>
          </div>
          ${typedef.description ? `<div class="jsdoc-typedef-desc">${markdownToHtml(typedef.description, {})}</div>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * 渲染 @property 属性表格
   */
  function renderPropertiesTable(properties) {
    if (!properties || properties.length === 0) return '';
    let rows = '';
    for (const prop of properties) {
      rows += `
        <tr>
          <td class="name-cell">${escapeHtml(prop.name)}</td>
          <td class="type-cell">${escapeHtml(prop.type)}</td>
          <td>${markdownToHtml(prop.description, {}) || '-'}</td>
        </tr>
      `;
    }

    return `
      <div class="tag-section">
        <div class="tag-title">属性 @property</div>
        <div class="table-wrapper"><table class="tag-table">
          <thead>
            <tr>
              <th style="width: 20%">名称</th>
              <th style="width: 25%">类型</th>
              <th style="width: 55%">描述</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
    `;
  }

  /**
   * 渲染 @template 泛型参数
   */
  function renderTemplateSection(templates) {
    if (!templates || templates.length === 0) return '';
    const chips = templates
      .map((t) => `<code class="jsdoc-template-chip">${escapeHtml(t)}</code>`)
      .join('');
    return `
      <div class="tag-section jsdoc-template-section">
        <div class="tag-title">泛型参数 @template</div>
        <div class="jsdoc-template-list">${chips}</div>
      </div>
    `;
  }

  /**
   * 渲染 @yields 生成器返回值
   */
  function renderYieldsSection(yields) {
    if (!yields) return '';
    return `
      <div class="tag-section">
        <div class="tag-title">生成值 @yields</div>
        <div class="table-wrapper"><table class="tag-table">
          <thead>
            <tr>
              <th style="width: 30%">类型</th>
              <th style="width: 70%">描述</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="type-cell">${escapeHtml(yields.type)}</td>
              <td>${markdownToHtml(yields.description, {}) || '-'}</td>
            </tr>
          </tbody>
        </table></div>
      </div>
    `;
  }

  /**
   * 渲染 @emits / @listens 事件标签
   */
  function renderEventTags(emits, listens) {
    let html = '';
    if (emits && emits.length > 0) {
      const items = emits
        .map(
          (e) => `
          <div class="event-tag-item event-emits">
            <span class="event-tag-icon">${getEventEmitIcon()}</span>
            <code class="event-tag-name">${escapeHtml(e.name)}</code>
            ${e.description ? `<span class="event-tag-desc">${escapeHtml(e.description)}</span>` : ''}
          </div>
        `,
        )
        .join('');
      html += `
        <div class="tag-section jsdoc-event-section">
          <div class="tag-title">触发事件 @emits</div>
          ${items}
        </div>
      `;
    }
    if (listens && listens.length > 0) {
      const items = listens
        .map(
          (e) => `
          <div class="event-tag-item event-listens">
            <span class="event-tag-icon">${getEventListenIcon()}</span>
            <code class="event-tag-name">${escapeHtml(e.name)}</code>
            ${e.description ? `<span class="event-tag-desc">${escapeHtml(e.description)}</span>` : ''}
          </div>
        `,
        )
        .join('');
      html += `
        <div class="tag-section jsdoc-event-section">
          <div class="tag-title">监听事件 @listens</div>
          ${items}
        </div>
      `;
    }
    return html;
  }

  // ========== 交互处理 ==========

  function bindEvents() {
    root.addEventListener('click', handleClick);
  }

  /**
   * 解析点击目标的源码起始行号。
   *
   * data-line 统一承载在非 sticky 元素上（.type-group / .method-item /
   * .field-item），sticky 头（.type-group-header / .method-header）不携带
   * data-line（避免被钉住时污染滚动锚点，见 buildScrollAnchors）。
   * 因此点击头部时从最近的 [data-line] 祖先解析行号。
   *
   * @param el - 被点击的元素
   * @returns {number} 源码起始行号；未找到返回 NaN
   */
  function getClickLine(el) {
    const anchor = el.closest('[data-line]');
    return anchor ? parseInt(anchor.dataset.line, 10) : NaN;
  }

  function handleClick(event) {
    const target = event.target;

    // 内容放大预览：点击右上角预览按钮打开。
    // 不拦截内容自身操作（图片跳转、代码复制、表格选择等保持原样）
    const launchBtn = target.closest('.preview-launch-btn');
    if (launchBtn) {
      const container = launchBtn.closest(
        '.md-image, .md-mermaid-image, .md-mermaid, .md-table-wrap, .md-code-block');
      if (container) {
        openPreview(container);
      }
      return;
    }

    const jsdocLink = target.closest('.jsdoc-link');
    if (jsdocLink) {
      const targetName = jsdocLink.dataset.target || '';
      if (targetName) {
        vscode.postMessage({ type: 'navigateToSymbol', payload: { name: targetName } });
      }
      return;
    }

    // Markdown 本地链接：从 data-href 读取目标（无 href，避免 webview 拦截）
    const mdLink = target.closest('a.md-link');
    if (mdLink) {
      const href = mdLink.dataset.href || '';
      if (href) {
        if (href.startsWith('#') && href.length > 1) {
          const anchor = href.slice(1);
          if (isMarkdownMode) {
            // Markdown 锚点：滚动到对应标题，同时同步编辑器
            const headingEl = document.getElementById(anchor);
            if (headingEl) {
              cancelScrollAnimation();
              headingEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
              // 立即同步编辑器到标题对应行号
              const line = parseInt(headingEl.dataset.line, 10);
              if (!isNaN(line)) {
                vscode.postMessage({ type: 'scrollEditor', payload: { line } });
              }
            }
          } else {
            // 代码文件：尝试定位符号
            vscode.postMessage({ type: 'navigateToSymbol', payload: { name: anchor } });
          }
        } else {
          vscode.postMessage({ type: 'openMarkdownLink', payload: { href } });
        }
      }
      // 有 href 的是外部链接，放行浏览器处理
      return;
    }

    // 切换视图按钮
    if (target.closest('#viewToggle')) {
      isCompactMode = !isCompactMode;
      if (currentClassDoc) {
        renderClassDoc(currentClassDoc);
      }
      return;
    }

    // 类型组：三角形 → 折叠/展开，头部其他位置 → 跳转到类定义
    const typeGroupHeader = target.closest('.type-group-header');
    if (typeGroupHeader) {
      const typeName = typeGroupHeader.dataset.type;
      const collapseIcon = target.closest('.type-collapse-icon');
      if (collapseIcon && typeName) {
        toggleTypeGroupCollapse(typeName);
      } else {
        // 点击头部其他位置 → 跳转到类定义行。
        // data-line 在非 sticky 的 .type-group 上（header 是 sticky，不携带
        // data-line 以免污染滚动锚点），从最近的 [data-line] 祖先解析行号
        const line = getClickLine(typeGroupHeader);
        if (!isNaN(line)) {
          jumpToLine(line);
        }
      }
      return;
    }

    // 类卡片正文注释区点击 → 跳转到类定义行
    // 排除链接、代码块、折叠块、Mermaid 图等交互元素
    const typeComment = target.closest('.type-comment');
    if (typeComment) {
      if (!event.target.closest('a, details, pre, .md-mermaid-block')) {
        const line = getClickLine(typeComment);
        if (!isNaN(line)) {
          jumpToLine(line);
        }
      }
      return;
    }

    // 字段/枚举常量点击 → 聚焦 + 跳转
    const fieldItem = target.closest('.field-item');
    if (fieldItem) {
      // 聚焦：清除其他卡片焦点，高亮当前字段
      document.querySelectorAll('.method-item, .field-item').forEach(item => item.classList.remove('active'));
      fieldItem.classList.add('active');
      // 跳转（排除交互元素如链接）
      if (!event.target.closest('a, details, pre, .md-mermaid-block')) {
        const line = parseInt(fieldItem.dataset.line, 10);
        if (!isNaN(line)) {
          jumpToLine(line);
        }
      }
      return;
    }

    // 简洁模式：点击整个条目跳转
    const compactItem = target.closest('.method-item.compact');
    if (compactItem) {
      const line = parseInt(compactItem.dataset.line, 10);
      if (!isNaN(line)) {
        jumpToLine(line);
      }
      return;
    }

    // 详细模式方法卡片
    const detailItem = target.closest('.method-item.detail');
    if (detailItem) {
      const methodId = detailItem.dataset.id;
      const isActive = detailItem.classList.contains('active');

      // 未聚焦：先聚焦此卡片（不 return，继续处理点击位置）
      if (!isActive && methodId) {
        // 与字段点击/高亮逻辑一致：同时清除字段与方法的 active，
        // 避免"字段高亮残留 + 方法高亮"同时出现
        document.querySelectorAll('.method-item, .field-item').forEach(item => item.classList.remove('active'));
        detailItem.classList.add('active');
      }

      // 点击头部 → 折叠/跳转（无论是否刚聚焦，都立即响应）
      const methodHeader = target.closest('.method-header');
      if (methodHeader) {
        // data-line 在非 sticky 的 .method-item 上（header 是 sticky，
        // 不携带 data-line 以免污染滚动锚点），从最近的 [data-line] 祖先解析行号
        const line = getClickLine(methodHeader);
        const collapseIcon = target.closest('.collapse-icon');
        if (collapseIcon && methodId) {
          toggleCollapse(methodId);
        } else if (!isNaN(line)) {
          jumpToLine(line);
        }
        return;
      }

      // 点击注释区域 → 跳转（排除交互元素），无论是否刚聚焦都立即响应。
      // .method-content 不携带 data-line（data-line 只在 .method-item 上，
      // 见 buildScrollAnchors），须从最近的 [data-line] 祖先解析行号
      const methodContent = target.closest('.method-content');
      if (methodContent) {
        if (!target.closest('a, details, pre, .md-mermaid-block')) {
          const line = getClickLine(methodContent);
          if (!isNaN(line)) {
            jumpToLine(line);
          }
        }
        return;
      }
    }
  }

  // ========== 内容放大预览（全屏遮罩） ==========
  // 通过悬浮在可预览内容右上角的"放大预览"按钮打开，不拦截内容自身交互。
  // 打开期间 isPreviewOpen=true：阻塞双向滚动同步，遮罩覆盖整个视口屏蔽侧边栏交互。
  // 交互：滚轮缩放（以鼠标位置为锚点）、拖拽平移、按钮（− / + / 1:1 / 适应 / 关闭）、Esc 退出。
  // 事件绑定在 overlay 元素上，随元素移除自动解绑；拖拽的 mousemove/mouseup 在 init 中
  // 以全局监听实现（通过 previewState.dragState 判活），避免重复绑定。

  /**
   * 为可预览内容注入右上角预览按钮。
   *
   * 渲染完成后调用（renderClassDoc / renderMarkdown）。按钮 hover 时显现，
   * 点击打开全屏预览；内容自身的交互（跳转/复制/选择）不受影响。
   */
  function injectPreviewButtons() {
    root.querySelectorAll('.md-image, .md-mermaid-image, .md-mermaid, .md-table-wrap, .md-code-block, .md-math-block')
      .forEach(function (el) {
        // 防重复注入（重复渲染/重复调用时跳过）
        if (el.querySelector('.preview-launch-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'preview-launch-btn';
        btn.title = '放大预览';
        btn.setAttribute('aria-label', '放大预览');
        btn.innerHTML = getPreviewIcon();
        el.appendChild(btn);
      });
  }

  /**
   * 放大镜图标（预览按钮用）。
   *
   * @returns {string} SVG 图标 HTML
   */
  function getPreviewIcon() {
    return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="11" cy="11" r="7"></circle>' +
      '<path d="M21 21l-4.35-4.35"></path>' +
      '<path d="M11 8v6M8 11h6"></path>' +
      '</svg>';
  }

  /**
   * 为预览内容生成标题（图片/图表/表格/代码块）。
   *
   * @param el - 触发预览的元素（其祖先链包含可预览容器）
   * @returns {string} 预览标题
   */
  function previewTitleFor(el) {
    const img = el.closest('.md-image, .md-mermaid-image');
    if (img) {
      if (img.closest('.md-mermaid-block')) return 'Mermaid 图表';
      const alt = img.getAttribute('alt');
      return alt ? '图片：' + alt : '图片';
    }
    if (el.closest('.md-mermaid') || el.closest('svg')) return 'Mermaid 图表';
    if (el.closest('.md-table-wrap') || el.closest('table')) return '表格';
    if (el.closest('.md-math-block')) return '公式';
    const codeBlock = el.closest('.md-code-block');
    if (codeBlock) {
      const lang = codeBlock.getAttribute('data-language');
      return lang ? '代码块：' + lang : '代码块';
    }
    return '内容预览';
  }

  /**
   * 打开放大预览：构建全屏遮罩并把内容克隆进预览层。
   *
   * @param el - 触发预览的元素（图片/图表容器/表格容器/代码块）
   */
  function openPreview(el) {
    if (isPreviewOpen) return;
    const source = el.closest('.md-image, .md-mermaid-image, .md-mermaid, .md-table-wrap, .md-code-block, .md-math-block');
    if (!source) return;

    // 构建遮罩层骨架
    const overlay = document.createElement('div');
    overlay.id = 'preview-overlay';
    overlay.innerHTML =
      '<div class="preview-header">' +
      '<span class="preview-title"></span>' +
      '<span class="preview-tools">' +
      '<span class="preview-hint">滚轮缩放 · 拖拽平移 · Esc 退出</span>' +
      '<button class="preview-btn" data-action="zoom-out" title="缩小">−</button>' +
      '<button class="preview-btn" data-action="zoom-in" title="放大">+</button>' +
      '<button class="preview-btn" data-action="reset" title="1:1 原大">1:1</button>' +
      '<button class="preview-btn" data-action="fit" title="适应窗口">适应</button>' +
      '<button class="preview-btn" data-action="close" title="关闭">✕</button>' +
      '</span>' +
      '</div>' +
      '<div class="preview-viewport"></div>';
    overlay.querySelector('.preview-title').textContent = previewTitleFor(el);

    // 预览内容容器：内容由 buildPreviewContent 从零重新渲染
    const viewport = overlay.querySelector('.preview-viewport');
    const content = document.createElement('div');
    content.className = 'preview-content';
    viewport.appendChild(content);
    // 追加到 body：全屏遮罩脱离 #root，其内部点击不会进入 root 的委托处理
    document.body.appendChild(overlay);

    previewState = {
      overlay: overlay,
      viewport: viewport,
      content: content,
      scale: 1,
      tx: 0,
      ty: 0,
      naturalW: 0,
      naturalH: 0,
      dragState: null,
    };
    isPreviewOpen = true;
    // 预览层覆盖后布局不再变化，但内容克隆可能引入图片加载，提前失效锚点缓存
    invalidateScrollAnchors();

    // 绑定遮罩交互（监听器挂在 overlay 元素上，随移除自动释放）
    // 滚轮统一在遮罩层拦截：header 区域滚轮只阻止底层页面滚动，视口内才触发缩放
    overlay.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (e.target === viewport || viewport.contains(e.target)) {
        handlePreviewWheel(e);
      }
    }, { passive: false });
    viewport.addEventListener('mousedown', handlePreviewMouseDown);
    overlay.querySelector('.preview-header').addEventListener('click', handlePreviewButton);

    // 从零重新渲染预览内容（矢量重渲染 + 宽度自由），
    // 渲染完成后适应窗口；图片异步加载完成后再次适应
    buildPreviewContent(source, content, function () {
      fitPreview();
      const previewImg = content.querySelector('img');
      if (previewImg) {
        if (previewImg.complete) {
          fitPreview();
        } else {
          previewImg.addEventListener('load', function () {
            fitPreview();
          });
        }
      }
    });
  }

  /**
   * 在预览层从零重新构建内容（不克隆侧边栏 DOM），保证放大清晰度与宽度自由：
   * - mermaid：读取源码用 mermaid 矢量重渲染（任意缩放清晰，不受位图限制）
   * - 图片：按自然尺寸展示（位图清晰度受物理分辨率限制）
   * - 代码块：读取源码重建（重新高亮），解除宽度约束自由伸展
   * - 表格：克隆表格本体，列宽按内容自然撑开
   *
   * @param source - 触发预览的容器（.md-image / .md-mermaid-image / .md-mermaid / .md-table-wrap / .md-code-block）
   * @param content - 预览内容容器（.preview-content）
   * @param onReady - 内容就绪回调（用于重新适应视口）
   */
  function buildPreviewContent(source, content, onReady) {
    // 本地渲染的 mermaid：优先使用渲染前缓存的源码矢量重渲染
    // （pre.mermaid 内容已被 mermaid 渲染产物 SVG 覆盖，textContent 已非源码）
    if (source.classList.contains('md-mermaid')) {
      const srcEl = source.querySelector('.mermaid');
      const code = String(source.__mermaidSource || (srcEl ? srcEl.textContent : '')).trim();
      renderMermaidInPreview(code, content, onReady);
      return;
    }
    // mermaid.ink 图片：容器内通常带源码，优先本地矢量重渲染
    if (source.classList.contains('md-mermaid-image')) {
      const block = source.closest('.md-mermaid-block');
      const srcCodeEl = block ? block.querySelector('.md-mermaid-source pre code') : null;
      const code = srcCodeEl ? srcCodeEl.textContent.trim() : '';
      if (code) {
        renderMermaidInPreview(code, content, onReady);
      } else {
        appendPreviewImage(source, content, onReady);
      }
      return;
    }
    // 普通图片：按自然尺寸展示
    if (source.tagName === 'IMG') {
      appendPreviewImage(source, content, onReady);
      return;
    }
    // 代码块：读取源码重建，解除宽度约束
    if (source.classList.contains('md-code-block')) {
      const codeEl = source.querySelector('code') || source;
      const lang = source.getAttribute('data-language') || '';
      const pre = document.createElement('pre');
      pre.className = 'md-code-block';
      pre.setAttribute('data-language', lang);
      const codeNode = document.createElement('code');
      if (lang) codeNode.className = 'language-' + lang;
      codeNode.textContent = codeEl.textContent;
      pre.appendChild(codeNode);
      content.appendChild(pre);
      // 统一走增强渲染入口（KaTeX / Mermaid / highlight.js），与侧栏内渲染行为一致
      applyAsyncEnhancers(content);
      onReady();
      return;
    }
    // 表格：克隆表格本体，宽度约束由预览 CSS 解除
    if (source.classList.contains('md-table-wrap')) {
      const table = source.querySelector('table') || source;
      content.appendChild(table.cloneNode(true));
      // 克隆的表格可能含公式/代码，统一补跑增强渲染（未加载组件统一降级）
      applyAsyncEnhancers(content);
      onReady();
      return;
    }
    // 兜底：克隆原容器
    content.appendChild(source.cloneNode(true));
    // 兜底克隆可能含公式/图表/代码，统一补跑增强渲染（未加载组件统一降级）
    applyAsyncEnhancers(content);
    onReady();
  }

  /**
   * 图片预览：克隆原 img 并按自然尺寸展示（清除侧边栏 width/height 约束）。
   *
   * @param img - 原图片元素
   * @param content - 预览内容容器
   * @param onReady - 内容就绪回调
   */
  function appendPreviewImage(img, content, onReady) {
    const clone = img.cloneNode(true);
    clone.removeAttribute('loading');
    clone.removeAttribute('srcset');
    content.appendChild(clone);
    onReady();
  }

  /**
   * 用 mermaid 在预览层重新渲染图表源码（矢量输出，放大不糊）。
   *
   * mermaid 异步渲染，期间显示占位提示；渲染完成后按 viewBox 实际尺寸
   * 设定 SVG 尺寸（解除 mermaid 默认 maxWidth 压缩），供适应/缩放使用。
   * 渲染失败或无源码时回退为源码文本展示。
   *
   * @param code - mermaid 图表源码
   * @param content - 预览内容容器
   * @param onReady - 内容就绪回调
   */
  function renderMermaidInPreview(code, content, onReady) {
    if (!window.mermaid || !code) {
      // 无 mermaid 运行时或源码为空：回退为源码文本展示
      const pre = document.createElement('pre');
      pre.className = 'md-code-block language-mermaid';
      const codeNode = document.createElement('code');
      codeNode.textContent = code;
      pre.appendChild(codeNode);
      content.appendChild(pre);
      onReady();
      return;
    }
    const placeholder = document.createElement('div');
    placeholder.className = 'preview-loading';
    placeholder.textContent = '图表渲染中…';
    content.appendChild(placeholder);

    const id = 'preview-mermaid-' + Date.now();
    window.mermaid.render(id, code).then(function (result) {
      content.removeChild(placeholder);
      const holder = document.createElement('div');
      holder.innerHTML = result.svg;
      const svg = holder.querySelector('svg');
      if (svg) {
        // 按 viewBox 实际尺寸设置 SVG 尺寸，解除 mermaid maxWidth 压缩
        const vb = svg.getAttribute('viewBox');
        const parts = vb ? vb.split(/[\s,]+/).map(Number) : null;
        if (parts && parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          svg.setAttribute('width', String(parts[2]));
          svg.setAttribute('height', String(parts[3]));
          svg.style.width = '';
          svg.style.height = '';
        }
        content.appendChild(svg);
      }
      onReady();
    }).catch(function () {
      content.removeChild(placeholder);
      const pre = document.createElement('pre');
      pre.className = 'md-code-block language-mermaid';
      const codeNode = document.createElement('code');
      codeNode.textContent = code;
      pre.appendChild(codeNode);
      content.appendChild(pre);
      onReady();
    });
  }

  /**
   * 关闭放大预览并移除遮罩。
   */
  function closePreview() {
    if (!previewState) return;
    previewState.overlay.remove();
    previewState = null;
    isPreviewOpen = false;
    // 预览期间内容尺寸可能变化，重建锚点缓存
    invalidateScrollAnchors();
  }

  /**
   * 应用当前平移/缩放变换到预览内容。
   */
  function applyPreviewTransform() {
    const s = previewState;
    if (!s) return;
    s.content.style.transform =
      'translate(' + s.tx + 'px, ' + s.ty + 'px) scale(' + s.scale + ')';
  }

  /**
   * 将预览内容适应视口：按视口尺寸等比缩放并居中。
   */
  function fitPreview() {
    const s = previewState;
    if (!s) return;
    const vw = s.viewport.clientWidth;
    const vh = s.viewport.clientHeight;
    if (vw <= 0 || vh <= 0) return;

    // 内容自然尺寸：图片优先用 naturalWidth/Height（未加载完为 0 时回退 scrollWidth）
    let nw = s.content.scrollWidth;
    let nh = s.content.scrollHeight;
    const img = s.content.querySelector('img');
    if (img && img.naturalWidth > 0) {
      nw = img.naturalWidth;
      nh = img.naturalHeight;
    }
    if (nw <= 0 || nh <= 0) return;

    s.naturalW = nw;
    s.naturalH = nh;
    // 留出边距，等比缩放（不超过 1:1 避免小内容被无谓放大）
    const pad = 48;
    const scale = Math.min((vw - pad) / nw, (vh - pad) / nh, 1);
    s.scale = scale;
    s.tx = (vw - nw * scale) / 2;
    s.ty = (vh - nh * scale) / 2;
    applyPreviewTransform();
  }

  /**
   * 滚轮缩放：以鼠标位置为锚点，保持鼠标指向的内容点不动。
   *
   * @param e - WheelEvent
   */
  function handlePreviewWheel(e) {
    const s = previewState;
    if (!s) return;
    e.preventDefault();
    // 每格滚轮约 10% 缩放（1.1/0.9），比之前 1.25/0.8 更平缓
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.min(8, Math.max(0.05, s.scale * factor));
    if (newScale === s.scale) return;

    const rect = s.viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // 锚点换算：鼠标处内容坐标在缩放前后保持一致
    const nx = (mx - s.tx) / s.scale;
    const ny = (my - s.ty) / s.scale;
    s.scale = newScale;
    s.tx = mx - nx * newScale;
    s.ty = my - ny * newScale;
    applyPreviewTransform();
  }

  /**
   * 预览层拖拽起始：记录起始坐标与初始平移量，
   * 后续位移由 init 中的全局 mousemove/mouseup 持续驱动。
   *
   * @param e - MouseEvent
   */
  function handlePreviewMouseDown(e) {
    const s = previewState;
    if (!s) return;
    s.dragState = {
      startX: e.clientX,
      startY: e.clientY,
      tx: s.tx,
      ty: s.ty,
    };
    s.viewport.classList.add('dragging');
    e.preventDefault();
  }

  /**
   * 预览工具按钮：缩小 / 放大（以视口中心为锚点）/ 1:1 / 适应 / 关闭。
   *
   * @param e - ClickEvent
   */
  function handlePreviewButton(e) {
    const btn = e.target.closest('.preview-btn');
    if (!btn) return;
    const s = previewState;
    if (!s) return;
    const action = btn.dataset.action;

    if (action === 'close') {
      closePreview();
      return;
    }
    if (action === 'fit') {
      fitPreview();
      return;
    }
    if (action === 'reset') {
      // 1:1 原大：内容左上角居中
      s.scale = 1;
      s.tx = (s.viewport.clientWidth - (s.naturalW || 0)) / 2;
      s.ty = (s.viewport.clientHeight - (s.naturalH || 0)) / 2;
      applyPreviewTransform();
      return;
    }

    // zoom-in / zoom-out：以视口中心为锚点缩放（约 10% 步进，平缓）
    const factor = action === 'zoom-in' ? 1.1 : 0.9;
    const newScale = Math.min(8, Math.max(0.05, s.scale * factor));
    if (newScale === s.scale) return;
    const cx = s.viewport.clientWidth / 2;
    const cy = s.viewport.clientHeight / 2;
    const nx = (cx - s.tx) / s.scale;
    const ny = (cy - s.ty) / s.scale;
    s.scale = newScale;
    s.tx = cx - nx * newScale;
    s.ty = cy - ny * newScale;
    applyPreviewTransform();
  }

  function toggleTypeGroupCollapse(typeName) {
    const typeEl = document.querySelector(`.type-group[data-type="${CSS.escape(typeName)}"]`);
    if (!typeEl) return;

    if (collapsedTypeGroups.has(typeName)) {
      collapsedTypeGroups.delete(typeName);
      typeEl.classList.remove('collapsed');
    } else {
      collapsedTypeGroups.add(typeName);
      typeEl.classList.add('collapsed');
    }
    // 折叠改变卡片高度与锚点 y，下次同步前重建
    invalidateScrollAnchors();
  }

  function toggleCollapse(methodId) {
    const methodItem = document.querySelector(`.method-item[data-id="${methodId}"]`);
    if (!methodItem) return;

    if (collapsedMethods.has(methodId)) {
      collapsedMethods.delete(methodId);
      methodItem.classList.remove('collapsed');
    } else {
      collapsedMethods.add(methodId);
      methodItem.classList.add('collapsed');
    }
    // 折叠改变方法卡片高度，锚点 y 需重建
    invalidateScrollAnchors();
  }

  function highlightMethod(methodId) {
    // 用户近期（USER_SCROLL_SUPPRESS_MS 内）主动滚动过侧边栏才抑制自动定位，
    // 否则点击卡片后仍应自动滚动居中
    const recentUserScroll = Date.now() - lastUserScrollAt <= USER_SCROLL_SUPPRESS_MS;
    // 清除所有高亮
    document.querySelectorAll('.method-item, .field-item').forEach(item => item.classList.remove('active'));

    const targetItem = document.querySelector(`.method-item[data-id="${methodId}"]`);
    if (targetItem) {
      targetItem.classList.add('active');
      if (!recentUserScroll) {
        scrollToItem(targetItem);
      }
    }
    currentHighlight = { kind: 'method', id: methodId };
  }

  function highlightField(line) {
    // 与 highlightMethod 相同：仅"用户近期主动滚动过侧边栏"才抑制自动定位
    const recentUserScroll = Date.now() - lastUserScrollAt <= USER_SCROLL_SUPPRESS_MS;
    // 清除所有高亮
    document.querySelectorAll('.method-item, .field-item').forEach(item => item.classList.remove('active'));

    const targetItem = document.querySelector(`.field-item[data-line="${line}"]`);
    if (targetItem) {
      targetItem.classList.add('active');
      if (!recentUserScroll) {
        scrollToItem(targetItem);
      }
    }
    currentHighlight = { kind: 'field', line };
  }

  function clearHighlight() {
    document.querySelectorAll('.method-item, .field-item').forEach(item => item.classList.remove('active'));
    currentHighlight = null;
  }

  /**
   * 重新应用当前高亮（用于切换视图模式后恢复焦点）
   * 重新渲染会丢失 DOM 上的 active 类，此函数根据 currentHighlight 重新定位
   */
  function restoreHighlight() {
    if (!currentHighlight) return;
    if (currentHighlight.kind === 'method') {
      const item = document.querySelector(`.method-item[data-id="${currentHighlight.id}"]`);
      if (item) {
        item.classList.add('active');
        scrollToItem(item);
      }
    } else if (currentHighlight.kind === 'field') {
      const item = document.querySelector(`.field-item[data-line="${currentHighlight.line}"]`);
      if (item) {
        item.classList.add('active');
        scrollToItem(item);
      }
    }
  }

  /**
   * 滚动侧边栏使目标卡片居中可见（焦点高亮）。
   *
   * 与编辑器滚动同步统一为"中间对齐 + RAF 缓动"：目标卡片"中心"落在可视区域
   * 垂直中心，超长卡片退化为顶部对齐防止顶部溢出。与同步滚动共用
   * animateScrollTo（动画中仅更新目标、平滑追随），避免原先"顶部对齐 smooth"
   * 与"中间对齐缓动"两套滚动互相拉锯，造成字段↔方法切换焦点时抖动不利落。
   */
  function scrollToItem(targetItem) {
    // 目标元素非 sticky，rect.top + scrollY 恒为自然文档位置。
    // 与同步滚动锚点（buildScrollAnchors）统一编码"对准可视中心的卡片内偏移"：
    //   卡片可完全容纳（h/2 <= viewportMid）→ 锚点在卡片中间（居中显示）；
    //   不可容纳 → 锚点距卡片顶部半个可视区域高度（顶部贴齐可视区域顶部）。
    // 锚点位置再预减上方 sticky 总高度（常驻顶栏 + 外层驻留卡片头，
    // 见 getStickyStackHeight），使卡片顶部完整显示（不被 sticky 遮挡）。
    const naturalTop = window.scrollY + targetItem.getBoundingClientRect().top;
    const viewportMid = getViewportMidY();
    const anchorOffset = Math.min(targetItem.offsetHeight / 2, viewportMid);
    const anchorY = naturalTop - getStickyStackHeight(targetItem) + anchorOffset;
    const targetY = Math.max(0, anchorY - viewportMid);
    animateScrollTo(targetY);
  }

  // ========== @doc / @example 渲染 ==========

  /**
   * 内容型标签的统一 section 包装（@doc / @example 共用）。
   *
   * 此前两个 section 各自手拼 HTML，结构重复且易漂移；统一由本函数生成
   * `<{name}-section>` 结构，className 参数保留各自视觉类名（doc/example）。
   *
   * @param name - section 类名前缀（生成 {name}-section / {name}-section-header ...）
   * @param icon - 标题图标（SVG 字符串）
   * @param title - 标题文本（如"设计原理 @doc"）
   * @param content - 已转换的 markdown HTML
   * @returns {string} section HTML（content 为空时返回空串）
   */
  function renderMarkdownSection(name, icon, title, content) {
    if (!content) return '';
    return (
      '<div class="' + name + '-section">' +
      '<div class="' + name + '-section-header">' +
      icon +
      '<span class="' + name + '-section-title">' + title + '</span>' +
      '</div>' +
      '<div class="' + name + '-section-content">' + content + '</div>' +
      '</div>'
    );
  }

  function renderDocSection(docContent) {
    if (!docContent) return '';
    return renderMarkdownSection('doc', getBookIcon(), '设计原理 @doc', markdownToHtml(docContent, {}));
  }

  function renderExampleSection(exampleContent) {
    if (!exampleContent) return '';
    return renderMarkdownSection('example', getCodeIcon(), '示例 @example', markdownToHtml(exampleContent, {}, false));
  }

  // ========== Markdown 渲染 ==========

  const TABLE_SEPARATOR_PATTERN = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
  const LIST_ITEM_PATTERN = /^(\s*)([-+*]|\d+\.)\s+(.+)$/;

  /**
   * 将标题文本转换为 URL 锚点 slug。
   *
   * 规则参考 GitHub Markdown：小写 → 移除标点 → 空格转连字符。
   * 保留 CJK 字符以支持中文标题。
   *
   * @param {string} text - 标题原始文本
   * @returns {string} slug，如 "1-项目概述"
   */
  function slugifyHeading(text) {
    return text
      .replace(/\*\*|__|`/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function markdownToHtml(text, imageMap, trackLines) {
    if (!text) return '';
    // 默认 false：代码模式下渲染注释（文件头/成员/标签描述）时不得注入
    // data-line=注释内行索引 的"幽灵锚点"，否则 buildScrollAnchors 会把这些
    // 非源码行号收进锚点表，导致编辑器在文件头注释内小幅度滚动时侧边栏大幅跳变。
    // 仅 Markdown 预览模式（renderMarkdown）显式传 true 开启行号跟踪。
    if (trackLines === undefined) trackLines = false;

    const source = text.replace(/\r\n?/g, '\n');
    const lines = source.split('\n');
    const blocks = [];

    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      const trimmed = line.trim();

      if (!trimmed) {
        index += 1;
        continue;
      }

      // 条件性添加 data-line 属性
      const dl = trackLines ? ' data-line="' + index + '"' : '';

      // 代码块
      if (/^```/.test(trimmed)) {
        const startLine = index;
        const lang = normalizeCodeLanguage(trimmed.replace(/^```/, '').trim());
        const codeLines = [];
        index += 1;
        while (index < lines.length && !/^```/.test(lines[index].trim())) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          index += 1;
        }
        const code = codeLines.join('\n');
        // 收尾锚点：块末行（结束 ``` 所在行）→ 块内源码行↔渲染像素精确映射，
        // 编辑器中间行落在代码块内时，侧边栏不跨块边界插值而失真
        const endLine = index - 1;
        const codeDl = trackLines
          ? ' data-line="' + startLine + '"' + (endLine > startLine ? ' data-line-end="' + endLine + '"' : '')
          : '';
        if (lang === 'mermaid') {
          blocks.push('<div class="md-mermaid"' + codeDl + '><pre class="mermaid">' + escapeHtml(code) + '</pre></div>');
        } else {
          blocks.push(
            '<pre class="md-code-block"' + codeDl + ' data-language="' + escapeHtml(lang || 'text') + '">' +
            '<code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' +
            escapeHtml(code) +
            '</code></pre>',
          );
        }
        continue;
      }

      // 块级公式（$$ ... $$）：单行 / 跨行（开行独占 $$ 或首行带内容 + 行尾闭合）
      if (trimmed.startsWith('$$')) {
        const math = collectMathBlock(lines, index);
        if (math) {
          const startLine = index;
          const endLine = math.endLine;
          // 收尾锚点：块末行（闭合 $$ 所在行），块内插值不跨块边界失真
          const mathDl = trackLines
            ? ' data-line="' + startLine + '"' + (endLine > startLine ? ' data-line-end="' + endLine + '"' : '')
            : '';
          blocks.push('<div class="md-math-block"' + mathDl + '>' + escapeHtml(math.formula) + '</div>');
          index = endLine + 1;
          continue;
        }
      }

      // 标题
      const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const headingText = headingMatch[2];
        const slug = slugifyHeading(headingText);
        blocks.push(
          '<h' + level + ' id="' + escapeHtml(slug) + '"' + dl + ' class="md-heading">' +
          applyInlineMarkdown(headingText, imageMap) +
          '</h' + level + '>',
        );
        index += 1;
        continue;
      }

      // 水平分割线
      if (/^(\*{3}|-{3,}|_{3,})\s*$/.test(trimmed)) {
        blocks.push('<hr' + dl + '>');
        index += 1;
        continue;
      }

      // 引用块
      if (/^\s*>/.test(line)) {
        const blockquote = renderMarkdownBlockquote(lines, index, imageMap);
        blocks.push(trackLines
          ? blockquote.html.replace(
            '<blockquote',
            '<blockquote data-line="' + index + '" data-line-end="' + (blockquote.nextIndex - 1) + '"',
          )
          : blockquote.html);
        index = blockquote.nextIndex;
        continue;
      }

      // 表格
      if (isMarkdownTableStart(lines, index)) {
        const table = renderMarkdownTable(lines, index, imageMap, trackLines);
        blocks.push(trackLines
          ? table.html.replace(
            '<div class="md-table-wrap">',
            '<div class="md-table-wrap" data-line="' + index + '" data-line-end="' + (table.nextIndex - 1) + '">',
          )
          : table.html);
        index = table.nextIndex;
        continue;
      }

      // 列表
      if (LIST_ITEM_PATTERN.test(line)) {
        const list = renderMarkdownList(lines, index, imageMap, trackLines);
        blocks.push(trackLines
          ? list.html.replace(
            /<(ul|ol)/,
            '<$1 data-line="' + index + '" data-line-end="' + (list.nextIndex - 1) + '"',
          )
          : list.html);
        index = list.nextIndex;
        continue;
      }

      // 段落
      const paragraph = renderMarkdownParagraph(lines, index, imageMap, trackLines);
      blocks.push(trackLines
        ? paragraph.html.replace(
          '<p>',
          '<p data-line="' + index + '" data-line-end="' + (paragraph.nextIndex - 1) + '">',
        )
        : paragraph.html);
      index = paragraph.nextIndex;
    }

    return blocks.join('\n');
  }

  /**
   * 收集块级公式块（$$ ... $$）。
   *
   * 支持三种形态：
   * 1. 单行公式：$$ 内容 $$ 同行闭合
   * 2. 跨行公式（开行独占）：首行单独一个 $$，内容行之后以单独一个 $$ 闭合
   * 3. 跨行公式（首行带内容）：首行以 $$ 开头且携带内容（如
   *    rebirth-solution.md 的多行推导式），持续收集到"行尾以 $$ 收尾"的行
   *
   * 形态 3 此前未识别：首行带内容时既不满足单行、也不满足"开行独占"，
   * 会掉进段落渲染，$$ 原样露出、公式整体不渲染。
   *
   * @param {string[]} lines - 源文件按行拆分的数组
   * @param {number} startIndex - $$ 块起始行下标
   * @returns {{formula: string, endLine: number} | null}
   *   无法构成完整公式块（到文件末尾仍未闭合）时返回 null，交由段落逻辑原样渲染
   */
  function collectMathBlock(lines, startIndex) {
    const first = lines[startIndex].trim();
    if (first.length < 4) return null;
    // 形态 1：单行公式 $$ ... $$
    if (first.startsWith('$$') && first.endsWith('$$')) {
      return {
        formula: first,
        endLine: startIndex,
      };
    }
    // 形态 2/3：跨行公式。开行独占（形态 2）时正文从下一行开始，
    // 闭合行是"单独一个 $$"；首行带内容（形态 3）时正文含首行，
    // 闭合行是"行尾以 $$ 收尾"的任意一行
    const exclusiveOpen = first === '$$';
    const body = [];
    let index = startIndex + 1;
    if (!exclusiveOpen) {
      body.push(first.slice(2).trim());
    }
    let endLine = startIndex;
    let closed = false;
    for (; index < lines.length; index += 1) {
      const t = lines[index].trimEnd();
      if (exclusiveOpen ? t === '$$' : t.endsWith('$$')) {
        if (!exclusiveOpen) {
          body.push(t.slice(0, t.length - 2).trim());
        }
        endLine = index;
        closed = true;
        index += 1;
        break;
      }
      body.push(lines[index]);
    }
    if (!closed) return null;
    const formula = '$$' + body.join('\n') + '$$';
    return { formula, endLine };
  }

  function normalizeCodeLanguage(rawLang) {
    return String(rawLang || '').trim().toLowerCase();
  }

  function renderMermaidDiagram(code) {
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      return '';
    }

    const diagramUrl = buildMermaidInkUrl(trimmedCode);
    return (
      '<figure class="md-mermaid-block">' +
      '<img class="md-mermaid-image" src="' +
      escapeHtml(diagramUrl) +
      '" alt="Mermaid diagram" loading="lazy">' +
      '<figcaption class="md-mermaid-caption">Mermaid</figcaption>' +
      '<details class="md-mermaid-source">' +
      '<summary>Source</summary>' +
      '<pre class="md-code-block language-mermaid" data-language="mermaid"><code>' +
      escapeHtml(trimmedCode) +
      '</code></pre>' +
      '</details>' +
      '</figure>'
    );
  }

  function buildMermaidInkUrl(diagramCode) {
    const bytes = new TextEncoder().encode(diagramCode);
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    const encoded = btoa(binary);
    return 'https://mermaid.ink/svg/' + encoded + '?bgColor=transparent';
  }

  // GitHub-style callout 类型映射
  const CALLOUT_TITLES = {
    note: 'Note',
    tip: 'Tip',
    important: 'Important',
    warning: 'Warning',
    caution: 'Caution',
  };

  function renderMarkdownBlockquote(lines, startIndex, imageMap) {
    const quoteLines = [];
    let index = startIndex;

    while (index < lines.length) {
      const match = /^\s*>\s?(.*)$/.exec(lines[index]);
      if (!match) {
        break;
      }
      quoteLines.push(match[1]);
      index += 1;
    }

    // GitHub-style callout 检测：首行形如 [!NOTE] / [!WARNING] 等
    const calloutMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(quoteLines[0] || '');
    if (calloutMatch) {
      const type = calloutMatch[1].toLowerCase();
      const title = CALLOUT_TITLES[type];
      const contentLines = quoteLines.slice(1);
      // 跳过首行后的空行（[!NOTE] 后通常有一个空 > 行）
      while (contentLines.length > 0 && contentLines[0].trim() === '') {
        contentLines.shift();
      }
      const innerHtml = markdownToHtml(contentLines.join('\n'), imageMap, false);
      return {
        html: '<div class="md-callout md-callout-' + type + '"><div class="md-callout-title">' + title + '</div><div class="md-callout-body">' + innerHtml + '</div></div>',
        nextIndex: index,
      };
    }

    const innerHtml = markdownToHtml(quoteLines.join('\n'), imageMap, false);
    return {
      html: '<blockquote class="md-blockquote">' + innerHtml + '</blockquote>',
      nextIndex: index,
    };
  }

  function isMarkdownTableStart(lines, index) {
    if (index + 1 >= lines.length) {
      return false;
    }
    const header = lines[index];
    const separator = lines[index + 1];
    // 表头需含未转义的 |（\| 转义的是单元格内字面管道，不构成表格列分隔）
    return hasUnescapedPipe(header) && TABLE_SEPARATOR_PATTERN.test(separator.trim());
  }

  function renderMarkdownTable(lines, startIndex, imageMap, trackLines) {
    const headerCells = splitTableRow(lines[startIndex]);
    const alignments = parseTableAlignments(lines[startIndex + 1]);
    const rows = [];
    let index = startIndex + 2;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim() || !hasUnescapedPipe(line)) {
        break;
      }
      if (/^```/.test(line.trim())) {
        break;
      }
      rows.push(splitTableRow(line));
      index += 1;
    }

    let headerHtml = '';
    for (let column = 0; column < headerCells.length; column += 1) {
      const align = alignments[column] || '';
      const style = align ? ' style="text-align:' + align + '"' : '';
      headerHtml +=
        '<th' +
        style +
        '>' +
        applyInlineMarkdown(headerCells[column] || '', imageMap) +
        '</th>';
    }

    let bodyHtml = '';
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      let rowHtml = '';
      for (let column = 0; column < headerCells.length; column += 1) {
        const align = alignments[column] || '';
        const style = align ? ' style="text-align:' + align + '"' : '';
        rowHtml +=
          '<td' +
          style +
          '>' +
          applyInlineMarkdown(row[column] || '', imageMap) +
          '</td>';
      }
      // 每行数据源行号 = 表头行 + 分隔行 + 行序号，作为行级滚动锚点
      const trDl = trackLines ? ' data-line="' + (startIndex + 2 + i) + '"' : '';
      bodyHtml += '<tr' + trDl + '>' + rowHtml + '</tr>';
    }

    const html =
      '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
      headerHtml +
      '</tr></thead><tbody>' +
      bodyHtml +
      '</tbody></table></div>';

    return { html, nextIndex: index };
  }

  /**
   * 拆分表格行：按未转义的 | 分割单元格。
   *
   * Markdown 表格中用 \| 表示字面管道符（如 `WebviewView \| undefined`），
   * 该转义管道不参与分割，并在单元格内容中还原为 |。
   *
   * @param line - 表格行文本
   * @returns {string[]} 单元格数组（已去除首尾空白）
   */
  function splitTableRow(line) {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = [];
    let current = '';
    for (let index = 0; index < trimmed.length; index += 1) {
      const ch = trimmed[index];
      if (ch === '\\' && trimmed[index + 1] === '|') {
        // 转义的管道符：作为字面字符并入当前单元格，不分割
        current += '|';
        index += 1;
      } else if (ch === '|') {
        cells.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current);
    return cells.map(function (cell) {
      return cell.trim();
    });
  }

  /**
   * 判断一行是否包含未转义的管道符（真正的列分隔符）。
   *
   * @param line - 行文本
   * @returns {boolean} 是否包含未转义管道符
   */
  function hasUnescapedPipe(line) {
    return /(^|[^\\])\|/.test(line);
  }

  function parseTableAlignments(separatorLine) {
    return splitTableRow(separatorLine).map(function (cell) {
      const token = cell.trim();
      const hasLeft = token.startsWith(':');
      const hasRight = token.endsWith(':');
      if (hasLeft && hasRight) {
        return 'center';
      }
      if (hasRight) {
        return 'right';
      }
      if (hasLeft) {
        return 'left';
      }
      return '';
    });
  }

  function renderMarkdownList(lines, startIndex, imageMap, trackLines) {
    const htmlParts = [];
    const stack = [];
    let index = startIndex;

    while (index < lines.length) {
      const line = lines[index];
      const trimmed = line.trim();
      if (!trimmed) {
        index += 1;
        break;
      }

      if (/^```/.test(trimmed)) {
        break;
      }

      const itemMatch = LIST_ITEM_PATTERN.exec(line);
      if (!itemMatch) {
        break;
      }

      const indent = itemMatch[1].replace(/\t/g, '    ').length;
      const marker = itemMatch[2];
      const content = itemMatch[3];
      const listType = marker.endsWith('.') ? 'ol' : 'ul';

      while (stack.length > 0 && indent < stack[stack.length - 1].indent) {
        const closeType = stack.pop().type;
        htmlParts.push('</li></' + closeType + '>');
      }

      if (
        stack.length === 0 ||
        indent > stack[stack.length - 1].indent
      ) {
        htmlParts.push('<' + listType + ' class="md-list">');
        stack.push({ type: listType, indent });
      } else if (listType !== stack[stack.length - 1].type) {
        const previousType = stack.pop().type;
        htmlParts.push('</li></' + previousType + '>');
        htmlParts.push('<' + listType + ' class="md-list">');
        stack.push({ type: listType, indent });
      } else {
        htmlParts.push('</li>');
      }

      // 列表项行级滚动锚点：源行号即当前行
      const liDl = trackLines ? ' data-line="' + index + '"' : '';
      htmlParts.push('<li' + liDl + '>' + applyInlineMarkdown(content, imageMap));
      index += 1;
    }

    while (stack.length > 0) {
      const closeType = stack.pop().type;
      htmlParts.push('</li></' + closeType + '>');
    }

    return { html: htmlParts.join(''), nextIndex: index };
  }

  function renderMarkdownParagraph(lines, startIndex, imageMap, trackLines) {
    const paragraphLines = [];
    let index = startIndex;

    while (index < lines.length) {
      const line = lines[index];
      const trimmed = line.trim();

      if (!trimmed) {
        break;
      }
      // 段落后紧跟 $$ 公式块（如 JSDoc 描述中"正文行 + 公式行"连排）：
      // 若不在段落处切断，$$ 行会被当作普通段文本吞掉，公式永不进入
      // markdownToHtml 的公式块分支 → KaTeX 不渲染。此处主动切断，
      // 让外层循环把 $$ 行交给 collectMathBlock 处理。
      if (trimmed.startsWith('$$')) {
        break;
      }
      if (/^```/.test(trimmed)) {
        break;
      }
      if (/^(#{1,6})\s+/.test(trimmed)) {
        break;
      }
      if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(trimmed)) {
        break;
      }
      if (/^\s*>/.test(line)) {
        break;
      }
      if (LIST_ITEM_PATTERN.test(line)) {
        break;
      }
      if (isMarkdownTableStart(lines, index)) {
        break;
      }

      paragraphLines.push(line);
      index += 1;
    }

    // 逐行包裹 data-line 锚点：每行源文本在渲染页都有精确锚点，
    // 锚点→锚点线性插值不再依赖"块首→块尾"的块内等比近似，
    // 长行折行/段内行高差异也能精确映射。
    // 非跟踪模式（代码模式注释等）保持原样，避免注入幽灵行号。
    const html =
      '<p>' +
      paragraphLines.map(function (line, i) {
        const lineHtml = applyInlineMarkdown(line, imageMap);
        return trackLines
          ? '<span class="md-line" data-line="' + (startIndex + i) + '">' + lineHtml + '</span>'
          : lineHtml;
      }).join('<br>') +
      '</p>';
    return { html, nextIndex: index };
  }

  function applyInlineMarkdown(text, imageMap) {
    if (!text) {
      return '';
    }

    const tokens = [];
    let content = text;

    function stash(html) {
      const token = '\x02' + tokens.length + '\x02';
      tokens.push(html);
      return token;
    }

    // 保护行内公式 $ ... $（不匹配 $$）
    content = content.replace(/(?<!\$)\$(?!\$)([^\n$]+?)\$/g, function (_, formula) {
      return stash('<span class="md-math-inline">' + escapeHtml('$' + formula + '$') + '</span>');
    });

    // JSDoc {@link target} 和 {@link target|label} / {@link target label} 内联链接
    // 同时支持 {@linkcode ...} 变体（渲染为代码样式）
    content = content.replace(/\{@(link|linkcode)\s+([^}]+)\}/g, function (_, kind, linkContent) {
      const trimmed = linkContent.trim();
      let target = trimmed;
      let label = trimmed;
      // 优先按 | 分隔
      const pipeIdx = trimmed.indexOf('|');
      if (pipeIdx > 0) {
        target = trimmed.slice(0, pipeIdx).trim();
        label = trimmed.slice(pipeIdx + 1).trim();
      } else {
        // 按首个空白分隔（target label 形式）
        const spaceMatch = /^(\S+)\s+([\s\S]+)$/.exec(trimmed);
        if (spaceMatch) {
          target = spaceMatch[1];
          label = spaceMatch[2].trim();
        }
      }
      const isCode = kind === 'linkcode';
      const labelHtml = isCode
        ? '<code class="jsdoc-linkcode">' + escapeHtml(label) + '</code>'
        : escapeHtml(label);
      return stash(
        '<a class="jsdoc-link" data-target="' + escapeHtml(target) + '" title="' + escapeHtml(target) + '">' + labelHtml + '</a>',
      );
    });

    content = content.replace(/`([^`]+)`/g, function (_, codeText) {
      return stash(
        '<code class="md-inline-code">' + escapeHtml(codeText) + '</code>',
      );
    });

    // 保护转义字符：Markdown 中 \x 表示字面 x（如 \* \_ \| \` \[ 等），
    // 先暂存为占位符，避免被后续粗体/斜体/链接等匹配误当格式标记；
    // 最终逆序恢复为字面字符。行内代码 span 已先 stash 为占位符（不含反斜杠），
    // 其内部的反斜杠原样保留，不受此保护影响。
    content = content.replace(/\\([\\`*_{}\[\]<>()#+\-.!|])/g, function (_, ch) {
      return stash(ch);
    });

    content = content.replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      function (_, altText, target) {
        const imageHtml = renderInlineMarkdownImage(altText, target, imageMap);
        return imageHtml ? stash(imageHtml) : '';
      },
    );

    content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, label, target) {
      const linkHtml = renderInlineMarkdownLink(label, target);
      return linkHtml ? stash(linkHtml) : label;
    });

    let html = escapeHtml(content);
    html = html.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    html = html.replace(
      /(\*{3}|_{3})(?=\S)([\s\S]*?\S)\1/g,
      '<strong><em>$2</em></strong>',
    );
    html = html.replace(
      /(\*{2}|_{2})(?=\S)([\s\S]*?\S)\1/g,
      '<strong>$2</strong>',
    );
    html = html.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '<em>$2</em>');

    // 从后往前恢复占位符：后 stash 的元素（高 index，如链接）可能嵌套先 stash 的
    // 占位符（低 index，如链接 label 中的内联代码）。逆序恢复确保外层先展开，
    // 内层占位符随后被对应 token 替换，避免残留显示为 "0"/"1" 等索引文本
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const token = '\x02' + index + '\x02';
      html = html.split(token).join(tokens[index]);
    }
    return html;
  }

  function renderInlineMarkdownImage(altText, rawTarget, imageMap) {
    const source = normalizeMarkdownTarget(rawTarget);
    if (!source) {
      return '';
    }

    const resolvedSource = resolveImageSource(source, imageMap);
    if (!resolvedSource || isUnsafeUrl(resolvedSource)) {
      return '';
    }

    return (
      '<img alt="' +
      escapeHtml(altText) +
      '" src="' +
      escapeHtml(resolvedSource) +
      '" class="md-image" loading="lazy">'
    );
  }

  function renderInlineMarkdownLink(label, rawTarget) {
    const target = normalizeMarkdownTarget(rawTarget);
    if (!target || isUnsafeUrl(target)) {
      return '';
    }

    const safeTarget = escapeHtml(target);
    const isExternal = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(target);

    // 外部链接：保留 href + target="_blank"（webview 直接打开系统浏览器）
    // 本地链接：使用 data-href 避免 webview 拦截，由 JS click handler 处理
    if (isExternal) {
      return (
        '<a class="md-link" href="' + safeTarget + '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(label) +
        '</a>'
      );
    }
    return (
      '<a class="md-link" data-href="' + safeTarget + '">' +
      escapeHtml(label) +
      '</a>'
    );
  }

  function normalizeMarkdownTarget(rawTarget) {
    if (!rawTarget) {
      return null;
    }

    const trimmed = String(rawTarget).trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.startsWith('<')) {
      const end = trimmed.indexOf('>');
      if (end > 1) {
        return trimmed.slice(1, end).trim();
      }
    }

    const firstPart = trimmed.split(/\s+/, 1)[0] || '';
    if (!firstPart) {
      return null;
    }

    if (
      (firstPart.startsWith('"') && firstPart.endsWith('"')) ||
      (firstPart.startsWith("'") && firstPart.endsWith("'"))
    ) {
      return firstPart.slice(1, -1);
    }
    return firstPart;
  }

  function resolveImageSource(source, imageMap) {
    if (imageMap && Object.prototype.hasOwnProperty.call(imageMap, source)) {
      return imageMap[source];
    }
    return source;
  }

  function isUnsafeUrl(url) {
    return /^\s*javascript:/i.test(url);
  }

  function getFirstLine(text) {
    if (!text) return '';
    const firstLine = text.split('\n')[0].trim();
    return firstLine.length > 60 ? firstLine.slice(0, 60) + '...' : firstLine;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ========== 类注释渲染 ==========

  /**
   * 渲染注释内容体（描述 + 结构化标签）
   *
   * 提取为独立函数，供文件级注释和类型级注释复用。
   * @param comment - 描述部分（已剥离 @tag）
   * @param tags    - 结构化标签表
   * @returns HTML 字符串（不含外层容器）
   */
  function renderCommentBody(comment, tags) {
    const hasTags = tags && (
      tags.deprecated ||
      tags.todo?.length > 0 ||
      tags.see?.length > 0 ||
      tags.example ||
      tags.doc ||
      tags.type ||
      tags.typedef ||
      tags.properties?.length > 0 ||
      tags.template?.length > 0 ||
      tags.summary ||
      tags.description ||
      tags.modifiers?.length > 0 ||
      tags.emits?.length > 0 ||
      tags.listens?.length > 0
    );

    if (!comment && !hasTags) return '';

    let inner = '';

    // @summary 短摘要
    if (tags?.summary) {
      inner += `<div class="jsdoc-summary">${escapeHtml(tags.summary)}</div>`;
    }

    // 主描述
    if (comment) {
      inner += `<div class="class-description">${markdownToHtml(comment, {})}</div>`;
    }

    // @description 长描述
    if (tags?.description) {
      inner += `<div class="jsdoc-description">${markdownToHtml(tags.description, {})}</div>`;
    }

    if (hasTags) {
      // 修饰符徽章
      if (tags.modifiers && tags.modifiers.length > 0) {
        inner += renderModifiers(tags.modifiers);
      }

      // @deprecated 警告
      if (tags.deprecated) {
        inner += `
          <div class="deprecated-tag">
            <span class="other-tag-name">@deprecated</span>
            ${escapeHtml(tags.deprecated)}
          </div>
        `;
      }

      // @todo 待办
      if (tags.todo && tags.todo.length > 0) {
        inner += renderTodoSection(tags.todo);
      }

      // @doc 设计原理
      if (tags.doc) {
        inner += renderDocSection(tags.doc);
      }

      // @example 示例
      if (tags.example) {
        inner += renderExampleSection(tags.example);
      }

      // @type / @typedef / @property / @template
      if (tags.type) {
        inner += renderTypeSection(tags.type);
      }
      if (tags.typedef) {
        inner += renderTypeDefSection(tags.typedef);
      }
      if (tags.properties && tags.properties.length > 0) {
        inner += renderPropertiesTable(tags.properties);
      }
      if (tags.template && tags.template.length > 0) {
        inner += renderTemplateSection(tags.template);
      }

      // @emits / @listens 事件
      if (
        (tags.emits && tags.emits.length > 0) ||
        (tags.listens && tags.listens.length > 0)
      ) {
        inner += renderEventTags(tags.emits || [], tags.listens || []);
      }

      // @see（@author/@since 已在作者信息区展示，此处仅渲染 @see）
      if (tags.see && tags.see.length > 0) {
        inner += '<div class="other-tags">';
        for (const see of tags.see) {
          inner += `<div class="other-tag"><span class="other-tag-name">@see</span>${markdownToHtml(see, {})}</div>`;
        }
        inner += '</div>';
      }
    }

    return inner;
  }

  /**
   * 渲染类/文件头注释 —— 描述 + 结构化标签
   */
  function renderClassComment(classDoc) {
    const inner = renderCommentBody(classDoc.classComment, classDoc.classTags);
    if (!inner) return '';
    // 文件头注释作为"区间锚点"：data-line 起始行 + data-line-end 结束行，
    // 使编辑器在文件头注释内滚动时侧边栏精确停留在注释区域内部，
    // 而非从注释顶部被线性拉伸、略滚就跳向首张类卡片。
    // 文件级注释来自类注释（无文件头区间信息）时退化为 data-line="0" 点锚点。
    const endLine = classDoc.fileHeaderEndLine;
    const lineAttr = endLine != null
      ? `data-line="${classDoc.fileHeaderStartLine ?? 0}" data-line-end="${endLine}"`
      : 'data-line="0"';
    return `<div class="class-comment" ${lineAttr}>${inner}</div>`;
  }

  // ========== 作者信息 ==========

  function renderAuthorInfo(classDoc) {
    const hasDocAuthor = classDoc.docAuthor;
    const hasDocSince = classDoc.docSince;
    const hasDocLicense = classDoc.docLicense;
    const hasGitInfo = classDoc.gitInfo;

    if (!hasDocAuthor && !hasDocSince && !hasDocLicense && !hasGitInfo) {
      return '';
    }

    let html = '<div class="author-info">';

    if (hasDocAuthor) {
      html += `
        <div class="author-item" title="来自 @author 标签">
          ${getUserIcon()}
          <span class="author-label">作者:</span>
          <span class="author-value">${escapeHtml(classDoc.docAuthor)}</span>
        </div>
      `;
    }

    if (classDoc.docLicense) {
      html += `
        <div class="author-item" title="来自 SPDX-License-Identifier / @license 标签">
          ${getBookIcon()}
          <span class="author-label">许可:</span>
          <span class="author-value">${escapeHtml(classDoc.docLicense)}</span>
        </div>
      `;
    }

    if (classDoc.docSince) {
      html += `
        <div class="author-item" title="来自 @since 标签">
          ${getCalendarIcon()}
          <span class="author-label">创建:</span>
          <span class="author-value">${escapeHtml(classDoc.docSince)}</span>
        </div>
      `;
    }

    if (hasGitInfo) {
      if (!hasDocAuthor && classDoc.gitInfo.author) {
        html += `
          <div class="author-item" title="来自 Git 提交历史">
            ${getGitIcon()}
            <span class="author-label">作者:</span>
            <span class="author-value">${escapeHtml(classDoc.gitInfo.author)}</span>
          </div>
        `;
      }

      if (classDoc.gitInfo.lastModifier) {
        html += `
          <div class="author-item" title="来自 Git Blame">
            ${getGitIcon()}
            <span class="author-label">最后修改:</span>
            <span class="author-value">${escapeHtml(classDoc.gitInfo.lastModifier)}</span>
            ${classDoc.gitInfo.lastModifyDate ? `<span class="author-date">${escapeHtml(classDoc.gitInfo.lastModifyDate)}</span>` : ''}
          </div>
        `;
      }
    }

    html += '</div>';
    return html;
  }

  // ========== SVG 图标 ==========

  function getBookIcon() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
    </svg>`;
  }

  function getCodeIcon() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="16 18 22 12 16 6"></polyline>
      <polyline points="8 6 2 12 8 18"></polyline>
    </svg>`;
  }

  // 构造函数图标 — 齿轮/扳手风格，表示"构建"
  // 类型/类图标 — 用于多类型文件的类型组标题
  function getTypeIcon() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
      <path d="M2 17l10 5 10-5"></path>
      <path d="M2 12l10 5 10-5"></path>
    </svg>`;
  }

  function getConstructorIcon() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
    </svg>`;
  }

  // 方法图标 — 函数符号 f(x)
  function getMethodIcon() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 2v4a2 2 0 0 1-2 2H4"></path>
      <path d="M6 12c0 2 1 4 3 4s3-2 3-4-1-4-3-4-3 2-3 4z"></path>
      <path d="M18 8l-2 8"></path>
      <path d="M14 12h8"></path>
    </svg>`;
  }

  // 字段图标 — 变量/数据
  function getFieldIcon() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <line x1="9" y1="3" x2="9" y2="21"></line>
    </svg>`;
  }

  // 常量图标 — 锁定的值
  function getConstantIcon() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>`;
  }

  // 枚举常量图标 — 列表+标记
  function getEnumConstantIcon() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"></line>
      <line x1="8" y1="12" x2="21" y2="12"></line>
      <line x1="8" y1="18" x2="21" y2="18"></line>
      <circle cx="4" cy="6" r="1.5" fill="currentColor"></circle>
      <circle cx="4" cy="12" r="1.5" fill="currentColor"></circle>
      <circle cx="4" cy="18" r="1.5" fill="currentColor"></circle>
    </svg>`;
  }

  // 折叠箭头
  function getCollapseIcon() {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>`;
  }

  // 空状态文档图标
  function getEmptyIcon() {
    return `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="16" y1="13" x2="8" y2="13"></line>
      <line x1="16" y1="17" x2="8" y2="17"></line>
      <polyline points="10 9 9 9 8 9"></polyline>
    </svg>`;
  }

  function getListIcon() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"></line>
      <line x1="8" y1="12" x2="21" y2="12"></line>
      <line x1="8" y1="18" x2="21" y2="18"></line>
      <line x1="3" y1="6" x2="3.01" y2="6"></line>
      <line x1="3" y1="12" x2="3.01" y2="12"></line>
      <line x1="3" y1="18" x2="3.01" y2="18"></line>
    </svg>`;
  }

  function getDetailIcon() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"></rect>
      <rect x="14" y="3" width="7" height="7" rx="1"></rect>
      <rect x="3" y="14" width="7" height="7" rx="1"></rect>
      <rect x="14" y="14" width="7" height="7" rx="1"></rect>
    </svg>`;
  }

  function getUserIcon() {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
      <circle cx="12" cy="7" r="4"></circle>
    </svg>`;
  }

  function getGitIcon() {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"></circle>
      <line x1="3" y1="12" x2="9" y2="12"></line>
      <line x1="15" y1="12" x2="21" y2="12"></line>
    </svg>`;
  }

  function getCalendarIcon() {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
      <line x1="16" y1="2" x2="16" y2="6"></line>
      <line x1="8" y1="2" x2="8" y2="6"></line>
      <line x1="3" y1="10" x2="21" y2="10"></line>
    </svg>`;
  }

  // @todo 待办事项图标 — 勾选框
  function getTodoIcon() {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 11l3 3L22 4"></path>
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
    </svg>`;
  }

  // @emits 触发事件图标 — 闪电
  function getEventEmitIcon() {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
    </svg>`;
  }

  // @listens 监听事件图标 — 耳朵/雷达
  function getEventListenIcon() {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"></path>
      <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3"></path>
    </svg>`;
  }

  // ========== 锁定功能 ==========

  function toggleLock() {
    isLocked = !isLocked;
    updateLockButton();
    if (!isLocked) {
      // 解锁后立即刷新为当前活动文档
      vscode.postMessage({ type: 'webviewReady' });
    }
  }

  function updateLockButton() {
    const lockBtn = document.getElementById('lock-btn');
    if (!lockBtn) return;
    if (isLocked) {
      lockBtn.innerHTML = getLockClosedIcon();
      lockBtn.title = '已锁定 — 点击解锁';
      lockBtn.classList.add('lock-btn-active');
    } else {
      lockBtn.innerHTML = getLockOpenIcon();
      lockBtn.title = '锁定当前视图';
      lockBtn.classList.remove('lock-btn-active');
    }
  }

  function toggleViewMode() {
    isCompactMode = !isCompactMode;
    updateViewToggle();
    // 回写 globalState 持久化用户偏好（跨会话记忆）
    vscode.postMessage({
      type: 'setViewMode',
      payload: { mode: isCompactMode ? 'compact' : 'detail' },
    });
    if (currentClassDoc) {
      renderClassDoc(currentClassDoc);
    }
  }

  // ========== 调试面板 ==========

  function showDebugPanel(content) {
    var panel = document.getElementById('debug-panel');
    var pre = document.getElementById('debug-content');
    if (!panel || !pre) return;
    pre.textContent = content;
    panel.style.display = 'block';
  }

  function hideDebugPanel() {
    var panel = document.getElementById('debug-panel');
    if (panel) panel.style.display = 'none';
  }

  function updateViewToggle() {
    const btn = document.getElementById('viewToggle');
    if (!btn) return;
    btn.innerHTML = isCompactMode ? getDetailIcon() : getListIcon();
    btn.title = isCompactMode ? '切换到详细视图' : '切换到简洁视图';
  }

  function getLockClosedIcon() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>`;
  }

  function getLockOpenIcon() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
      <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
    </svg>`;
  }

  // ========== 启动 ==========
  init();
})();
