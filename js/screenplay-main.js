/* Screenplay Writer v3.0 — Nextcloud + Fountain */
(function () {
  'use strict';

  var DAV_ROOT = '/remote.php/dav/files/' + (window._SP_USER || '') + '/Screenplays';

  var TYPES = [
    { id: 'scene-heading', shortLabel: '場景', hint: 'INT./EXT. 場所 - 時間' },
    { id: 'action', shortLabel: '動作', hint: '動作描述' },
    { id: 'character', shortLabel: '角色', hint: '角色名稱（大寫）' },
    { id: 'parenthetical', shortLabel: '括注', hint: '（語氣／動作）' },
    { id: 'dialogue', shortLabel: '對話', hint: '角色台詞' },
    { id: 'transition', shortLabel: '轉場', hint: '轉場效果' },
    { id: 'general', shortLabel: '一般', hint: '一般文字' },
  ];

  /* ── state ── */
  var st = {
    files: [], loading: false, error: null,
    currentPath: null, currentTitle: '未命名劇本',
    blocks: [], focusedIdx: -1,
    selectionMode: false, selectedBlocks: [], clipboard: [],
    nextId: 1, lastSaved: null,
  };

  /* ════ Fountain ════ */
  function blocksToFountain(blocks) {
    var out = [], prevType = null;
    blocks.forEach(function (b) {
      var t = b.type, s = b.text.trim();
      if (!s) { prevType = t; return; }

      if (t === 'scene-heading') {
        out.push('');
        out.push(/^(INT|EXT|INT\.\/EXT|I\/E)[\s\.]/i.test(s) ? s.toUpperCase() : '.' + s.toUpperCase());
        out.push('');
      } else if (t === 'action') {
        out.push('');
        out.push(s);
        out.push('');
      } else if (t === 'character') {
        out.push('');
        out.push(s.toUpperCase());
      } else if (t === 'parenthetical') {
        out.push(s.startsWith('(') ? s : '(' + s + ')');
      } else if (t === 'dialogue') {
        // 如果前一个也是对话，说明是同一段对话的多个段落，加一个空行分隔
        /*if (prevType === 'dialogue') {
          out.push('');
        }*/
        out.push(s);
      } else if (t === 'transition') {
        out.push('');
        out.push('> ' + s.toUpperCase());
        out.push('');
      } else {
        out.push(s);
        out.push('');
      }
      prevType = t;
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function fountainToBlocks(text) {
    var lines = text.split('\n');
    var blocks = [], id = 1, i = 0;
    while (i < lines.length) {
      var line = lines[i].trim();
      if (!line) { i++; continue; }

      // scene heading
      if (/^(INT|EXT|INT\.\/EXT|I\/E)[\s\.]/i.test(line) || /^\.[A-Z]/.test(line)) {
        blocks.push({ id: id++, type: 'scene-heading', text: line.startsWith('.') ? line.slice(1) : line });
        i++; continue;
      }
      // transition  > TEXT
      if (line.startsWith('>') && !line.endsWith('<')) {
        blocks.push({ id: id++, type: 'transition', text: line.slice(1).trim() });
        i++; continue;
      }
      // character (ALL CAPS line followed by dialogue/paren, but NOT scene heading)
      if (line === line.toUpperCase() && /[A-Z]/.test(line) && !line.startsWith('(') && !line.includes('.')) {
        var j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        var next = j < lines.length ? lines[j].trim() : '';
        if (next && (next.startsWith('(') || (next !== next.toUpperCase()))) {
          blocks.push({ id: id++, type: 'character', text: line });
          i++;
          while (i < lines.length && lines[i].trim()) {
            var dl = lines[i].trim();
            if (dl.startsWith('(')) blocks.push({ id: id++, type: 'parenthetical', text: dl });
            else blocks.push({ id: id++, type: 'dialogue', text: dl });
            i++;
          }
          continue;
        }
      }
      // parenthetical
      if (line.startsWith('(') && line.endsWith(')')) {
        blocks.push({ id: id++, type: 'parenthetical', text: line });
        i++; continue;
      }
      // action
      blocks.push({ id: id++, type: 'action', text: line });
      i++;
    }
    return blocks.length ? blocks : [{ id: 1, type: 'scene-heading', text: '' }];
  }

  /* ════ WebDAV ════ */
  function getToken() {
    var h = document.querySelector('head[data-requesttoken]');
    return h ? h.getAttribute('data-requesttoken') : '';
  }

  function davFetch(method, path, body) {
    var headers = { 'requesttoken': getToken() };
    var opts = { method: method, credentials: 'same-origin', headers: headers };
    if (method === 'PROPFIND') {
      headers['Depth'] = '1';
      headers['Content-Type'] = 'application/xml';
      opts.body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';
    }
    if (body !== undefined && method !== 'PROPFIND') {
      headers['Content-Type'] = 'text/plain; charset=utf-8';
      opts.body = body;
    }
    return fetch(path, opts);
  }

  function ensureFolder() {
    return davFetch('MKCOL', DAV_ROOT);
  }

  function listFiles() {
    return davFetch('PROPFIND', DAV_ROOT).then(function (res) {
      if (res.status === 404) {
        return ensureFolder().then(function () { return []; });
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text().then(function (xml) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(xml, 'text/xml');
        var files = [];
        doc.querySelectorAll('response').forEach(function (r) {
          var href = r.querySelector('href');
          if (!href) return;
          var path = decodeURIComponent(href.textContent.trim());
          if (!path.endsWith('.fountain')) return;
          files.push({ name: path.split('/').pop().replace(/\.fountain$/, ''), path: path });
        });
        return files;
      });
    });
  }

  function loadFile(path) {
    return davFetch('GET', path).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    });
  }

  function saveFileToDav(path, content) {
    return davFetch('PUT', path, content).then(function (res) {
      if (res.status === 409) {
        return ensureFolder().then(function () {
          return davFetch('PUT', path, content);
        });
      }
      return res;
    }).then(function (res) {
      if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error('HTTP ' + res.status);
      return true;
    });
  }

  /* ════ UI helpers ════ */
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /* ════ FILE LIST SCREEN ════ */
  function showList() {
    var root = document.getElementById('app-content-vue');
    root.innerHTML = '';

    var wrap = h('div', 'sp-list-screen');
    var header = h('div', 'sp-list-header');
    header.appendChild(h('h2', 'sp-list-title', '劇本'));

    var newBtn = h('button', 'sp-new-btn', '+ 新建劇本');
    newBtn.addEventListener('click', function () {
      promptNewFile(root);
    });
    header.appendChild(newBtn);
    wrap.appendChild(header);

    if (st.loading) {
      wrap.appendChild(h('div', 'sp-list-loading', '載入中…'));
      root.appendChild(wrap);
      return;
    }
    if (st.error) {
      wrap.appendChild(h('div', 'sp-list-error', '錯誤：' + st.error));
      root.appendChild(wrap);
      return;
    }
    if (!st.files.length) {
      wrap.appendChild(h('div', 'sp-list-empty', '沒有劇本，點「+ 新建劇本」開始'));
      root.appendChild(wrap);
      return;
    }

    var ul = h('ul', 'sp-file-list');
    st.files.forEach(function (f) {
      var li = h('li', 'sp-file-item');
      li.appendChild(h('span', 'sp-file-icon', '📄'));
      li.appendChild(h('span', 'sp-file-name', f.name));
      li.addEventListener('click', function () {
        li.textContent = '載入中…';
        loadFile(f.path).then(function (text) {
          openEditor(f.path, f.name, fountainToBlocks(text));
        }).catch(function (e) { alert('無法打開：' + e.message); showList(); });
      });
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
    root.appendChild(wrap);
  }

  function promptNewFile(root) {
    var name = prompt('劇本名稱：', '未命名劇本');
    if (!name) return;
    name = name.trim() || '未命名劇本';
    openEditor(null, name, [{ id: st.nextId++, type: 'scene-heading', text: '' }]);
  }

  /* ════ EDITOR SCREEN ════ */
  var blocksEl = null, mobileBarEl = null;

  function openEditor(path, title, blocks) {
    st.currentPath = path;
    st.currentTitle = title;
    st.blocks = blocks;
    st.focusedIdx = 0;
    st.selectionMode = false;
    st.selectedBlocks = [];

    var root = document.getElementById('app-content-vue');
    root.innerHTML = '';

    var editor = h('div', 'sp-editor');
    editor.classList.toggle('sp-mobile', window.innerWidth < 768);

    // 窗口缩放监听：处理移动端切换与高度重算
    // 在 openEditor 函数内的 resize 监听器中
    window.addEventListener('resize', function () {
      editor.classList.toggle('sp-mobile', window.innerWidth < 768);
      if (blocksEl) {
        var area = document.querySelector('.sp-script-area');
        var oldOverflow = '';
        if (area) {
          oldOverflow = area.style.overflowY;
          area.style.overflowY = 'scroll'; // 锁定滚动条避免宽度抖动和高度重算错误
        }
        var allTas = blocksEl.querySelectorAll('textarea');
        // 批量重置高度以减少回流
        allTas.forEach(function (ta) { ta.style.height = 'auto'; });
        // 批量设置新高度
        allTas.forEach(function (ta) { ta.style.height = ta.scrollHeight + 'px'; });
        if (area) {
          area.style.overflowY = oldOverflow;
        }
        if (typeof scheduleUpdatePageBreaks === 'function') {
          scheduleUpdatePageBreaks();
        }
      }
    });

    /* ════ Topbar ════ */
    var topbar = h('div', 'sp-topbar');

    // 返回按钮
    var backBtn = h('button', 'sp-back-btn', '← 返回');
    backBtn.addEventListener('click', function () { reloadList(); });
    topbar.appendChild(backBtn);

    // 标题输入框
    var titleInput = h('input');
    titleInput.value = st.currentTitle;
    titleInput.setAttribute('style', 'background:transparent;border:none;color:#fff;font-size:16px;min-width:80px;flex:1;outline:none;padding:0 8px;');
    titleInput.addEventListener('input', function () { st.currentTitle = titleInput.value; });
    topbar.appendChild(titleInput);

    // 保存状态显示
    var lastSavedDisp = h('span', 'sp-last-saved', '');
    lastSavedDisp.id = 'sp-last-saved';
    topbar.appendChild(lastSavedDisp);

    // 导出按钮 (新集成)
    var exportBtn = h('button', 'sp-back-btn', '导出 PDF');
    exportBtn.style.marginLeft = '10px';
    exportBtn.addEventListener('click', function () {
      if (typeof showExportModal === 'function') {
        showExportModal();
      } else {
        alert('导出模块尚未就绪');
      }
    });
    topbar.appendChild(exportBtn);

    // 自动保存逻辑 (30秒)
    if (st.autoSaveTimer) clearInterval(st.autoSaveTimer);
    st.autoSaveTimer = setInterval(function () {
      if (st.blocks && st.blocks.length > 0) {
        doSave(null, titleInput);
      }
    }, 30000);

    var layout = h('div', 'sp-layout');
    var area = h('div', 'sp-script-area');
    var page = h('div', 'sp-page');
    blocksEl = page;
    area.appendChild(page);
    layout.appendChild(area);

    mobileBarEl = h('div', 'sp-mobile-bar');

    editor.appendChild(topbar);
    editor.appendChild(layout);
    editor.appendChild(mobileBarEl);
    root.appendChild(editor);

    // 全局滑动监听 (利用 elementFromPoint 避免元素被 renderBlocks 销毁导致事件中断)
    layout.addEventListener('mousemove', function (e) {
      if (st.selectionMode && isDraggingSelection) {
        var el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && el.classList.contains('sp-select-indicator')) {
          var hoveredIdx = parseInt(el.dataset.idx, 10);
          if (!isNaN(hoveredIdx) && hoveredIdx !== lastSelectedIdx) {
            toggleSel(hoveredIdx, false, true, dragSelState);
          }
        }
      }
    });

    renderBlocks();
    renderBar();
  }

  function showExportModal() {
    var overlay = h('div', 'sp-modal-overlay');
    var modal = h('div', 'sp-modal');
    modal.innerHTML = `
    <h3>剧本导出与分页参考</h3>
    <div class="sp-settings-row">
      <label>纸张规格</label>
      <select id="psize">
        <option value="A4">A4 (影响分页线高度)</option>
        <option value="letter">Letter</option>
      </select>
    </div>
    <div class="sp-settings-row">
      <label>页边距 (in)</label>
      <input type="number" id="pmargin" value="1.0" step="0.1" style="width:60px">
    </div>
    <div style="margin-top:20px; text-align:right;">
      <button id="p-cancel" style="margin-right:10px; background:none; border:none; color:#949cbb; cursor:pointer;">取消</button>
      <button id="p-exec" style="background:#89b4fa; color:#1e1e2e; border:none; padding:8px 20px; border-radius:6px; font-weight:600; cursor:pointer;">预览并生成 PDF</button>
    </div>
  `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const select = modal.querySelector('#psize');

    // 切换纸张时立即触发 JS 分页线重绘
    select.onchange = updatePageBreaks;

    modal.querySelector('#p-cancel').onclick = function () { overlay.remove(); };

    modal.querySelector('#p-exec').onclick = function () {
      var size = select.value;
      var margin = modal.querySelector('#pmargin').value + 'in';
      overlay.remove();

      var printArea = document.getElementById('print-area') || document.createElement('div');
      printArea.id = 'print-area';
      printArea.innerHTML = '';
      document.body.appendChild(printArea);

      document.documentElement.style.setProperty('--print-size', size);
      document.documentElement.style.setProperty('--print-margin', margin);

      st.blocks.forEach(function (b) {
        if (!b.text.trim() && b.type !== 'scene-heading') return;
        var div = document.createElement('div');
        div.className = 'p-block p-' + b.type;
        div.textContent = b.text.trim() || 'INT. UNTITLED SCENE - DAY';
        printArea.appendChild(div);
      });

      document.documentElement.classList.add('sp-printing-active');
      document.body.classList.add('sp-printing-active');
      document.body.style.overflow = 'visible';

      setTimeout(function () {
        window.print();
        window.onafterprint = function () {
          document.documentElement.classList.remove('sp-printing-active');
          document.body.classList.remove('sp-printing-active');
          document.body.style.overflow = '';
          printArea.remove();
        };
      }, 500);
    };
  }
  function reloadList() {
    if (st.autoSaveTimer) { clearInterval(st.autoSaveTimer); st.autoSaveTimer = null; }
    st.loading = true;
    showList();
    listFiles().then(function (f) {
      st.files = f; st.loading = false; st.error = null; showList();
    }).catch(function (e) {
      st.error = e.message; st.loading = false; showList();
    });
  }

  function doSave(btn, titleInput) {
    var title = (titleInput ? titleInput.value.trim() : st.currentTitle) || '未命名劇本';
    st.currentTitle = title;
    var filename = title.replace(/[\/\\:*?"<>|]/g, '-') + '.fountain';
    var path = DAV_ROOT + '/' + encodeURIComponent(filename);
    var content = blocksToFountain(st.blocks);
    if (btn) { btn.textContent = '保存中…'; btn.disabled = true; }
    saveFileToDav(path, content).then(function () {
      st.currentPath = path;
      st.lastSaved = new Date();
      updateLastSavedDisplay();
      if (btn) { btn.textContent = '已保存 ✓'; setTimeout(function () { btn.textContent = '保存'; btn.disabled = false; }, 1500); }
    }).catch(function (e) {
      if (btn) { btn.textContent = '保存'; btn.disabled = false; }
      alert('保存失敗：' + e.message);
    });
  }

  function updateLastSavedDisplay() {
    var disp = document.getElementById('sp-last-saved');
    if (!disp) return;
    if (!st.lastSaved) { disp.textContent = ''; return; }
    var h = st.lastSaved.getHours(), m = st.lastSaved.getMinutes();
    var hh = (h < 10 ? '0' : '') + h, mm = (m < 10 ? '0' : '') + m;
    disp.textContent = hh + ':' + mm;
  }

  /* ── blocks ── */
  function renderBlocks() {
    if (!blocksEl) return;
    var area = document.querySelector('.sp-script-area');
    var stTop = area ? area.scrollTop : 0;

    blocksEl.innerHTML = '';
    st.blocks.forEach(function (block, idx) {
      var isSel = st.selectedBlocks.indexOf(idx) >= 0;
      var wrap = h('div', 'sp-block' + (isSel ? ' sp-block-selected' : ''));

      if (st.selectionMode) {
        var sel = h('span', 'sp-select-indicator' + (isSel ? ' sp-selected' : ''), isSel ? '✓' : '○');

        // 记录一下这个元素在其父级列表里的 idx 数据，方便后续通过 DOM 获取
        sel.dataset.idx = idx;

        // 鼠标按下：可以是普通单选，也可以是 Shift 多选，同时开启拖拽模式
        sel.addEventListener('mousedown', (function (i, currentIsSel) {
          return function (e) {
            e.preventDefault(); // 防止选中文本当作原生拖拽
            isDraggingSelection = true;
            dragSelState = !currentIsSel; // 拖拽的过程是选中还是取消，取决于按下的那一下
            toggleSel(i, e.shiftKey, false, null);
          };
        })(idx, isSel));

        wrap.appendChild(sel);
      } else if (st.focusedIdx === idx) {
        wrap.appendChild(h('span', 'sp-block-label', tShort(block.type)));
      }

      var ta = h('textarea', 'sp-ta sp-ta-' + block.type);
      ta.rows = 1;
      ta.value = block.text;
      ta.placeholder = tHint(block.type);
      ta.readOnly = st.selectionMode;
      ta.addEventListener('focus', (function (i) {
        return function () {
          st.focusedIdx = i;
          updateLabels();
          renderBar();
        };
      })(idx));
      ta.addEventListener('input', (function (i, t) {
        return function () {
          st.blocks[i].text = t.value;
          autoH(t);
        };
      })(idx, ta));
      ta.addEventListener('keydown', (function (i) { return function (e) { onKey(e, i); }; })(idx));
      if (st.selectionMode) {
        ta.addEventListener('click', (function (i) { return function () { toggleSel(i); }; })(idx));
      }
      wrap.appendChild(ta);
      blocksEl.appendChild(wrap);

      // 不在这里 autoH，放入统一计算，避免触发布局抖动
    });

    // 批量设置高度避免重排导致卡顿
    var allTas = Array.from(blocksEl.querySelectorAll('textarea'));
    allTas.forEach(function (ta) { ta.style.height = 'auto'; });
    var newHeights = allTas.map(function (ta) { return ta.scrollHeight; });
    allTas.forEach(function (ta, i) { ta.style.height = newHeights[i] + 'px'; });

    if (area) {
      area.scrollTop = stTop;
    }
  }

  function updateLabels() {
    if (!blocksEl) return;
    blocksEl.querySelectorAll('.sp-block').forEach(function (wrap, idx) {
      var lbl = wrap.querySelector('.sp-block-label');
      if (idx === st.focusedIdx && !st.selectionMode) {
        if (!lbl) { lbl = h('span', 'sp-block-label'); wrap.insertBefore(lbl, wrap.querySelector('textarea')); }
        lbl.textContent = tShort(st.blocks[idx].type);
      } else { if (lbl) lbl.remove(); }
    });
  }

  var pageBreakTimer = null;
  function scheduleUpdatePageBreaks() {
    if (pageBreakTimer) clearTimeout(pageBreakTimer);
    pageBreakTimer = setTimeout(updatePageBreaks, 200);
  }

  function updatePageBreaks() {
    if (!blocksEl) return;

    // 1. 清除旧的分页符
    var markers = blocksEl.querySelectorAll('.sp-page-break-marker');
    for (var i = 0; i < markers.length; i++) {
      markers[i].remove();
    }

    // 2. 获取当前的物理页高基准 (从导出设置获取，默认 A4)
    var psizeEl = document.getElementById('psize');
    var pSize = psizeEl ? psizeEl.value : 'A4';
    var pageHeightPx = (pSize === 'letter') ? 1056 : 1122;

    // 3. 模拟打印边距 (上下各1英寸=96px)
    var topMargin = 96;
    var bottomMargin = 96;
    var usableHeight = pageHeightPx - topMargin - bottomMargin;

    var currentFilled = 0;
    var pageCount = 1;

    var wraps = blocksEl.querySelectorAll('.sp-block');

    wraps.forEach(function (wrap) {
      // 获取块的实际物理高度 + 间距（模拟打印时占用的高度）
      var blockH = wrap.offsetHeight + 8;

      // 如果加上这个块后超过了当前页的可用高度
      if (currentFilled + blockH > usableHeight) {
        // 在这个块之前插入分页符
        var marker = document.createElement('div');
        marker.className = 'sp-page-break-marker';
        marker.style.top = (wrap.offsetTop - 4) + 'px'; // 放在块的缝隙间
        marker.setAttribute('data-label', 'PAGE ' + pageCount + ' END / PAGE ' + (pageCount + 1) + ' START');

        blocksEl.appendChild(marker);

        // 重置累加器：新的一页从头开始算
        currentFilled = blockH;
        pageCount++;
      } else {
        currentFilled += blockH;
      }
    });
  }

  // 修改原有的 autoH 并在末尾触发计算
  function autoH(ta) {
    var oldScrollTop = ta.scrollTop;
    ta.style.height = 'auto'; // 折叠至单行计算真实大小
    ta.style.height = ta.scrollHeight + 'px'; // 根据真实文字多寡设置固定高度
    ta.scrollTop = oldScrollTop;

    // 只要文字变多导致高度变化，就重算分页
    scheduleUpdatePageBreaks();
  }

  // 修改 renderBlocks，在渲染完后初始计算一次
  var _originalRenderBlocks = renderBlocks;
  renderBlocks = function () {
    _originalRenderBlocks();
    scheduleUpdatePageBreaks(); // 等待 DOM 稳定
  };
  function focusTA(idx) {
    if (!blocksEl) return;
    var tas = blocksEl.querySelectorAll('textarea');
    if (tas[idx]) tas[idx].focus();
  }

  function tShort(id) { var t = TYPES.find(function (t) { return t.id === id; }); return t ? t.shortLabel : id; }
  function tHint(id) { var t = TYPES.find(function (t) { return t.id === id; }); return t ? t.hint : ''; }

  /* ── keyboard ── */
  function onKey(e, idx) {
    var b = st.blocks[idx];
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      var map = { 'scene-heading': 'action', 'action': 'character', 'character': 'dialogue', 'dialogue': 'action', 'parenthetical': 'dialogue' };
      insertBlock(idx, map[b.type] || 'action');
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      var ids = TYPES.map(function (t) { return t.id; });
      b.type = ids[(ids.indexOf(b.type) + 1) % ids.length];
      renderBlocks(); focusTA(idx); renderBar();
      return;
    }
    if (e.key === 'Backspace' && b.text === '' && st.blocks.length > 1) {
      e.preventDefault();
      st.blocks.splice(idx, 1);
      var ni = Math.max(0, idx - 1);
      st.focusedIdx = ni;
      renderBlocks(); focusTA(ni);
      return;
    }
  }

  function insertBlock(after, type) {
    var nb = { id: st.nextId++, type: type, text: '' };
    st.blocks.splice(after + 1, 0, nb);
    st.focusedIdx = after + 1;
    renderBlocks(); focusTA(after + 1);
  }

  /* ── mobile bar ── */
  function renderBar() {
    if (!mobileBarEl) return;
    mobileBarEl.innerHTML = '';
    var cur = st.focusedIdx >= 0 && st.focusedIdx < st.blocks.length ? st.blocks[st.focusedIdx].type : '';

    /* 0 ── SAVE button (very top) */
    var saveBarBtn = h('button', 'sp-action-btn sp-save-bar', '💾');
    saveBarBtn.title = '保存';
    saveBarBtn.addEventListener('click', function () {
      var titleInput = document.querySelector('.sp-topbar input');
      doSave(null, titleInput);
    });
    mobileBarEl.appendChild(saveBarBtn);
    mobileBarEl.appendChild(h('div', 'sp-mobile-divider'));

    /* 1 ── TYPE buttons (top) */
    var td = h('div', 'sp-mobile-types');
    TYPES.forEach(function (t) {
      var b = h('button', cur === t.id ? 'active' : '', t.shortLabel);
      b.addEventListener('click', (function (tid) {
        return function () {
          // if in selection mode, do nothing (or could change type of all selected)
          if (st.selectionMode) return;
          // if has focus, change type; else insert new block
          if (st.focusedIdx >= 0 && st.focusedIdx < st.blocks.length) {
            st.blocks[st.focusedIdx].type = tid;
            renderBlocks(); focusTA(st.focusedIdx); renderBar();
          } else {
            insertBlock(st.blocks.length - 1, tid);
          }
        };
      })(t.id));
      td.appendChild(b);
    });
    mobileBarEl.appendChild(td);

    /* divider */
    mobileBarEl.appendChild(h('div', 'sp-mobile-divider'));

    /* 2 ── ACTION buttons (below) */
    var ad = h('div', 'sp-mobile-actions');

    var selB = h('button', 'sp-action-btn' + (st.selectionMode ? ' sp-action-active' : ''), st.selectionMode ? '取消' : '選擇');
    selB.addEventListener('click', function () {
      st.selectionMode = !st.selectionMode; st.selectedBlocks = [];
      renderBlocks(); renderBar();
    });
    ad.appendChild(selB);

    function abtn(lbl, isDanger, fn) {
      var b = h('button', 'sp-action-btn' + (isDanger ? ' sp-action-danger' : ''), lbl);
      b.disabled = (lbl === '貼上') ? !st.clipboard.length : !st.selectedBlocks.length;
      b.addEventListener('click', fn);
      ad.appendChild(b);
    }
    abtn('複製', false, function () { copyS(); });
    abtn('剪切', false, function () { cutS(); });
    abtn('貼上', false, function () { pasteS(); });
    abtn('刪除', true, function () { delS(); });

    mobileBarEl.appendChild(ad);
    mobileBarEl.appendChild(h('div', 'sp-mobile-stats',
      st.selectionMode ? ('已選 ' + st.selectedBlocks.length) : (st.blocks.length + ' 塊')));
  }

  /* ── batch ── */
  var lastSelectedIdx = -1;
  var isDraggingSelection = false;
  var dragSelState = true; // true = selecting, false = deselecting

  function toggleSel(idx, isShift, isDragEnter, forceState) {
    if (isDragEnter) {
      // Dragging over an item: apply the state we started the drag with
      var p = st.selectedBlocks.indexOf(idx);
      if (forceState && p < 0) st.selectedBlocks.push(idx);
      if (!forceState && p >= 0) st.selectedBlocks.splice(p, 1);
      lastSelectedIdx = idx;
      renderBlocks(); renderBar();
      return;
    }

    if (isShift && lastSelectedIdx >= 0) {
      // Shift-click: select range
      var start = Math.min(lastSelectedIdx, idx);
      var end = Math.max(lastSelectedIdx, idx);
      var adding = st.selectedBlocks.indexOf(lastSelectedIdx) >= 0 || st.selectedBlocks.indexOf(idx) < 0;
      for (var i = start; i <= end; i++) {
        var p = st.selectedBlocks.indexOf(i);
        if (adding && p < 0) st.selectedBlocks.push(i);
        else if (!adding && p >= 0) st.selectedBlocks.splice(p, 1);
      }
    } else {
      // Normal click
      var p = st.selectedBlocks.indexOf(idx);
      if (p >= 0) st.selectedBlocks.splice(p, 1); else st.selectedBlocks.push(idx);
    }
    lastSelectedIdx = idx;
    renderBlocks(); renderBar();
  }

  // Handle global drag selection stop
  document.addEventListener('mouseup', function () {
    isDraggingSelection = false;
  });

  function copyS() {
    if (!st.selectedBlocks.length) return;
    st.clipboard = st.selectedBlocks.slice().sort(function (a, b) { return a - b; })
      .map(function (i) { return JSON.parse(JSON.stringify(st.blocks[i])); });
    renderBar();
  }
  function cutS() { copyS(); delS(); }
  function pasteS() {
    if (!st.clipboard.length) return;
    var idx = st.focusedIdx >= 0 ? st.focusedIdx : st.blocks.length - 1;
    var copies = st.clipboard.map(function (b) { return Object.assign({}, b, { id: st.nextId++ }); });
    Array.prototype.splice.apply(st.blocks, [idx + 1, 0].concat(copies));
    st.selectionMode = false; st.selectedBlocks = []; st.focusedIdx = idx + copies.length;
    renderBlocks(); focusTA(st.focusedIdx); renderBar();
  }
  function delS() {
    if (!st.selectedBlocks.length) return;
    st.selectedBlocks.slice().sort(function (a, b) { return b - a; })
      .forEach(function (i) { st.blocks.splice(i, 1); });
    if (!st.blocks.length) st.blocks.push({ id: st.nextId++, type: 'action', text: '' });
    st.selectedBlocks = []; st.focusedIdx = Math.min(st.focusedIdx, st.blocks.length - 1);
    renderBlocks(); renderBar();
  }

  /* ════ boot ════ */
  function boot() {
    var root = document.getElementById('app-content-vue');
    if (!root) { setTimeout(boot, 50); return; }
    reloadList();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
