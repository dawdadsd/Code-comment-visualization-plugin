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
  const collapsedMethods = new Set();
  const collapsedGroups = new Set();   // 记录被折叠的分组
  let isCompactMode = true;

  // ========== 初始化 ==========
  function init() {
    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'webviewReady' });
  }

  // ========== 消息处理 ==========
  function handleMessage(event) {
    const message = event.data;

    switch (message.type) {
      case 'updateView':
        currentClassDoc = message.payload;
        renderClassDoc(message.payload);
        break;

      case 'highlightMethod':
        highlightMethod(message.payload.id);
        break;

      case 'clearView':
        currentClassDoc = null;
        renderEmptyState('打开支持的文件以查看文档');
        break;

      case 'updateMarkdown':
        currentClassDoc = null;
        renderMarkdown(message.payload.content, message.payload.fileName);
        break;
    }
  }

  // ========== 渲染函数 ==========

  function renderEmptyState(message) {
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
  function renderMarkdown(content, fileName) {
    const htmlContent = simpleMarkdownToHtml(content);
    root.innerHTML = `
      <div class="markdown-view">
        <div class="markdown-header">
          <div class="markdown-file-name">${escapeHtml(fileName)}</div>
        </div>
        <div class="markdown-body">${htmlContent}</div>
      </div>
    `;
  }

  /**
   * 主渲染入口 —— 分组策略
   */
  function renderClassDoc(classDoc) {
    const constructors = (classDoc.methods || []).filter(m => m.kind === 'constructor');
    const methods = (classDoc.methods || []).filter(m => m.kind === 'method');
    const fields = classDoc.fields || [];
    const enumConstants = classDoc.enumConstants || [];

    const hasContent = constructors.length > 0 || methods.length > 0
      || fields.length > 0 || enumConstants.length > 0;

    if (!classDoc || !hasContent) {
      renderEmptyState('该类没有成员定义');
      return;
    }

    let html = '';

    // 头部：类信息 + 切换按钮
    html += `
      <div class="header">
        <div class="header-top">
          <div class="class-info">
            <div class="class-name">${escapeHtml(classDoc.className)}</div>
            ${classDoc.packageName ? `<div class="package-name">${escapeHtml(classDoc.packageName)}</div>` : ''}
          </div>
          <button class="view-toggle" id="viewToggle" title="${isCompactMode ? '切换到详细视图' : '切换到简洁视图'}">
            ${isCompactMode ? getListIcon() : getDetailIcon()}
          </button>
        </div>
        ${renderAuthorInfo(classDoc)}
        ${classDoc.classComment ? `<div class="class-comment">${escapeHtml(classDoc.classComment)}</div>` : ''}
      </div>
    `;

    // 分组渲染（空组自动隐藏）
    html += '<div class="member-groups">';

    if (constructors.length > 0) {
      html += renderGroup('constructors', '构造函数', getConstructorIcon(), constructors, renderMethodItem);
    }
    if (methods.length > 0) {
      html += renderGroup('methods', '方法', getMethodIcon(), methods, renderMethodItem);
    }
    if (enumConstants.length > 0 || fields.length > 0) {
      html += renderFieldGroup(fields, enumConstants);
    }

    html += '</div>';

    root.innerHTML = html;
    bindEvents();
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
  function renderFieldGroup(fields, enumConstants) {
    const isGroupCollapsed = collapsedGroups.has('fields');
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
      <div class="member-group ${collapsedClass}" data-group="fields">
        <div class="group-header" data-group="fields">
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
    const noCommentClass = method.hasComment ? '' : 'no-comment';
    const firstLine = getFirstLine(method.description);
    const returnType = method.tags?.returns?.type || 'void';
    const kindIcon = method.kind === 'constructor' ? getConstructorIcon() : getMethodIcon();

    const params = method.tags?.params || [];
    const paramsStr = params.length > 0
      ? params.map(p => `${p.type} ${p.name}`).join(', ')
      : '无参数';

    // 构造函数不显示返回类型
    const returnHtml = method.kind === 'constructor' ? '' : `
      <div class="method-meta-row">
        <span class="meta-label">返回类型:</span>
        <span class="meta-value type-value">${escapeHtml(returnType)}</span>
      </div>
    `;

    return `
      <div class="method-item compact ${noCommentClass}" data-id="${escapeHtml(method.id)}" data-line="${method.startLine}">
        <div class="method-compact-header">
          <span class="item-kind-icon" title="${method.kind === 'constructor' ? '构造函数' : '方法'}">${kindIcon}</span>
          <span class="method-name">${escapeHtml(method.name)}</span>
          <span class="method-access">${escapeHtml(method.accessModifier)}</span>
        </div>
        <div class="method-compact-meta">
          ${returnHtml}
          <div class="method-meta-row">
            <span class="meta-label">参数:</span>
            <span class="meta-value params-value">${escapeHtml(paramsStr)}</span>
          </div>
        </div>
        ${firstLine
          ? `<div class="method-desc-preview">${escapeHtml(firstLine)}</div>`
          : (method.hasComment ? '' : '<div class="method-desc-preview no-doc">无注释</div>')}
      </div>
    `;
  }

  /**
   * 详细模式
   */
  function renderMethodDetail(method) {
    const isCollapsed = collapsedMethods.has(method.id);
    const noCommentClass = method.hasComment ? '' : 'no-comment';
    const collapsedClass = isCollapsed ? 'collapsed' : '';
    const returnType = method.tags?.returns?.type || 'void';
    const kindIcon = method.kind === 'constructor' ? getConstructorIcon() : getMethodIcon();

    const params = method.tags?.params || [];
    const paramsStr = params.length > 0
      ? params.map(p => `${p.type} ${p.name}`).join(', ')
      : '无参数';

    let contentHtml = '';

    if (method.hasComment) {
      if (method.description) {
        contentHtml += `<div class="method-description">${escapeHtml(method.description)}</div>`;
      }

      if (method.tags.doc) {
        contentHtml += renderDocSection(method.tags.doc);
      }

      if (method.tags.deprecated) {
        contentHtml += `
          <div class="deprecated-tag">
            <span class="other-tag-name">@deprecated</span>
            ${escapeHtml(method.tags.deprecated)}
          </div>
        `;
      }

      if (method.tags.params && method.tags.params.length > 0) {
        contentHtml += renderParamsTable(method.tags.params);
      }

      if (method.tags.returns) {
        contentHtml += renderReturnsTable(method.tags.returns);
      }

      if (method.tags.throws && method.tags.throws.length > 0) {
        contentHtml += renderThrowsTable(method.tags.throws);
      }

      contentHtml += renderOtherTags(method.tags);
    } else {
      contentHtml += '<div class="no-comment-hint">无注释</div>';
    }

    // 构造函数不显示返回类型
    const returnHtml = method.kind === 'constructor' ? '' : `
      <span class="detail-meta-item">
        <span class="detail-label">返回:</span>
        <span class="detail-type">${escapeHtml(returnType)}</span>
      </span>
    `;

    return `
      <div class="method-item detail ${noCommentClass} ${collapsedClass}" data-id="${escapeHtml(method.id)}">
        <div class="method-header" data-line="${method.startLine}">
          <span class="collapse-icon">${getCollapseIcon()}</span>
          <div class="method-info">
            <div class="method-name-row">
              <span class="item-kind-icon" title="${method.kind === 'constructor' ? '构造函数' : '方法'}">${kindIcon}</span>
              <span class="method-name">${escapeHtml(method.name)}</span>
              <span class="access-badge">${escapeHtml(method.accessModifier)}</span>
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
        <div class="method-content">
          ${contentHtml}
        </div>
      </div>
    `;
  }

  // ========== 字段渲染 ==========

  /**
   * 渲染普通字段项
   */
  function renderFieldItem(field) {
    const noCommentClass = field.hasComment ? '' : 'no-comment';
    const constantBadge = field.isConstant ? '<span class="constant-badge">const</span>' : '';
    const icon = field.isConstant ? getConstantIcon() : getFieldIcon();

    return `
      <div class="field-item ${noCommentClass}" data-line="${field.startLine}">
        <div class="field-header">
          <span class="item-kind-icon" title="${field.isConstant ? '常量' : '字段'}">${icon}</span>
          <span class="field-name">${escapeHtml(field.name)}</span>
          <span class="field-type">${escapeHtml(field.type)}</span>
          ${constantBadge}
          <span class="method-access">${escapeHtml(field.accessModifier)}</span>
        </div>
        ${field.description
          ? `<div class="field-description">${escapeHtml(getFirstLine(field.description))}</div>`
          : (field.hasComment ? '' : '<div class="field-description no-doc">无注释</div>')}
      </div>
    `;
  }

  /**
   * 渲染枚举常量项
   */
  function renderEnumConstantItem(ec) {
    const noCommentClass = ec.hasComment ? '' : 'no-comment';
    const argsHtml = ec.arguments
      ? `<span class="enum-args">${escapeHtml(ec.arguments)}</span>`
      : '';

    return `
      <div class="field-item enum-constant ${noCommentClass}" data-line="${ec.startLine}">
        <div class="field-header">
          <span class="item-kind-icon" title="枚举常量">${getEnumConstantIcon()}</span>
          <span class="field-name enum-name">${escapeHtml(ec.name)}</span>
          ${argsHtml}
        </div>
        ${ec.description
          ? `<div class="field-description">${escapeHtml(getFirstLine(ec.description))}</div>`
          : (ec.hasComment ? '' : '<div class="field-description no-doc">无注释</div>')}
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
        <table class="tag-table">
          <thead>
            <tr>
              <th style="width: 20%">名称</th>
              <th style="width: 25%">类型</th>
              <th style="width: 55%">描述</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderReturnsTable(returns) {
    return `
      <div class="tag-section">
        <div class="tag-title">返回值 Returns</div>
        <table class="tag-table">
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
        </table>
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
        <table class="tag-table">
          <thead>
            <tr>
              <th style="width: 40%">异常类型</th>
              <th style="width: 60%">触发条件</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
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
          html += `<div class="other-tag"><span class="other-tag-name">@see</span>${escapeHtml(see)}</div>`;
        }
      }

      html += '</div>';
    }

    return html;
  }

  // ========== 交互处理 ==========

  function bindEvents() {
    root.addEventListener('click', handleClick);
  }

  function handleClick(event) {
    const target = event.target;

    // 切换视图按钮
    if (target.closest('#viewToggle')) {
      isCompactMode = !isCompactMode;
      if (currentClassDoc) {
        renderClassDoc(currentClassDoc);
      }
      return;
    }

    // 分组折叠/展开
    const groupHeader = target.closest('.group-header');
    if (groupHeader) {
      const groupId = groupHeader.dataset.group;
      if (groupId) {
        toggleGroupCollapse(groupId);
      }
      return;
    }

    // 字段/枚举常量点击 → 跳转
    const fieldItem = target.closest('.field-item');
    if (fieldItem) {
      const line = parseInt(fieldItem.dataset.line, 10);
      if (!isNaN(line)) {
        vscode.postMessage({ type: 'jumpToLine', payload: { line } });
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

    // 详细模式：点击头部
    const methodHeader = target.closest('.method-header');
    if (methodHeader) {
      const methodItem = methodHeader.closest('.method-item');
      const methodId = methodItem?.dataset.id;
      const line = parseInt(methodHeader.dataset.line, 10);

      const collapseIcon = target.closest('.collapse-icon');
      if (collapseIcon && methodId) {
        toggleCollapse(methodId);
      } else if (!isNaN(line)) {
        vscode.postMessage({ type: 'jumpToLine', payload: { line } });
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
    const allItems = document.querySelectorAll('.method-item');
    allItems.forEach(item => item.classList.remove('active'));

    const targetItem = document.querySelector(`.method-item[data-id="${methodId}"]`);
    if (targetItem) {
      targetItem.classList.add('active');
      targetItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
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
        <div class="doc-section-content">${escapeHtml(docContent)}</div>
      </div>
    `;
  }

  // ========== Markdown 渲染 ==========

  function simpleMarkdownToHtml(text) {
    if (!text) return '';

    let html = text.replace(/\r\n/g, '\n');

    // 代码块（必须在行内规则之前处理）
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      return '\n<pre class="md-code-block"><code>' + escapeHtml(code.trimEnd()) + '</code></pre>\n';
    });

    const lines = html.split('\n');
    const result = [];
    let inList = false;
    let listType = '';
    let inBlockquote = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 跳过已处理的代码块标签
      if (line.startsWith('<pre class="md-code-block">') || line === '</pre>') {
        if (inList) { result.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
        if (inBlockquote) { result.push('</blockquote>'); inBlockquote = false; }
        result.push(line);
        continue;
      }

      // 水平线
      if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
        if (inList) { result.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
        if (inBlockquote) { result.push('</blockquote>'); inBlockquote = false; }
        result.push('<hr>');
        continue;
      }

      // 标题
      const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
      if (headingMatch) {
        if (inList) { result.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
        if (inBlockquote) { result.push('</blockquote>'); inBlockquote = false; }
        const level = headingMatch[1].length;
        result.push('<h' + level + ' class="md-heading">' + applyInline(headingMatch[2]) + '</h' + level + '>');
        continue;
      }

      // 引用
      const bqMatch = /^>\s?(.*)$/.exec(line);
      if (bqMatch) {
        if (inList) { result.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
        if (!inBlockquote) { result.push('<blockquote class="md-blockquote">'); inBlockquote = true; }
        result.push('<p>' + applyInline(bqMatch[1]) + '</p>');
        continue;
      } else if (inBlockquote) {
        result.push('</blockquote>');
        inBlockquote = false;
      }

      // 无序列表
      const ulMatch = /^[\s]*[-*+]\s+(.+)$/.exec(line);
      if (ulMatch) {
        if (!inList || listType !== 'ul') {
          if (inList) result.push(listType === 'ul' ? '</ul>' : '</ol>');
          result.push('<ul class="md-list">');
          inList = true;
          listType = 'ul';
        }
        result.push('<li>' + applyInline(ulMatch[1]) + '</li>');
        continue;
      }

      // 有序列表
      const olMatch = /^[\s]*\d+\.\s+(.+)$/.exec(line);
      if (olMatch) {
        if (!inList || listType !== 'ol') {
          if (inList) result.push(listType === 'ul' ? '</ul>' : '</ol>');
          result.push('<ol class="md-list">');
          inList = true;
          listType = 'ol';
        }
        result.push('<li>' + applyInline(olMatch[1]) + '</li>');
        continue;
      }

      // 关闭列表
      if (inList) {
        result.push(listType === 'ul' ? '</ul>' : '</ol>');
        inList = false;
      }

      // 空行
      if (line.trim() === '') {
        result.push('');
        continue;
      }

      // 普通段落
      result.push('<p>' + applyInline(line) + '</p>');
    }

    if (inList) result.push(listType === 'ul' ? '</ul>' : '</ol>');
    if (inBlockquote) result.push('</blockquote>');

    return result.join('\n');
  }

  /**
   * 行内 Markdown 格式：粗体、斜体、行内代码、链接、图片
   */
  function applyInline(text) {
    // 行内代码（最先处理，防止内部被其他规则匹配）
    text = text.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
    // 图片
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" class="md-image">');
    // 链接
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link">$1</a>');
    // 粗斜体
    text = text.replace(/(\*{3}|_{3})(?=\S)([\s\S]*?\S)\1/g, '<strong><em>$2</em></strong>');
    // 粗体
    text = text.replace(/(\*{2}|_{2})(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
    // 斜体
    text = text.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '<em>$2</em>');
    return text;
  }

  // ========== 工具函数 ==========

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

  // 构造函数图标 — 齿轮/扳手风格，表示"构建"
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

  // ========== 启动 ==========
  init();
})();
