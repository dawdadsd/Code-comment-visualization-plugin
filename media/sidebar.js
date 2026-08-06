/**
 * sidebar.js - Webview 前端交互逻辑
 *
 * 【渲染架构】
 * ClassDoc 数据按三个分组渲染，每组独立折叠：
 *   1. 构造函数（constructors） — 从 methods 中 kind === "constructor" 筛出
 *   2. 方法（methods）          — 从 methods 中 kind === "method" 筛出
 *   3. 字段（fields）           — 合并 fields + enumConstants，用图标区分
 *
 * 空组自动隐藏，不占用任何空间。
 */

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  // ========== 状态 ==========
  let currentClassDoc = null;
  let currentMarkdownImageMap = {};
  const collapsedMethods = new Set();
  const collapsedGroups = new Set();   // 记录被折叠的分组
  const collapsedTypeGroups = new Set(); // 记录被折叠的类型组（多类型文件）
  let isCompactMode = true;
  let isLocked = false;
  // 当前高亮目标（用于切换视图模式后恢复焦点）
  // { kind: 'method', id } | { kind: 'field', line } | null
  let currentHighlight = null;

  // ========== 初始化 ==========
  function init() {
    window.addEventListener('message', handleMessage);
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

    // 注册 KaTeX 渲染回调 —— KaTeX auto-render 加载完成后调用
    window.__renderMath = function () {
      try {
        if (window.renderMathInElement && root) {
          window.renderMathInElement(root, {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '$', right: '$', display: false },
            ],
            throwOnError: false,
          });
        }
      } catch (e) {
        // KaTeX 未加载或渲染失败，静默忽略
      }
    };

    // 注册 Mermaid 初始化回调 —— mermaid.js 加载完成后调用
    window.__initMermaid = function () {
      try {
        if (window.mermaid) {
          window.mermaid.initialize({
            startOnLoad: false,
            theme: document.body.classList.contains('vscode-light') ? 'default' : 'dark',
            securityLevel: 'loose',
          });
        }
      } catch (e) {
        // mermaid 初始化失败，静默忽略
      }
    };

    // 渲染 Mermaid 图表
    window.__renderMermaid = function () {
      try {
        if (window.mermaid && root) {
          const elements = root.querySelectorAll('.mermaid:not([data-processed])');
          if (elements.length > 0) {
            window.mermaid.run({ nodes: elements });
          }
        }
      } catch (e) {
        // mermaid 渲染失败，静默忽略
      }
    };

    // highlight.js 代码高亮回调
    window.__highlightCode = function () {
      try {
        if (window.hljs && root) {
          root.querySelectorAll('pre.md-code-block code').forEach(function (block) {
            if (!block.dataset.highlighted) {
              window.hljs.highlightElement(block);
              block.dataset.highlighted = 'true';
            }
          });
        }
      } catch (e) {
        // 高亮失败，静默忽略
      }
    };

    vscode.postMessage({ type: 'webviewReady' });
  }

  // ========== 消息处理 ==========
  function handleMessage(event) {
    const message = event.data;

    switch (message.type) {
      case 'updateView':
        if (isLocked) break;
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

      case 'clearView':
        if (isLocked) break;
        currentClassDoc = null;
        renderEmptyState('打开支持的文件以查看文档');
        break;

      case 'updateMarkdown':
        if (isLocked) break;
        currentClassDoc = null;
        currentMarkdownImageMap = message.payload.imageMap || {};
        renderMarkdown(
          message.payload.content,
          message.payload.fileName,
          currentMarkdownImageMap,
        );
        break;
    }
  }

  // ========== 渲染函数 ==========

  function renderEmptyState(message) {
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
    const htmlContent = markdownToHtml(content, imageMap || {});
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
    if (window.__renderMath) window.__renderMath();
    if (window.__renderMermaid) window.__renderMermaid();
    if (window.__highlightCode) window.__highlightCode();
  }

  /**
   * 主渲染入口 —— 按 belongsTo 分组
   *
   * 单一类型（常见于 Java 单类文件）：标题 + 构造函数/方法/字段三组。
   * 多类型（C++ 多 struct、JS 多组件等）：每个类型一个分隔标题 + 各自的分组。
   */
  function renderClassDoc(classDoc) {
    const allMethods = classDoc.methods || [];
    const allFields = classDoc.fields || [];
    const allEnumConstants = classDoc.enumConstants || [];

    const hasContent = allMethods.length > 0 || allFields.length > 0
      || allEnumConstants.length > 0;

    if (!classDoc || !hasContent) {
      renderEmptyState('未识别到可显示的成员');
      return;
    }

    // 按 belongsTo 分组
    const groupMap = new Map();
    const getGroup = (key) => {
      if (!groupMap.has(key)) {
        groupMap.set(key, { constructors: [], methods: [], fields: [], enumConstants: [] });
      }
      return groupMap.get(key);
    };

    // 没有类/接口/枚举的文件（typeGroups 为空）也套一个 "Unknown" 类型卡片
    const hasNoTypeGroups = !classDoc.typeGroups || classDoc.typeGroups.length === 0;
    const fallbackKey = hasNoTypeGroups ? 'Unknown' : (classDoc.className || 'Unknown');
    for (const m of allMethods) {
      const key = m.belongsTo || fallbackKey;
      if (m.kind === 'constructor') {
        getGroup(key).constructors.push(m);
      } else {
        getGroup(key).methods.push(m);
      }
    }
    for (const f of allFields) {
      const key = f.belongsTo || fallbackKey;
      getGroup(key).fields.push(f);
    }
    for (const ec of allEnumConstants) {
      const key = ec.belongsTo || fallbackKey;
      getGroup(key).enumConstants.push(ec);
    }

    const groups = Array.from(groupMap.entries());
    const isMultiGroup = groups.length > 1;
    // 无类型组时也包装为 Unknown 卡片，保持与多类文件一致的展示风格
    const shouldWrapTypeGroup = isMultiGroup || hasNoTypeGroups;

    // 构建类型注释映射：typeName → {comment, tags}
    const typeGroupMap = new Map();
    if (classDoc.typeGroups) {
      for (const tg of classDoc.typeGroups) {
        typeGroupMap.set(tg.typeName, tg);
      }
    }

    let html = '';

    // 更新 sticky header 标题
    const stickyTitle = document.getElementById('sticky-title');
    if (stickyTitle) {
      stickyTitle.textContent = classDoc.className || '';
    }

    // 文件级注释：
    // 单类型 → 顶部显示该类型的注释（与之前行为一致）
    // 多类型 → 顶部仅显示文件头注释（如果有），各类型注释在各自卡片内渲染
    html += renderClassComment(classDoc);
    const authorInfo = renderAuthorInfo(classDoc);
    if (authorInfo) {
      html += authorInfo;
    }

    html += '<div class="member-groups">';

    for (const [groupKey, group] of groups) {
      // groupId 加 groupKey 前缀，避免多类型时折叠状态冲突
      const gid = isMultiGroup ? `${groupKey}::` : '';

      let groupContent = '';
      if (group.constructors.length > 0) {
        groupContent += renderGroup(`${gid}constructors`, '构造函数', getConstructorIcon(), group.constructors, renderMethodItem);
      }
      if (group.methods.length > 0) {
        groupContent += renderGroup(`${gid}methods`, '方法', getMethodIcon(), group.methods, renderMethodItem);
      }
      if (group.enumConstants.length > 0 || group.fields.length > 0) {
        groupContent += renderFieldGroup(group.fields, group.enumConstants, `${gid}fields`);
      }

      if (shouldWrapTypeGroup) {
        // 查找该类型的注释信息
        const typeInfo = typeGroupMap.get(groupKey);
        html += renderTypeGroup(groupKey, groupContent, typeInfo);
      } else {
        html += groupContent;
      }
    }

    html += '</div>';

    root.innerHTML = html;
    bindEvents();
    if (window.__renderMath) window.__renderMath();
    if (window.__renderMermaid) window.__renderMermaid();
    if (window.__highlightCode) window.__highlightCode();
    // 切换视图模式/重新渲染后恢复焦点定位
    restoreHighlight();
  }

  /**
   * 渲染一个分组（通用模板）
   *
   * @param {string}   groupId   — 分组标识（用于折叠状态）
   * @param {string}   title     — 分组标题
   * @param {string}   iconSvg   — 分组标题旁的图标 SVG
   * @param {Array}    items     — 待渲染的数据项
   * @param {Function} renderFn  — 单项渲染函数
   */
  function renderGroup(groupId, title, iconSvg, items, renderFn) {
    const isGroupCollapsed = collapsedGroups.has(groupId);
    const collapsedClass = isGroupCollapsed ? 'collapsed' : '';

    let itemsHtml = '';
    for (const item of items) {
      itemsHtml += renderFn(item);
    }

    return `
      <div class="member-group ${collapsedClass}" data-group="${groupId}">
        <div class="group-header" data-group="${groupId}">
          <span class="group-collapse-icon">${getCollapseIcon()}</span>
          <span class="group-icon">${iconSvg}</span>
          <span class="group-title">${escapeHtml(title)}</span>
          <span class="group-count">${items.length}</span>
        </div>
        <div class="group-content ${isCompactMode ? 'compact-mode' : 'detail-mode'}">
          ${itemsHtml}
        </div>
      </div>
    `;
  }

  /**
   * 渲染字段分组 —— 合并枚举常量和普通字段
   * 枚举常量排在前面，用图标区分
   */
  function renderFieldGroup(fields, enumConstants, groupId = 'fields') {
    const isGroupCollapsed = collapsedGroups.has(groupId);
    const collapsedClass = isGroupCollapsed ? 'collapsed' : '';
    const totalCount = fields.length + enumConstants.length;

    let itemsHtml = '';

    // 枚举常量在前
    for (const ec of enumConstants) {
      itemsHtml += renderEnumConstantItem(ec);
    }

    // 普通字段在后
    for (const field of fields) {
      itemsHtml += renderFieldItem(field);
    }

    return `
      <div class="member-group ${collapsedClass}" data-group="${escapeHtml(groupId)}">
        <div class="group-header" data-group="${escapeHtml(groupId)}">
          <span class="group-collapse-icon">${getCollapseIcon()}</span>
          <span class="group-icon">${getFieldIcon()}</span>
          <span class="group-title">字段</span>
          <span class="group-count">${totalCount}</span>
        </div>
        <div class="group-content ${isCompactMode ? 'compact-mode' : 'detail-mode'}">
          ${itemsHtml}
        </div>
      </div>
    `;
  }

  /**
   * 渲染类型组 —— 多类型文件中，每个类型（struct/class/interface）的可折叠容器
   *
   * @param {string} typeName — 类型名（如 "SegTree"、"ModPrime"）
   * @param {string} contentHtml — 类型内部的分组 HTML
   * @param {object} [typeInfo] — 类型的注释和标签（可选）
   */
  function renderTypeGroup(typeName, contentHtml, typeInfo) {
    const isCollapsed = collapsedTypeGroups.has(typeName);
    const collapsedClass = isCollapsed ? 'collapsed' : '';
    const dataLine = typeInfo?.startLine != null ? `data-line="${typeInfo.startLine}"` : '';

    // 类型注释（JSDoc/Javadoc 标签渲染）
    let commentHtml = '';
    if (typeInfo) {
      const body = renderCommentBody(typeInfo.comment, typeInfo.tags);
      if (body) {
        commentHtml = `<div class="type-comment">${body}</div>`;
      }
    }

    return `
      <div class="type-group ${collapsedClass}" data-type="${escapeHtml(typeName)}">
        <div class="type-group-header" data-type="${escapeHtml(typeName)}" ${dataLine}>
          <span class="type-collapse-icon">${getCollapseIcon()}</span>
          <span class="type-icon">${getTypeIcon()}</span>
          <span class="type-name">${escapeHtml(typeName)}</span>
        </div>
        <div class="type-group-content">
          ${commentHtml}
          ${contentHtml}
        </div>
      </div>
    `;
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
    const isCollapsed = collapsedMethods.has(method.id);
    const collapsedClass = isCollapsed ? 'collapsed' : '';
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

    const contentSection = contentHtml
      ? `<div class="method-content" data-line="${method.startLine}">${contentHtml}</div>`
      : '';

    return `
      <div class="method-item detail ${collapsedClass}" data-id="${escapeHtml(method.id)}">
        <div class="method-header" data-line="${method.startLine}">
          <span class="collapse-icon">${getCollapseIcon()}</span>
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
   * 渲染普通字段项
   */
  function renderFieldItem(field) {
    const constantBadge = field.isConstant ? '<span class="constant-badge">const</span>' : '';
    const icon = field.isConstant ? getConstantIcon() : getFieldIcon();

    // JSDoc 标签渲染（@deprecated/@todo/@see/@type 等）
    const tagsHtml = field.tags ? renderCommentBody('', field.tags) : '';

    return `
      <div class="field-item" data-line="${field.startLine}">
        <div class="field-header">
          <span class="item-kind-icon" title="${field.isConstant ? '常量' : '字段'}">${icon}</span>
          <span class="field-name">${escapeHtml(field.name)}</span>
          <span class="field-type">${escapeHtml(field.type)}</span>
          ${constantBadge}
          ${field.accessModifier !== 'default' ? `<span class="access-badge">${escapeHtml(field.accessModifier)}</span>` : ''}
        </div>
        ${field.description
          ? `<div class="field-description">${applyInlineMarkdown(getFirstLine(field.description), {})}</div>`
          : ''}
        ${tagsHtml ? `<div class="field-tags">${tagsHtml}</div>` : ''}
      </div>
    `;
  }

  /**
   * 渲染枚举常量项
   */
  function renderEnumConstantItem(ec) {
    const argsHtml = ec.arguments
      ? `<span class="enum-args">${escapeHtml(ec.arguments)}</span>`
      : '';

    return `
      <div class="field-item enum-constant" data-line="${ec.startLine}">
        <div class="field-header">
          <span class="item-kind-icon" title="枚举常量">${getEnumConstantIcon()}</span>
          <span class="field-name enum-name">${escapeHtml(ec.name)}</span>
          ${argsHtml}
        </div>
        ${ec.description
          ? `<div class="field-description">${applyInlineMarkdown(getFirstLine(ec.description), {})}</div>`
          : ''}
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
          html += `<div class="other-tag"><span class="other-tag-name">@see</span>${markdownToHtml(see, {})}</div>`;
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

  function handleClick(event) {
    const target = event.target;

    // JSDoc {@link} 内联链接 — 阻止默认跳转（仅作视觉提示，target 显示在 title）
    const jsdocLink = target.closest('.jsdoc-link');
    if (jsdocLink) {
      event.preventDefault();
      return;
    }

    // Markdown 链接：外部链接放行浏览器处理，本地链接交给宿主打开
    const mdLink = target.closest('a.md-link');
    if (mdLink) {
      const href = mdLink.getAttribute('href') || '';
      const isExternal = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href);
      if (!isExternal) {
        event.preventDefault();
        vscode.postMessage({ type: 'openMarkdownLink', payload: { href } });
      }
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
        // 点击头部其他位置 → 跳转到类定义行
        const line = parseInt(typeGroupHeader.dataset.line, 10);
        if (!isNaN(line)) {
          vscode.postMessage({ type: 'jumpToLine', payload: { line } });
        }
      }
      return;
    }

    // 类卡片正文注释区点击 → 跳转到类定义行
    // 排除链接、代码块、折叠块、Mermaid 图等交互元素
    const typeComment = target.closest('.type-comment');
    if (typeComment) {
      if (!event.target.closest('a, details, pre, .md-mermaid-block')) {
        const typeGroup = typeComment.closest('.type-group');
        const header = typeGroup && typeGroup.querySelector('.type-group-header');
        const line = parseInt(header && header.dataset.line, 10);
        if (!isNaN(line)) {
          vscode.postMessage({ type: 'jumpToLine', payload: { line } });
        }
      }
      return;
    }

    // 分组：仅三角形可折叠/展开，头部其他位置无操作
    const groupHeader = target.closest('.group-header');
    if (groupHeader) {
      const groupId = groupHeader.dataset.group;
      const collapseIcon = target.closest('.group-collapse-icon');
      if (collapseIcon && groupId) {
        toggleGroupCollapse(groupId);
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
          vscode.postMessage({ type: 'jumpToLine', payload: { line } });
        }
      }
      return;
    }

    // 简洁模式：点击整个条目跳转
    const compactItem = target.closest('.method-item.compact');
    if (compactItem) {
      const line = parseInt(compactItem.dataset.line, 10);
      if (!isNaN(line)) {
        vscode.postMessage({ type: 'jumpToLine', payload: { line } });
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
        document.querySelectorAll('.method-item').forEach(item => item.classList.remove('active'));
        detailItem.classList.add('active');
      }

      // 点击头部 → 折叠/跳转（无论是否刚聚焦，都立即响应）
      const methodHeader = target.closest('.method-header');
      if (methodHeader) {
        const line = parseInt(methodHeader.dataset.line, 10);
        const collapseIcon = target.closest('.collapse-icon');
        if (collapseIcon && methodId) {
          toggleCollapse(methodId);
        } else if (!isNaN(line)) {
          vscode.postMessage({ type: 'jumpToLine', payload: { line } });
        }
        return;
      }

      // 点击注释区域 → 跳转（排除交互元素），无论是否刚聚焦都立即响应
      const methodContent = target.closest('.method-content');
      if (methodContent) {
        if (!target.closest('a, details, pre, .md-mermaid-block')) {
          const line = parseInt(methodContent.dataset.line, 10);
          if (!isNaN(line)) {
            vscode.postMessage({ type: 'jumpToLine', payload: { line } });
          }
        }
        return;
      }
    }
  }

  function toggleGroupCollapse(groupId) {
    const groupEl = document.querySelector(`.member-group[data-group="${groupId}"]`);
    if (!groupEl) return;

    if (collapsedGroups.has(groupId)) {
      collapsedGroups.delete(groupId);
      groupEl.classList.remove('collapsed');
    } else {
      collapsedGroups.add(groupId);
      groupEl.classList.add('collapsed');
    }
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
  }

  function highlightMethod(methodId) {
    // 清除所有高亮
    document.querySelectorAll('.method-item, .field-item').forEach(item => item.classList.remove('active'));

    const targetItem = document.querySelector(`.method-item[data-id="${methodId}"]`);
    if (targetItem) {
      targetItem.classList.add('active');
      scrollToItem(targetItem);
    }
    currentHighlight = { kind: 'method', id: methodId };
  }

  function highlightField(line) {
    // 清除所有高亮
    document.querySelectorAll('.method-item, .field-item').forEach(item => item.classList.remove('active'));

    const targetItem = document.querySelector(`.field-item[data-line="${line}"]`);
    if (targetItem) {
      targetItem.classList.add('active');
      scrollToItem(targetItem);
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
   * 以顶部为基准：计算驻留层高度，让目标显示在所有 sticky header 下方
   */
  function scrollToItem(targetItem) {
    const stickyOffset = getStickyOffset(targetItem);
    const rect = targetItem.getBoundingClientRect();
    const targetScroll = window.scrollY + rect.top - stickyOffset - 8;
    window.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
  }

  /**
   * 计算目标元素上方所有驻留层的高度总和
   * #sticky-header (35px) + .type-group-header (40px) + .group-header (35px)
   */
  function getStickyOffset(element) {
    let offset = 35; // #sticky-header
    if (element.closest('.type-group')) {
      offset += 40; // .type-group-header
    }
    if (element.closest('.member-group')) {
      offset += 35; // .group-header
    }
    return offset;
  }

  // ========== @doc 渲染 ==========

  function renderDocSection(docContent) {
    if (!docContent) return '';
    return `
      <div class="doc-section">
        <div class="doc-section-header">
          ${getBookIcon()}
          <span class="doc-section-title">设计原理 @doc</span>
        </div>
        <div class="doc-section-content">${markdownToHtml(docContent, {})}</div>
      </div>
    `;
  }

  function renderExampleSection(exampleContent) {
    if (!exampleContent) return '';
    return `
      <div class="example-section">
        <div class="example-section-header">
          ${getCodeIcon()}
          <span class="example-section-title">示例 @example</span>
        </div>
        <pre class="example-section-content"><code>${escapeHtml(exampleContent)}</code></pre>
      </div>
    `;
  }

  // ========== Markdown 渲染 ==========

  const CODE_BLOCK_TOKEN_PREFIX = '__MD_CODE_BLOCK_';
  const INLINE_TOKEN_PREFIX = '__MD_INLINE_';
  const TABLE_SEPARATOR_PATTERN = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
  const LIST_ITEM_PATTERN = /^(\s*)([-+*]|\d+\.)\s+(.+)$/;

  function markdownToHtml(text, imageMap) {
    if (!text) return '';

    const source = text.replace(/\r\n?/g, '\n');
    const codeBlocks = [];
    const withCodeTokens = source.replace(
      /```([^\n`]*)\n([\s\S]*?)```/g,
      function (_, rawLang, rawCode) {
        const lang = normalizeCodeLanguage(rawLang);
        const code = rawCode.replace(/\n$/, '');
        const token = createCodeBlockToken(codeBlocks.length);
        if (lang === 'mermaid') {
          codeBlocks.push('<div class="md-mermaid"><pre class="mermaid">' + escapeHtml(code) + '</pre></div>');
        } else {
          codeBlocks.push(renderMarkdownCodeBlock(lang, code));
        }
        return '\n' + token + '\n';
      },
    );

    // 保护块级公式 $$ ... $$，避免被 Markdown 语法破坏
    const mathBlocks = [];
    const withMathTokens = withCodeTokens.replace(
      /\$\$([\s\S]+?)\$\$/g,
      function (_, formula) {
        const token = '__MD_MATH_BLOCK_' + mathBlocks.length + '__';
        mathBlocks.push('$$' + formula + '$$');
        return '\n' + token + '\n';
      },
    );

    const lines = withMathTokens.split('\n');
    const blocks = [];

    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      const trimmed = line.trim();

      if (!trimmed) {
        index += 1;
        continue;
      }

      const codeTokenIndex = parseCodeBlockToken(trimmed);
      if (codeTokenIndex !== null) {
        blocks.push(codeBlocks[codeTokenIndex] || '');
        index += 1;
        continue;
      }

      // 块级公式 token
      const mathTokenMatch = /^__MD_MATH_BLOCK_(\d+)__$/.exec(trimmed);
      if (mathTokenMatch) {
        const mathIndex = parseInt(mathTokenMatch[1], 10);
        const formula = mathBlocks[mathIndex] || '';
        blocks.push('<div class="md-math-block">' + escapeHtml(formula) + '</div>');
        index += 1;
        continue;
      }

      const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (headingMatch) {
        const level = headingMatch[1].length;
        blocks.push(
          '<h' +
            level +
            ' class="md-heading">' +
            applyInlineMarkdown(headingMatch[2], imageMap) +
            '</h' +
            level +
            '>',
        );
        index += 1;
        continue;
      }

      if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(trimmed)) {
        blocks.push('<hr>');
        index += 1;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const blockquote = renderMarkdownBlockquote(lines, index, imageMap);
        blocks.push(blockquote.html);
        index = blockquote.nextIndex;
        continue;
      }

      if (isMarkdownTableStart(lines, index)) {
        const table = renderMarkdownTable(lines, index, imageMap);
        blocks.push(table.html);
        index = table.nextIndex;
        continue;
      }

      if (LIST_ITEM_PATTERN.test(line)) {
        const list = renderMarkdownList(lines, index, imageMap);
        blocks.push(list.html);
        index = list.nextIndex;
        continue;
      }

      const paragraph = renderMarkdownParagraph(lines, index, imageMap);
      blocks.push(paragraph.html);
      index = paragraph.nextIndex;
    }

    return blocks.join('\n');
  }

  function createCodeBlockToken(index) {
    return CODE_BLOCK_TOKEN_PREFIX + index + '__';
  }

  function parseCodeBlockToken(value) {
    const tokenMatch = /^__MD_CODE_BLOCK_(\d+)__$/.exec(value);
    if (!tokenMatch) {
      return null;
    }
    return Number(tokenMatch[1]);
  }

  function normalizeCodeLanguage(rawLang) {
    return String(rawLang || '').trim().toLowerCase();
  }

  function renderMarkdownCodeBlock(language, code) {
    if (language === 'mermaid') {
      return renderMermaidDiagram(code);
    }

    const safeLanguage = escapeHtml(language || 'text');
    const escapedCode = escapeHtml(code);
    const langClass = language ? ` class="language-${safeLanguage}"` : '';

    return (
      '<pre class="md-code-block" data-language="' +
      safeLanguage +
      '"><code' + langClass + '>' +
      escapedCode +
      '</code></pre>'
    );
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

    const innerHtml = markdownToHtml(quoteLines.join('\n'), imageMap);
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
    return header.includes('|') && TABLE_SEPARATOR_PATTERN.test(separator.trim());
  }

  function renderMarkdownTable(lines, startIndex, imageMap) {
    const headerCells = splitTableRow(lines[startIndex]);
    const alignments = parseTableAlignments(lines[startIndex + 1]);
    const rows = [];
    let index = startIndex + 2;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim() || !line.includes('|')) {
        break;
      }
      if (parseCodeBlockToken(line.trim()) !== null) {
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
    for (const row of rows) {
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
      bodyHtml += '<tr>' + rowHtml + '</tr>';
    }

    const html =
      '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
      headerHtml +
      '</tr></thead><tbody>' +
      bodyHtml +
      '</tbody></table></div></div>';

    return { html, nextIndex: index };
  }

  function splitTableRow(line) {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|').map(function (cell) {
      return cell.trim();
    });
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

  function renderMarkdownList(lines, startIndex, imageMap) {
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

      if (parseCodeBlockToken(trimmed) !== null) {
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

      htmlParts.push('<li>' + applyInlineMarkdown(content, imageMap));
      index += 1;
    }

    while (stack.length > 0) {
      const closeType = stack.pop().type;
      htmlParts.push('</li></' + closeType + '>');
    }

    return { html: htmlParts.join(''), nextIndex: index };
  }

  function renderMarkdownParagraph(lines, startIndex, imageMap) {
    const paragraphLines = [];
    let index = startIndex;

    while (index < lines.length) {
      const line = lines[index];
      const trimmed = line.trim();

      if (!trimmed) {
        break;
      }
      if (parseCodeBlockToken(trimmed) !== null) {
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

    const html =
      '<p>' +
      applyInlineMarkdown(paragraphLines.join('\n'), imageMap).replace(
        /\n/g,
        '<br>',
      ) +
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
        '<a class="jsdoc-link" href="#" data-target="' + escapeHtml(target) + '" title="' + escapeHtml(target) + '">' + labelHtml + '</a>',
      );
    });

    content = content.replace(/`([^`]+)`/g, function (_, codeText) {
      return stash(
        '<code class="md-inline-code">' + escapeHtml(codeText) + '</code>',
      );
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

    for (let index = 0; index < tokens.length; index += 1) {
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
    const targetAttrs = isExternal
      ? ' target="_blank" rel="noopener noreferrer"'
      : '';

    return (
      '<a class="md-link" href="' +
      safeTarget +
      '"' +
      targetAttrs +
      '>' +
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
    return `<div class="class-comment">${inner}</div>`;
  }

  // ========== 作者信息 ==========

  function renderAuthorInfo(classDoc) {
    const hasJavadocAuthor = classDoc.javadocAuthor;
    const hasGitInfo = classDoc.gitInfo;

    if (!hasJavadocAuthor && !hasGitInfo) {
      return '';
    }

    let html = '<div class="author-info">';

    if (hasJavadocAuthor) {
      html += `
        <div class="author-item" title="来自 @author 标签">
          ${getUserIcon()}
          <span class="author-label">作者:</span>
          <span class="author-value">${escapeHtml(classDoc.javadocAuthor)}</span>
        </div>
      `;
    }

    if (classDoc.javadocSince) {
      html += `
        <div class="author-item" title="来自 @since 标签">
          ${getCalendarIcon()}
          <span class="author-label">创建:</span>
          <span class="author-value">${escapeHtml(classDoc.javadocSince)}</span>
        </div>
      `;
    }

    if (hasGitInfo) {
      if (!hasJavadocAuthor && classDoc.gitInfo.author) {
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
    if (currentClassDoc) {
      renderClassDoc(currentClassDoc);
    }
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
