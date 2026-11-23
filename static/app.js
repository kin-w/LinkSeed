(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const LS = {
    imported: 'ed2k.imported.v1',
    torrentOpts: 'ed2k.torrentOpts.v1',
    lastJob: 'ed2k.lastTorrentJob',
    theme: 'ed2k.theme',
    browseDir: 'ed2k.browseDir.v1'
  };

  const CHUNK_SIZE = 4 * 1024 * 1024;
  const MAX_PARALLEL_UPLOADS = 2;

  const storedImported = loadJSON(LS.imported, []);
  let storedLastJob = '';
  try { storedLastJob = localStorage.getItem(LS.lastJob) || ''; } catch (err) { }
  const state = {
    files: [],
    jobs: [],
    rev: -1,
    selected: new Set(),
    anchorId: null,
    tab: 'ed2k',
    collapsed: new Set(),
    torrentCollapsed: new Set(),
    displayOrder: [],
    treeOrderSig: '',
    imported: Array.isArray(storedImported) ? storedImported : [],
    torrentSelected: new Set(),
    torrentTouched: false,
    torrentJobId: storedLastJob,
    torrentImport: null,
    torrentImports: [],
    torrentImportFile: null,
    parseSelected: new Set(),
    localUploads: new Map(),
    uploading: new Set(),
    lastJobStatus: '',
    lastImportedSig: '',
    pickerSig: '',
    historySig: { ed2k: '', make: '' },
    historyBusy: false,
    torrentImportSig: '',
    lastParseFileSig: '',
    editorTorrents: [],
    editorSelected: new Set(),
    editorTab: 'summary',
    editorTreeSelected: null,
    editorTreeExpanded: new Set(['[]']),
    editorTreeRows: [],
    editorRawDirty: false,
    editorRawKey: '',
    editorEntryKey: '',
    torrentJobSig: '',
    trackerLoading: false,
    trackerAutoLoaded: false,
    integrations: { qb_servers: [], offline115: {} },
    offlineNotified: false
  };

  const rowEls = new Map();
  const folderEls = new Map();
  const uploadQueue = [];
  let activeUploads = 0;
  const uploadBatch = {
    gen: 0,
    items: new Map(),
    activeKeys: new Set(),
    createdIds: new Set(),
    currentKey: '',
    active: false,
    paused: false,
    cancelled: false,
    hideTimer: null
  };
  const uploadAborters = new Set();
  let pollTimer = null;
  let pollFailures = 0;
  let lastFocus = null;


  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const value = JSON.parse(raw);
      return value === null || value === undefined ? fallback : value;
    } catch (err) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {

    }
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
  }

  function icon(name) {
    return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let value = n / 1024;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return value.toFixed(digits) + ' ' + units[index];
  }

  function fmtPiece(bytes) {
    if (!bytes) return '自动';
    if (bytes >= 1048576) return (bytes / 1048576) + ' MiB';
    return Math.round(bytes / 1024) + ' KiB';
  }


  function metaChips(parts) {
    return (Array.isArray(parts) ? parts : [parts])
      .filter(part => part !== null && part !== undefined && part !== '')
      .map(part => '<span class="meta-chip">' + esc(part) + '</span>')
      .join('');
  }


  function addModeText(file) {
    const folder = (file && file.add_mode) === 'folder';
    return ((file && file.source) === 'server' ? '服务器' : '本地') + (folder ? '文件夹' : '文件');
  }

  function setSelectionLabel(html) {
    const el = $('#selectionLabel');
    if (!el) return;
    el.innerHTML = html;
    el.classList.toggle('meta-chips', !!el.querySelector('.meta-chip'));
  }

  function stamp() {
    const date = new Date();
    const pad = value => String(value).padStart(2, '0');
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) +
      '-' + pad(date.getHours()) + pad(date.getMinutes());
  }

  async function api(path, options) {
    options = options || {};
    const opts = { method: options.method || 'GET', headers: Object.assign({}, options.headers) };
    const body = options.body;
    if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) {
      opts.body = body;
      if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/octet-stream';
    } else if (body !== undefined && body !== null) {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(path, opts);
    const contentType = response.headers.get('content-type') || '';
    let data = null;
    if (contentType.indexOf('application/json') >= 0) {
      try { data = await response.json(); } catch (err) { data = null; }
    } else {
      try { data = await response.text(); } catch (err) { data = null; }
    }
    if (response.status === 401 && data && data.auth_required) {
      if (location.pathname !== '/login') location.href = '/login';
      const authError = new Error('未登录');
      authError.status = 401;
      throw authError;
    }
    if (!response.ok) {
      const error = new Error((data && data.error) || ('请求失败 (' + response.status + ')'));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function toast(message, type) {
    type = type || 'ok';
    const root = $('#toastRoot');
    const iconName = type === 'error' ? 'x' : type === 'warn' ? 'alert' : type === 'info' ? 'cloud' : 'check';
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = '<span class="toast-icon">' + icon(iconName) + '</span><span>' + esc(message) + '</span>';
    root.appendChild(el);
    while (root.children.length > 4) root.firstElementChild.remove();
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 280);
    }, 3200);
  }

  async function copyText(text, successMessage) {
    if (!text) {
      toast('暂无可复制的内容', 'warn');
      return false;
    }
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (err) {
      ok = false;
    }
    if (!ok) {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '0';
        area.style.left = '-9999px';
        document.body.appendChild(area);
        area.select();
        area.setSelectionRange(0, area.value.length);
        ok = document.execCommand('copy');
        area.remove();
      } catch (err) {
        ok = false;
      }
    }
    if (ok) toast(successMessage || '已复制到剪贴板', 'ok');
    else toast('复制失败，请手动选择链接复制', 'error');
    return ok;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function downloadText(text, filename) {
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
  }

  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }


  const THEME_MODES = ['system', 'light', 'dark'];
  const THEME_LABEL = { system: '跟随系统', light: '浅色', dark: '深色' };
  const THEME_ICON = { system: 'auto', light: 'sun', dark: 'moon' };

  function themeMode() {
    const mode = document.documentElement.dataset.themeMode;
    if (THEME_MODES.indexOf(mode) >= 0) return mode;
    try {
      const stored = localStorage.getItem(LS.theme);
      if (THEME_MODES.indexOf(stored) >= 0) return stored;
    } catch (err) { }
    return 'system';
  }

  function applyTheme(mode, persist) {
    if (THEME_MODES.indexOf(mode) < 0) mode = 'system';
    const dark = mode === 'dark' ||
      (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themeMode = mode;
    if (persist) {
      try { localStorage.setItem(LS.theme, mode); } catch (err) { }
      savePrefs({ theme: mode });
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#000000' : '#f5f5f7');
    const button = $('#themeBtn');
    if (button) {
      const label = '主题：' + THEME_LABEL[mode];
      button.innerHTML = icon(THEME_ICON[mode]);
      button.title = label + '（点击切换）';
      button.setAttribute('aria-label', label);
    }
  }

  function cycleTheme() {
    const index = THEME_MODES.indexOf(themeMode());
    const next = THEME_MODES[(index < 0 ? 0 : index + 1) % THEME_MODES.length];
    applyTheme(next, true);
    toast('主题已切换为' + THEME_LABEL[next], 'info');
  }

  function findFile(id) {
    return state.files.find(file => file.id === id) || null;
  }


  function moduleOf(file) {
    return (file && file.module) || 'ed2k';
  }

  function moduleFiles(module) {
    return state.files.filter(file => moduleOf(file) === module);
  }

  function currentModule() {
    if (state.tab === 'make') return 'make';
    if (state.tab === 'parse') return 'parse';
    return 'ed2k';
  }

  function getFileLink(id) {
    const file = findFile(id);
    return file && file.ed2k && file.ed2k.status === 'done' ? file.ed2k.link : '';
  }

  const EXT_GROUPS = [
    { cls: 'kind-video', icon: 'film', exts: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'ts', 'm2ts', 'webm', 'rmvb', 'rm', 'mpg', 'mpeg', 'm4v', '3gp', 'vob'] },
    { cls: 'kind-audio', icon: 'music', exts: ['mp3', 'flac', 'wav', 'aac', 'ape', 'ogg', 'm4a', 'wma', 'opus', 'dsd', 'dff', 'aiff'] },
    { cls: 'kind-image', icon: 'image', exts: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'svg', 'heic', 'avif', 'raw'] },
    { cls: 'kind-archive', icon: 'archive', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'torrent', 'cab'] },
    { cls: 'kind-code', icon: 'code', exts: ['js', 'ts', 'py', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'json', 'xml', 'html', 'css', 'sh', 'yml', 'yaml', 'md', 'txt', 'log', 'srt', 'ass', 'vtt'] },
    { cls: 'kind-doc', icon: 'doc', exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub', 'mobi', 'azw3', 'chm'] }
  ];

  function fileKind(name) {
    const dot = String(name || '').lastIndexOf('.');
    const ext = dot >= 0 ? String(name).slice(dot + 1).toLowerCase() : '';
    for (const group of EXT_GROUPS) {
      if (group.exts.indexOf(ext) >= 0) return group;
    }
    return { cls: 'kind-file', icon: 'file' };
  }


  async function refresh() {
    try {
      const query = state.rev >= 0 ? '?rev=' + encodeURIComponent(String(state.rev)) : '';
      const data = await api('/api/state' + query);
      applyState(data);
      return true;
    } catch (err) {
      if (err.status === 401) return false;
      if (!state.offlineNotified) {
        state.offlineNotified = true;
        toast('无法连接服务器，请检查容器是否运行', 'error');
      }
      return false;
    }
  }

  function applyState(data) {
    if (data && data.unchanged) {
      state.jobs = Array.isArray(data.jobs) ? data.jobs : state.jobs;
      if (state.tab === 'make') renderTorrentJob();
      notifyJobStatus();
      return;
    }
    const files = Array.isArray(data.files) ? data.files : [];
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    state.files = files;
    state.jobs = jobs;
    state.rev = data.rev;

    const ids = new Set(files.map(file => file.id));
    for (const id of Array.from(state.selected)) {
      if (!ids.has(id)) state.selected.delete(id);
    }
    for (const id of Array.from(state.torrentSelected)) {
      if (!ids.has(id)) state.torrentSelected.delete(id);
    }
    state.files.forEach(file => {
      if (file.complete) state.localUploads.delete(file.id);
    });

    renderAll();
    notifyJobStatus();
  }

  function notifyJobStatus() {
    if (!state.torrentJobId) return;
    const job = state.jobs.find(item => item.id === state.torrentJobId);
    if (!job) return;
    if (state.lastJobStatus && job.status !== state.lastJobStatus) {
      if (job.status === 'done') toast('BT 种子已生成', 'ok');
      else if (job.status === 'error') toast('种子生成失败：' + (job.error || ''), 'error');
    }
    state.lastJobStatus = job.status;
  }

  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    const active = state.localUploads.size > 0 ||
      state.files.some(file => file.ed2k && (file.ed2k.status === 'queued' || file.ed2k.status === 'running')) ||
      state.jobs.some(job => job.status === 'queued' || job.status === 'running');
    let wait = typeof delay === 'number' ? delay : (active ? 800 : 3000);
    if (document.hidden) wait = Math.max(wait, 30000);
    if (pollFailures) wait = Math.min(30000, wait * Math.pow(2, Math.min(pollFailures, 4)));
    pollTimer = setTimeout(async () => {
      const ok = await refresh();
      pollFailures = ok ? 0 : pollFailures + 1;
      schedulePoll();
    }, wait);
  }


  function renderAll() {
    renderStats();
    renderFileList();
    renderImported();
    renderHistoryCard('ed2k', { card: 'historyCard', list: 'historyList', count: 'historyCount' });
    renderHistoryCard('make', { card: 'makeHistoryCard', list: 'makeHistoryList', count: 'makeHistoryCount' });
    updateSelectionUI();
    if (state.tab === 'make') {
      renderTorrentPicker();
      renderTorrentJob();
    } else if (state.tab === 'parse') {
      renderTorrentImport();
    }
  }

  function renderStats() {
    const files = moduleFiles('ed2k');
    const complete = files.filter(file => file.complete).length;
    const done = files.filter(file => file.ed2k && file.ed2k.status === 'done').length;
    const hashing = files.filter(file => file.ed2k && (file.ed2k.status === 'running' || file.ed2k.status === 'queued')).length;
    const total = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);

    $('#statFiles').textContent = String(files.length);
    $('#statFilesSub').textContent = files.length ? complete + ' 个已上传' : '等待添加';
    $('#statSize').textContent = fmtSize(total);
    $('#statSizeSub').textContent = hashing ? hashing + ' 个正在计算' : '支持大文件分片续传';
    $('#statLinks').textContent = String(done);
    $('#statLinksSub').textContent = hashing
      ? '后台异步计算中'
      : (files.length && done === files.length ? '全部完成' : '后台异步计算');
    $('#fileCount').textContent = files.length + ' 个文件';
  }

  function fileRelPath(file) {
    return String(file.rel_path || file.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  }

  function buildTree(files) {
    const root = { path: '', name: '', depth: 0, folders: [], folderMap: new Map(), files: [] };
    (files || []).forEach(file => {
      const parts = fileRelPath(file).split('/').filter(Boolean);
      const fileName = parts.pop() || file.name;
      let node = root;
      parts.forEach(part => {
        let child = node.folderMap.get(part);
        if (!child) {
          child = {
            path: node.path ? node.path + '/' + part : part,
            name: part,
            depth: node.depth + 1,
            folders: [],
            folderMap: new Map(),
            files: []
          };
          node.folderMap.set(part, child);
          node.folders.push(child);
        }
        node = child;
      });
      node.files.push(file);
      if (!file.name) file.name = fileName;
    });
    return root;
  }

  function flattenTree(root, collapsed) {
    const entries = [];
    function walk(node, depth) {
      node.folders.forEach(folder => {
        entries.push({ type: 'folder', folder: folder, depth: depth });
        if (!collapsed.has(folder.path)) walk(folder, depth + 1);
      });
      node.files.forEach(file => entries.push({ type: 'file', file: file, depth: depth }));
    }
    walk(root, 0);
    return entries;
  }

  function filesUnderFolder(path, files) {
    const prefix = String(path).replace(/\/+$/, '') + '/';
    return (files || moduleFiles('ed2k')).filter(file => fileRelPath(file).startsWith(prefix));
  }

  function createFolderRow(folder) {
    const row = document.createElement('div');
    row.className = 'file-row folder-row';
    row.dataset.folder = folder.path;
    row.innerHTML =
      '<button class="tree-toggle" type="button" data-act="toggle" title="展开 / 收起" aria-label="展开或收起">' + icon('chevron') + '</button>' +
      '<label class="checkbox" title="选中文件夹内全部文件">' +
        '<input type="checkbox">' +
        '<span class="box">' + icon('check') + '</span>' +
      '</label>' +
      '<div class="folder-icon">' + icon('folder') + '</div>' +
      '<div class="file-body">' +
        '<div class="file-title"><span class="file-name"></span><span class="badge neutral"></span></div>' +
        '<div class="file-meta meta-chips"></div>' +
      '</div>' +
      '<div class="file-actions">' +
        '<button class="icon-btn" type="button" data-act="copy-folder" title="复制文件夹内全部链接" aria-label="复制文件夹链接">' + icon('copy') + '</button>' +
        '<button class="icon-btn" type="button" data-act="export-folder" title="导出文件夹内全部链接" aria-label="导出文件夹链接">' + icon('download') + '</button>' +
      '</div>';
    return row;
  }

  function updateFolderRow(row, folder, depth) {
    const files = filesUnderFolder(folder.path);
    const total = files.length;
    const selectedCount = files.filter(file => state.selected.has(file.id)).length;
    const all = total > 0 && selectedCount === total;
    const partial = selectedCount > 0 && !all;
    const expanded = !state.collapsed.has(folder.path);
    const size = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    const done = files.filter(file => file.ed2k && file.ed2k.status === 'done' && file.ed2k.link).length;

    row.style.setProperty('--depth', String(Math.min(8, depth || 0)));
    row.classList.toggle('is-expanded', expanded);
    row.classList.toggle('is-selected', all);
    row.classList.toggle('is-partial', partial);

    const label = row.querySelector('.checkbox');
    label.classList.toggle('is-checked', all);
    label.classList.toggle('is-partial', partial);
    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.checked = all;
    checkbox.indeterminate = partial;

    row.querySelector('.file-name').textContent = folder.name;
    row.querySelector('.file-name').title = folder.path;
    const badge = row.querySelector('.badge');
    badge.textContent = total + ' 个文件';
    badge.className = 'badge ' + (all ? 'success' : 'neutral');
    row.querySelector('.file-meta').innerHTML = metaChips([
      fmtSize(size),
      '已选 ' + selectedCount + '/' + total,
      done ? '可导出 ' + done : ''
    ]);

    row.querySelectorAll('[data-act="copy-folder"],[data-act="export-folder"]').forEach(button => {
      button.disabled = done === 0;
      button.classList.toggle('is-disabled', done === 0);
    });
  }

  function createFileRow(file) {
    const kind = fileKind(file.name);
    const row = document.createElement('div');
    row.className = 'file-row';
    row.dataset.id = file.id;
    row.innerHTML =
      '<label class="checkbox" title="选择文件">' +
        '<input type="checkbox">' +
        '<span class="box">' + icon('check') + '</span>' +
      '</label>' +
      '<div class="file-icon ' + kind.cls + '">' + icon(kind.icon) + '</div>' +
      '<div class="file-body">' +
        '<div class="file-title"><span class="file-name"></span><span class="badge neutral"></span></div>' +
        '<div class="file-meta-line">' +
          '<div class="file-meta meta-chips"></div>' +
          '<button class="link-chip" type="button" data-act="copy" title="复制链接" hidden><code></code><span class="chip-action">复制</span></button>' +
        '</div>' +
        '<div class="bar" hidden><span></span></div>' +
      '</div>' +
      '<div class="file-actions">' +
        '<button class="icon-btn" type="button" data-act="copy" title="复制链接" aria-label="复制链接">' + icon('copy') + '</button>' +
        '<button class="icon-btn" type="button" data-act="retry" title="重试上传" aria-label="重试上传" hidden>' + icon('refresh') + '</button>' +
        '<button class="icon-btn danger" type="button" data-act="delete" title="删除文件" aria-label="删除文件">' + icon('trash') + '</button>' +
      '</div>';
    return row;
  }

  function updateFileRow(row, file, depth) {
    const selected = state.selected.has(file.id);
    row.classList.toggle('is-selected', selected);
    row.style.setProperty('--depth', String(Math.min(8, depth || 0)));
    const label = row.querySelector('.checkbox');
    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.checked = selected;
    checkbox.indeterminate = false;
    label.classList.toggle('is-checked', selected);
    label.classList.toggle('is-partial', false);

    const nameEl = row.querySelector('.file-name');
    nameEl.textContent = file.name;
    nameEl.title = file.rel_path || file.name;

    const local = state.localUploads.get(file.id);
    const ed2k = file.ed2k || { status: 'idle' };
    let badgeText = '';
    let badgeClass = 'neutral';
    let detail = [];
    let progress = null;
    let failed = false;

    if (!file.complete) {
      if (local && local.error) {
        badgeText = '上传失败';
        badgeClass = 'danger';
        detail = ['网络中断，点击右侧重试可续传'];
        failed = true;
      } else if (local) {
        const percent = local.total ? Math.min(100, Math.round(local.sent / local.total * 100)) : 0;
        badgeText = '上传中';
        badgeClass = 'info';
        detail = [fmtSize(local.sent) + ' / ' + fmtSize(local.total)];
        progress = percent;
      } else if (file.uploaded > 0) {
        badgeText = '待续传';
        badgeClass = 'warn';
        detail = ['已上传 ' + fmtSize(file.uploaded), '共 ' + fmtSize(file.size), '重新添加可续传'];
        progress = Math.round(file.uploaded / file.size * 100);
      } else {
        badgeText = '等待上传';
        badgeClass = 'neutral';
        detail = [fmtSize(file.size)];
        progress = 0;
      }
    } else if (ed2k.status === 'running') {
      badgeText = '计算中';
      badgeClass = 'info';
      detail = ['MD4 哈希 ' + Math.round(ed2k.progress || 0) + '%'];
      progress = ed2k.progress || 0;
    } else if (ed2k.status === 'queued') {
      badgeText = '排队中';
      badgeClass = 'neutral';
      detail = ['等待哈希计算'];
    } else if (ed2k.status === 'done') {
      badgeText = '已生成';
      badgeClass = 'success';
      detail = [fmtSize(file.size), 'MD4 ' + String(ed2k.hash || '')];
    } else if (ed2k.status === 'error') {
      badgeText = '计算失败';
      badgeClass = 'danger';
      detail = [ed2k.error || '哈希计算失败'];
      failed = true;
    } else {
      badgeText = '准备计算';
      badgeClass = 'neutral';
      detail = [fmtSize(file.size)];
    }

    const badge = row.querySelector('.badge');
    badge.textContent = badgeText;
    badge.className = 'badge ' + badgeClass;
    if (file.source === 'server' && file.complete) {
      nameEl.title = file.path || file.rel_path || file.name;
    }
    detail.unshift(addModeText(file));
    row.querySelector('.file-meta').innerHTML = metaChips(detail);
    row.classList.toggle('is-failed', failed);

    const bar = row.querySelector('.bar');
    const fill = bar.firstElementChild;
    if (progress === null) {
      bar.hidden = true;
    } else {
      bar.hidden = false;
      bar.classList.toggle('is-error', failed);
      fill.style.width = Math.max(0, Math.min(100, progress)) + '%';
    }

    const link = file.complete && ed2k.status === 'done' ? ed2k.link : '';
    const chip = row.querySelector('.link-chip');
    chip.hidden = !link;
    if (link) {
      chip.querySelector('code').textContent = link;
      chip.title = link;
    }
    row.querySelectorAll('[data-act="copy"]').forEach(button => {
      button.disabled = !link;
      button.classList.toggle('is-disabled', !link);
    });
    row.querySelector('[data-act="retry"]').hidden = !(local && local.error);
  }

  function renderFileList() {
    const list = $('#fileList');
    const tree = buildTree(moduleFiles('ed2k'));
    const entries = flattenTree(tree, state.collapsed);
    const seen = new Set();
    const folderSeen = new Set();
    const orderKeys = [];
    const displayOrder = [];

    entries.forEach(entry => {
      if (entry.type === 'folder') {
        const key = 'f:' + entry.folder.path;
        folderSeen.add(key);
        let row = folderEls.get(key);
        if (!row) {
          row = createFolderRow(entry.folder);
          folderEls.set(key, row);
        }
        updateFolderRow(row, entry.folder, entry.depth);
        orderKeys.push(key);
      } else {
        const file = entry.file;
        seen.add(file.id);
        displayOrder.push(file.id);
        let row = rowEls.get(file.id);
        if (!row) {
          row = createFileRow(file);
          rowEls.set(file.id, row);
        }
        updateFileRow(row, file, entry.depth);
        orderKeys.push('file:' + file.id);
      }
    });

    for (const [key, row] of Array.from(folderEls.entries())) {
      if (!folderSeen.has(key)) {
        row.remove();
        folderEls.delete(key);
      }
    }
    for (const [id, row] of Array.from(rowEls.entries())) {
      if (!seen.has(id)) {
        row.remove();
        rowEls.delete(id);
      }
    }

    state.displayOrder = displayOrder;

    const orderSig = orderKeys.join('|');
    if (orderSig !== state.treeOrderSig) {
      state.treeOrderSig = orderSig;
      const fragment = document.createDocumentFragment();
      entries.forEach(entry => {
        if (entry.type === 'folder') {
          const row = folderEls.get('f:' + entry.folder.path);
          if (row) fragment.appendChild(row);
        } else {
          const row = rowEls.get(entry.file.id);
          if (row) fragment.appendChild(row);
        }
      });
      list.appendChild(fragment);
    }

    $('#filesCard').hidden = false;
    list.hidden = false;
  }

  const MODULE_LABELS = { ed2k: 'ED2K 链接', make: '制作种子', parse: '解析种子', edit: '编辑种子' };

  function historyGroups(module) {
    const keyOf = file => (file.fingerprint || (file.name + '|' + file.size));
    const present = new Set();
    state.files.forEach(file => {
      if (file.complete && moduleOf(file) === module) present.add(keyOf(file));
    });
    const groups = new Map();
    state.files.forEach(file => {
      if (!file.complete || moduleOf(file) === module) return;
      if (present.has(keyOf(file))) return;
      const rel = String(file.rel_path || file.name || '');
      const seg = rel.indexOf('/') >= 0 ? rel.split('/')[0] : '';
      const key = seg ? 'dir:' + seg : 'file:' + file.id;
      let group = groups.get(key);
      if (!group) {
        group = {
          key: key,
          kind: seg ? 'folder' : 'file',
          name: seg || file.name,
          size: 0,
          files: [],
          created: 0,
          module: moduleOf(file)
        };
        groups.set(key, group);
      }
      group.size += Number(file.size) || 0;
      group.files.push(file.id);
      group.created = Math.max(group.created, Number(file.created) || 0);
    });
    return Array.from(groups.values()).sort((a, b) => b.created - a.created);
  }

  function renderHistoryCard(module, ids) {
    const card = $('#' + ids.card);
    const list = $('#' + ids.list);
    const count = $('#' + ids.count);
    if (!card || !list) return;
    const groups = historyGroups(module);
    card.hidden = groups.length === 0;
    if (count) count.textContent = String(groups.reduce((sum, group) => sum + group.files.length, 0));
    const sig = groups.map(group => group.key + ':' + group.files.length).join(',');
    if (state.historySig[module] === sig) return;
    state.historySig[module] = sig;
    list.innerHTML = groups.map(group => {
      const kind = group.kind === 'folder' ? { icon: 'folder' } : fileKind(group.name);
      const meta = group.kind === 'folder'
        ? metaChips([group.files.length + ' 个文件', fmtSize(group.size), '来自 ' + (MODULE_LABELS[group.module] || group.module)])
        : metaChips([fmtSize(group.size), '来自 ' + (MODULE_LABELS[group.module] || group.module)]);
      return '<div class="history-row">' +
        '<span class="history-icon ' + (group.kind === 'folder' ? 'is-folder' : (kind.cls || '')) + '">' + icon(kind.icon) + '</span>' +
        '<div class="history-body">' +
          '<div class="history-name" title="' + esc(group.name) + '">' + esc(group.name) + '</div>' +
          '<div class="history-meta meta-chips">' + meta + '</div>' +
        '</div>' +
        '<button class="mini-btn" type="button" data-history-add="' + group.files.join(',') + '" title="加入当前列表，不会重复上传">' +
          (group.kind === 'folder' ? '整组加入' : '加入') + '</button>' +
      '</div>';
    }).join('');
  }

  async function promoteHistory(ids, module) {
    if (!ids.length || state.historyBusy) return;
    state.historyBusy = true;
    try {
      const result = await api('/api/history/promote', {
        method: 'POST',
        body: { ids: ids, module: module }
      });
      const created = Number(result.created) || 0;
      const skipped = Number(result.skipped) || 0;
      toast(created
        ? '已加入 ' + created + ' 个文件' + (skipped ? '，' + skipped + ' 个已在列表' : '')
        : '这些文件已在当前列表', created ? 'ok' : 'info');
      await refresh();
    } catch (err) {
      toast('加入失败：' + err.message, 'error');
    } finally {
      state.historyBusy = false;
    }
  }

  function renderImported() {
    const links = state.imported;
    $('#importedCard').hidden = links.length === 0;
    $('#importedCount').textContent = String(links.length);
    const signature = links.map(item => item.link).join('|');
    if (signature === state.lastImportedSig) return;
    state.lastImportedSig = signature;

    $('#importedList').innerHTML = links.map((item, index) =>
      '<div class="imported-row">' +
        '<span class="imported-icon">' + icon('link') + '</span>' +
        '<div class="imported-body">' +
          '<div class="imported-name">' + esc(item.name) + '</div>' +
          '<div class="imported-meta meta-chips">' + metaChips([fmtSize(item.size), 'MD4 ' + String(item.hash || '')]) + '</div>' +
          '<code>' + esc(item.link) + '</code>' +
        '</div>' +
        '<div class="imported-actions">' +
          '<button class="icon-btn small" type="button" data-import-copy="' + index + '" title="复制链接" aria-label="复制链接">' + icon('copy') + '</button>' +
          '<button class="icon-btn small danger" type="button" data-import-remove="' + index + '" title="移除" aria-label="移除">' + icon('trash') + '</button>' +
        '</div>' +
      '</div>'
    ).join('');
  }

  function updateSelectionUI() {
    const ed2kFiles = moduleFiles('ed2k');
    const total = ed2kFiles.length;
    const selected = state.selected.size;
    const selectAll = $('#selectAll');
    selectAll.checked = total > 0 && selected === total;
    selectAll.indeterminate = selected > 0 && selected < total;
    selectAll.disabled = total === 0;
    const selectLabel = selectAll.closest('.checkbox');
    if (selectLabel) {
      selectLabel.classList.toggle('is-checked', selectAll.checked);
      selectLabel.classList.toggle('is-partial', selectAll.indeterminate);
    }

    const selectedReady = ed2kFiles.filter(file => state.selected.has(file.id) && file.ed2k && file.ed2k.status === 'done').length;

    updateSelectionBar();

    const doneAll = ed2kFiles.filter(file => file.ed2k && file.ed2k.status === 'done').length;
    const canAll = doneAll > 0 || state.imported.length > 0;
    $('#copyAllBtn').disabled = !canAll;
    $('#exportAllBtn').disabled = !canAll;
    const pushTarget = selected > 0 ? selectedReady : doneAll;
    $('#push115LinksBtn').disabled = pushTarget === 0;
    $('#deleteSelectedBtn').disabled = ed2kFiles.length === 0;
    $('#rehashBtn').disabled = !ed2kFiles.some(file => file.complete);

    const hasImported = state.imported.length > 0;
    ['copyImportedBtn', 'exportImportedBtn', 'clearImportedBtn'].forEach(id => {
      const el = $('#' + id);
      if (el) el.disabled = !hasImported;
    });
  }

  function updateSelectionBar() {
    const bar = $('#selectionBar');
    const tab = state.tab;
    $('#ed2kSelectionActions').hidden = tab !== 'ed2k';
    $('#makeSelectionActions').hidden = tab !== 'make';
    $('#editSelectionActions').hidden = tab !== 'edit';
    $('#parseSelectionActions').hidden = tab !== 'parse';

    if (tab === 'ed2k') {
      updateEd2kQbButtons();
      const count = state.selected.size;
      const total = moduleFiles('ed2k').length;
      const done = moduleFiles('ed2k').filter(file => file.ed2k && file.ed2k.status === 'done').length;
      setSelectionLabel(count
        ? metaChips(['已选 ' + count + ' 项'])
        : (total ? metaChips([total + ' 个文件', '已生成 ' + done + ' 条']) : '暂无文件'));
      bar.classList.toggle('show', total > 0 || state.imported.length > 0);
      return;
    }
    if (tab === 'make') {
      const complete = moduleFiles('make').filter(file => file.complete);
      const count = state.torrentSelected.size;
      const hasResult = !!currentTorrentResult();
      updateTorrentResultActions();
      setSelectionLabel(hasResult
        ? metaChips(['种子已生成', count ? '已选 ' + count + ' 项' : ''])
        : (count ? metaChips(['已选 ' + count + ' 项'])
          : (complete.length ? metaChips([complete.length + ' 个文件']) : '选择文件或文件夹开始')));
      bar.classList.add('show');
      const anySelected = complete.some(file => state.torrentSelected.has(file.id));
      $('#torrentSelectAllLabel').textContent = anySelected ? '取消全选' : '全选';
      $('#torrentSelectAll').disabled = complete.length === 0;
      $('#torrentRemoveBtn').disabled = moduleFiles('make').length === 0;
      updateTorrentButtons();
      return;
    }
    if (tab === 'edit') {
      const count = state.editorSelected.size;
      const total = state.editorTorrents.length;
      setSelectionLabel(total
        ? metaChips(['已载入 ' + total + ' 个种子', count ? '已选 ' + count + ' 项' : ''])
        : '尚未载入种子');
      $('#editSelectAllLabel').textContent = count > 0 ? '取消全选' : '全选';
      $('#editSelectAll').disabled = total === 0;
      $('#editSelectNone').disabled = count === 0;
      $('#editRemoveBtn').disabled = total === 0;
      bar.classList.toggle('show', total > 0);
      return;
    }

    const available = parsePushableItems();
    const picked = available.filter(item => state.parseSelected.has(item.key));
    setSelectionLabel(metaChips([
      '已选 ' + picked.length + ' 项',
      available.length ? '可离线 ' + available.length + ' 条' : ''
    ]));
    bar.classList.toggle('show', picked.length > 0);
    ['parseBarCopy', 'parseBarExport', 'parseBarPush115'].forEach(id => {
      const button = $('#' + id);
      if (button) button.disabled = picked.length === 0;
    });
  }

  function updateEd2kQbButtons() {
    const holder = $('#ed2kBarQb');
    if (!holder) return;
    const servers = (state.integrations && state.integrations.qb_servers) || [];
    const sig = servers.map(server => server.id + ':' + server.name).join('|');
    if (holder.dataset.sig === sig) return;
    holder.dataset.sig = sig;
    holder.innerHTML = servers.map(server =>
      '<button class="btn btn-secondary btn-sm" type="button" data-qb-push="' + esc(server.id) + '" title="创建种子并推送到 ' + esc(server.name) + '">' +
        icon('server') + '推送 ' + esc(server.name) + '</button>'
    ).join('');
  }


  function setSelected(id, value, moveAnchor) {
    if (value) state.selected.add(id);
    else state.selected.delete(id);
    if (moveAnchor !== false) state.anchorId = id;
    renderFileList();
    updateSelectionUI();
  }

  function rangeSelect(id, value) {
    const order = state.displayOrder.length
      ? state.displayOrder
      : moduleFiles('ed2k').map(file => file.id);
    const end = order.indexOf(id);
    if (end < 0) return;
    let start = state.anchorId ? order.indexOf(state.anchorId) : end;
    if (start < 0) start = end;
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    for (let index = from; index <= to; index += 1) {
      const fileId = order[index];
      if (value) state.selected.add(fileId);
      else state.selected.delete(fileId);
    }
    renderFileList();
    updateSelectionUI();
  }

  function toggleFolderSelected(path, value) {
    filesUnderFolder(path).forEach(file => {
      if (value) state.selected.add(file.id);
      else state.selected.delete(file.id);
    });
    state.anchorId = null;
    renderFileList();
    updateSelectionUI();
  }

  function selectAllFiles() {
    moduleFiles('ed2k').forEach(file => state.selected.add(file.id));
    state.anchorId = null;
    renderFileList();
    updateSelectionUI();
  }

  function clearSelection() {
    state.selected.clear();
    state.anchorId = null;
    renderFileList();
    updateSelectionUI();
  }


  function collectLinks(options) {
    options = options || {};
    const seen = new Set();
    const links = [];
    const files = options.files
      ? options.files
      : options.selectedOnly
        ? moduleFiles('ed2k').filter(file => state.selected.has(file.id))
        : moduleFiles('ed2k');
    for (const file of files) {
      const link = file.ed2k && file.ed2k.link;
      if (file.ed2k && file.ed2k.status === 'done' && link && !seen.has(link)) {
        seen.add(link);
        links.push(link);
      }
    }
    if (options.includeImported) {
      for (const item of state.imported) {
        if (item.link && !seen.has(item.link)) {
          seen.add(item.link);
          links.push(item.link);
        }
      }
    }
    return links;
  }

  async function copyAllLinks() {
    const links = collectLinks({ includeImported: true });
    if (!links.length) {
      toast('暂无可复制的链接', 'warn');
      return;
    }
    await copyText(links.join('\r\n'), '已复制 ' + links.length + ' 条链接');
  }

  function exportAllLinks() {
    const links = collectLinks({ includeImported: true });
    if (!links.length) {
      toast('暂无可导出的链接', 'warn');
      return;
    }
    downloadText(links.join('\r\n') + '\r\n', 'ed2k-links-' + stamp() + '.txt');
    toast('已导出 ' + links.length + ' 条链接', 'ok');
  }

  async function copyFolderLinks(path) {
    const links = collectLinks({ files: filesUnderFolder(path) });
    if (!links.length) {
      toast('该文件夹内还没有生成链接', 'warn');
      return;
    }
    await copyText(links.join('\r\n'), '已复制 ' + links.length + ' 条链接');
  }

  function exportFolderLinks(path) {
    const links = collectLinks({ files: filesUnderFolder(path) });
    if (!links.length) {
      toast('该文件夹内还没有生成链接', 'warn');
      return;
    }
    const safeName = String(path).replace(/[/\\:*?"<>|]+/g, '_').slice(0, 60) || 'folder';
    downloadText(links.join('\r\n') + '\r\n', 'ed2k-' + safeName + '-' + stamp() + '.txt');
    toast('已导出 ' + links.length + ' 条链接', 'ok');
  }

  function copyImported() {
    const links = state.imported.map(item => item.link).filter(Boolean);
    if (!links.length) {
      toast('暂无导入的链接', 'warn');
      return;
    }
    copyText(links.join('\r\n'), '已复制 ' + links.length + ' 条导入链接');
  }

  function exportImported() {
    const links = state.imported.map(item => item.link).filter(Boolean);
    if (!links.length) {
      toast('暂无导入的链接', 'warn');
      return;
    }
    downloadText(links.join('\r\n') + '\r\n', 'ed2k-imported-' + stamp() + '.txt');
    toast('已导出 ' + links.length + ' 条导入链接', 'ok');
  }

  function clearImported() {
    state.imported = [];
    saveJSON(LS.imported, []);
    savePrefs({ imported: [] });
    state.lastImportedSig = '';
    renderImported();
    updateSelectionUI();
    toast('已清空导入的链接', 'ok');
  }

  function addImported(links) {
    const map = new Map(state.imported.map(item => [item.link, item]));
    let added = 0;
    links.forEach(item => {
      if (!item.link || map.has(item.link)) return;
      map.set(item.link, { name: item.name, size: item.size, hash: item.hash, link: item.link });
      added += 1;
    });
    state.imported = Array.from(map.values());
    saveJSON(LS.imported, state.imported);
    savePrefs({ imported: state.imported });
    state.lastImportedSig = '';
    renderImported();
    updateSelectionUI();
    toast(added ? '已导入 ' + added + ' 条链接' : '这些链接已经在列表中', added ? 'ok' : 'info');
  }


  async function deleteFiles(ids) {
    const unique = Array.from(new Set(ids)).filter(Boolean);
    if (!unique.length) return;
    try {
      const result = await api('/api/files', { method: 'DELETE', body: { ids: unique } });
      unique.forEach(id => {
        state.selected.delete(id);
        state.torrentSelected.delete(id);
        state.localUploads.delete(id);
      });
      state.anchorId = null;
      await refresh();
      toast('已删除 ' + (result && result.deleted ? result.deleted : unique.length) + ' 个文件', 'ok');
      schedulePoll(300);
    } catch (err) {
      toast('删除失败：' + err.message, 'error');
    }
  }

  async function rehashFiles() {
    const ids = state.selected.size
      ? Array.from(state.selected)
      : moduleFiles('ed2k').filter(file => file.complete).map(file => file.id);
    if (!ids.length) {
      toast('没有可计算的已上传文件', 'warn');
      return;
    }
    try {
      const result = await api('/api/ed2k/hash', { method: 'POST', body: { ids } });
      toast(result.queued ? '已开始计算 ' + result.queued + ' 个文件' : '没有需要计算的文件', result.queued ? 'info' : 'warn');
      schedulePoll(300);
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }


  function resetUploadBatch() {
    uploadBatch.gen += 1;
    uploadBatch.items.clear();
    uploadBatch.activeKeys.clear();
    uploadBatch.createdIds.clear();
    uploadBatch.currentKey = '';
    uploadBatch.active = true;
    uploadBatch.paused = false;
    uploadBatch.cancelled = false;
    if (uploadBatch.hideTimer) {
      clearTimeout(uploadBatch.hideTimer);
      uploadBatch.hideTimer = null;
    }
  }

  function updateUploadItem(key, patch) {
    const item = uploadBatch.items.get(key);
    if (!item) return;
    Object.assign(item, patch);
    renderUploadProgress();
  }

  function renderUploadProgress() {
    const panel = $('#uploadPanel');
    if (!panel) return;
    const items = Array.from(uploadBatch.items.values());
    if (!items.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const total = items.length;
    const processed = items.filter(item =>
      item.status === 'done' || item.status === 'failed' || item.status === 'skipped').length;
    const totalBytes = items.reduce((sum, item) => sum + (item.size || 0), 0);
    const sentBytes = items.reduce((sum, item) => {
      if (item.status === 'done') return sum + (item.size || 0);
      return sum + Math.min(item.sent || 0, item.size || 0);
    }, 0);
    let percent = totalBytes > 0
      ? (sentBytes / totalBytes) * 100
      : (total ? (processed / total) * 100 : 0);
    if (!uploadBatch.cancelled && !uploadBatch.active) percent = 100;
    percent = Math.max(0, Math.min(100, percent));

    $('#uploadTitle').textContent = uploadBatch.cancelled
      ? '已取消添加'
      : uploadBatch.paused
        ? '已暂停'
        : uploadBatch.active ? '正在添加文件' : '添加完成';
    $('#uploadCount').textContent = '已处理 ' + processed + ' / ' + total + ' 项';
    $('#uploadPercent').textContent = Math.round(percent) + '%';
    $('#uploadOverallBar').style.width = percent + '%';

    const current = uploadBatch.items.get(uploadBatch.currentKey) ||
      items.find(item => item.status === 'uploading') || null;
    if (current) {
      const currentPercent = current.size > 0
        ? Math.min(100, ((current.status === 'done' ? current.size : current.sent || 0) / current.size) * 100)
        : 0;
      $('#uploadCurrentName').textContent = current.name;
      $('#uploadCurrentPct').textContent =
        fmtSize(current.status === 'done' ? current.size : current.sent || 0) + ' / ' + fmtSize(current.size) +
        ' · ' + Math.round(currentPercent) + '%';
      const showFileBar = current.status === 'uploading' && current.size >= CHUNK_SIZE;
      $('#uploadFileTrack').hidden = !showFileBar;
      if (showFileBar) $('#uploadFileBar').style.width = currentPercent + '%';
    } else {
      $('#uploadCurrentName').textContent = uploadBatch.active ? '等待队列中的文件…' : '全部处理完成';
      $('#uploadCurrentPct').textContent = '';
      $('#uploadFileTrack').hidden = true;
    }

    $('#uploadPauseBtn').textContent = uploadBatch.paused ? '继续' : '暂停';
    $('#uploadPauseBtn').disabled = !uploadBatch.active;
    $('#uploadCancelBtn').disabled = !uploadBatch.active;
  }

  function waitWhilePaused() {
    return new Promise(resolve => {
      const check = () => {
        if (!uploadBatch.paused || uploadBatch.cancelled) resolve();
        else setTimeout(check, 150);
      };
      check();
    });
  }

  function uploadCancelledError() {
    const error = new Error('已取消上传');
    error.cancelled = true;
    return error;
  }

  function cancelUploads() {
    if (!uploadBatch.active) return;
    uploadBatch.cancelled = true;
    uploadBatch.paused = false;
    uploadQueue.splice(0).forEach(job => {
      state.uploading.delete(job.key);
      const item = uploadBatch.items.get(job.key);
      if (item && item.status === 'queued') item.status = 'skipped';
    });
    uploadAborters.forEach(controller => controller.abort());
    uploadAborters.clear();
    renderUploadProgress();
    if (activeUploads === 0 && !uploadQueue.length) finishUploadBatch();
  }

  function toggleUploadPause() {
    if (!uploadBatch.active) return;
    uploadBatch.paused = !uploadBatch.paused;
    renderUploadProgress();
    if (!uploadBatch.paused) pumpUploads();
  }

  function finishUploadBatch() {
    if (!uploadBatch.active || uploadBatch.cancelled) {
      if (uploadBatch.active && uploadBatch.cancelled && activeUploads === 0 && !uploadQueue.length) {
        uploadBatch.active = false;
        renderUploadProgress();
        const ids = Array.from(uploadBatch.createdIds);
        uploadBatch.createdIds.clear();
        if (ids.length) {
          ids.forEach(id => state.localUploads.delete(id));
          api('/api/files', { method: 'DELETE', body: { ids: ids } })
            .then(() => refresh())
            .catch(() => {});
        }
        toast('已取消文件添加', 'warn');
        scheduleUploadPanelHide(900);
      }
      return;
    }
    if (activeUploads > 0 || uploadQueue.length) return;
    uploadBatch.active = false;
    renderUploadProgress();
    const items = Array.from(uploadBatch.items.values());
    const failed = items.filter(item => item.status === 'failed').length;
    const skipped = items.filter(item => item.status === 'skipped').length;
    const done = items.filter(item => item.status === 'done').length;
    if (failed) toast('添加完成：成功 ' + done + ' 个，失败 ' + failed + ' 个', 'warn');
    else if (skipped) toast('添加完成：新增 ' + done + ' 个，跳过 ' + skipped + ' 个', 'info');
    else toast('已添加 ' + done + ' 个文件', 'ok');
    scheduleUploadPanelHide(1800);
  }

  function scheduleUploadPanelHide(delay) {
    if (uploadBatch.hideTimer) clearTimeout(uploadBatch.hideTimer);
    const gen = uploadBatch.gen;
    uploadBatch.hideTimer = setTimeout(() => {
      uploadBatch.hideTimer = null;
      if (uploadBatch.gen === gen && !uploadBatch.active) $('#uploadPanel').hidden = true;
    }, delay);
  }

  function addItems(items, module) {
    module = module || currentModule();
    const accepted = [];
    for (const item of items) {
      const file = item.file;
      if (!file) continue;
      if (!file.size) {
        toast('已跳过空文件：' + file.name, 'warn');
        continue;
      }
      const relPath = String(item.relPath || file.name).replace(/\\/g, '/');
      const key = module + '|' + relPath + '|' + file.size + '|' + (file.lastModified || 0);
      if (state.uploading.has(key)) continue;
      state.uploading.add(key);
      accepted.push({ file: file, relPath: relPath, key: key, module: module });
    }
    if (!accepted.length) return;
    if (!uploadBatch.active || uploadBatch.cancelled) resetUploadBatch();
    accepted.forEach(job => {
      uploadQueue.push(job);
      uploadBatch.items.set(job.key, {
        name: job.file.name,
        size: job.file.size,
        sent: 0,
        status: 'queued'
      });
    });
    if (!uploadBatch.currentKey) uploadBatch.currentKey = accepted[0].key;
    renderUploadProgress();
    pumpUploads();
    toast(accepted.length === 1
      ? '正在上传 ' + accepted[0].file.name
      : '已加入 ' + accepted.length + ' 个文件', 'info');
  }

  function pumpUploads() {
    while (!uploadBatch.cancelled && !uploadBatch.paused && activeUploads < MAX_PARALLEL_UPLOADS && uploadQueue.length) {
      const job = uploadQueue.shift();
      const gen = uploadBatch.gen;
      activeUploads += 1;
      uploadBatch.activeKeys.add(job.key);
      uploadBatch.currentKey = job.key;
      runUpload(job, gen).finally(() => {
        activeUploads -= 1;
        uploadBatch.activeKeys.delete(job.key);
        if (uploadBatch.currentKey === job.key) {
          const next = Array.from(uploadBatch.activeKeys).pop();
          if (next) {
            uploadBatch.currentKey = next;
          } else {
            const queued = Array.from(uploadBatch.items.entries())
              .find(entry => entry[1].status === 'queued');
            uploadBatch.currentKey = queued ? queued[0] : '';
          }
        }
        pumpUploads();
        finishUploadBatch();
      });
    }
    if (!uploadQueue.length && activeUploads === 0) finishUploadBatch();
  }

  async function runUpload(job, gen) {
    const file = job.file;
    const stale = () => gen !== uploadBatch.gen;
    try {
      await waitWhilePaused();
      if (stale() || uploadBatch.cancelled) throw uploadCancelledError();

      const init = await api('/api/uploads/init', {
        method: 'POST',
        body: {
          name: file.name,
          rel_path: job.relPath,
          size: file.size,
          mtime: file.lastModified || 0,
          module: job.module || 'ed2k'
        }
      });
      if (stale()) return;
      const id = init.id;
      if (uploadBatch.cancelled) {
        uploadBatch.createdIds.add(id);
        throw uploadCancelledError();
      }
      if (init.complete) {
        state.uploading.delete(job.key);
        updateUploadItem(job.key, { status: 'skipped', sent: file.size });
        toast('已存在：' + file.name + '，已跳过', 'info');
        await refresh();
        return;
      }

      const local = {
        sent: Number(init.offset) || 0,
        total: file.size,
        file: file,
        relPath: job.relPath,
        key: job.key,
        module: job.module || 'ed2k',
        error: false
      };
      state.localUploads.set(id, local);
      uploadBatch.createdIds.add(id);
      updateUploadItem(job.key, { sent: local.sent, status: 'uploading' });
      await refresh();

      let offset = local.sent;
      while (offset < file.size) {
        await waitWhilePaused();
        if (stale()) throw uploadCancelledError();
        if (uploadBatch.cancelled) throw uploadCancelledError();

        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const controller = new AbortController();
        uploadAborters.add(controller);
        let response;
        try {
          response = await fetch('/api/uploads/' + id + '/chunk?offset=' + offset, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file.slice(offset, end),
            signal: controller.signal
          });
        } finally {
          uploadAborters.delete(controller);
        }
        if (stale()) throw uploadCancelledError();
        if (response.status === 409) {
          let data = null;
          try { data = await response.json(); } catch (err) { data = null; }
          if (data && typeof data.offset === 'number' && data.offset !== offset) {
            offset = data.offset;
            local.sent = offset;
            updateUploadItem(job.key, { sent: offset });
            if (state.tab === 'ed2k') renderFileList();
            continue;
          }
          throw new Error((data && data.error) || '上传状态冲突');
        }
        if (!response.ok) {
          let message = '上传失败';
          try {
            const data = await response.json();
            if (data && data.error) message = data.error;
          } catch (err) { }
          throw new Error(message);
        }
        offset = end;
        local.sent = offset;
        updateUploadItem(job.key, { sent: offset });
        if (state.tab === 'ed2k') renderFileList();
      }

      if (stale()) return;
      await api('/api/uploads/' + id + '/complete', { method: 'POST', body: {} });
      state.localUploads.delete(id);
      uploadBatch.createdIds.delete(id);
      state.uploading.delete(job.key);
      updateUploadItem(job.key, { status: 'done', sent: file.size });
      if ((job.module || 'ed2k') === 'make') state.torrentTouched = false;
      refresh().then(() => schedulePoll(400)).catch(() => {});
    } catch (err) {
      state.uploading.delete(job.key);
      if (stale()) return;
      const cancelled = err && (err.cancelled || uploadBatch.cancelled || err.name === 'AbortError');
      if (cancelled) {
        updateUploadItem(job.key, { status: 'skipped' });
        return;
      }
      let errorLocalId = null;
      for (const [id, record] of state.localUploads.entries()) {
        if (record.key === job.key) {
          errorLocalId = id;
          break;
        }
      }
      if (errorLocalId) {
        const record = state.localUploads.get(errorLocalId);
        record.error = true;
        record.file = file;
        record.relPath = job.relPath;
        record.key = job.key;
        record.total = file.size;
      }
      updateUploadItem(job.key, { status: 'failed' });
      toast('上传失败：' + err.message, 'error');
      renderFileList();
    }
  }

  function retryUpload(id) {
    const record = state.localUploads.get(id);
    if (!record || !record.file) {
      toast('请重新添加该文件以续传', 'warn');
      return;
    }
    if (state.uploading.has(record.key)) return;
    record.error = false;
    state.uploading.add(record.key);
    state.localUploads.set(id, record);
    if (!uploadBatch.active || uploadBatch.cancelled) resetUploadBatch();
    uploadBatch.items.set(record.key, {
      name: record.file.name,
      size: record.file.size,
      sent: Number(record.sent) || 0,
      status: 'queued'
    });
    if (!uploadBatch.currentKey) uploadBatch.currentKey = record.key;
    uploadQueue.push({ file: record.file, relPath: record.relPath, key: record.key, module: record.module || 'ed2k' });
    renderUploadProgress();
    renderFileList();
    pumpUploads();
  }


  function syncTorrentSelection() {
    if (state.torrentTouched) return;
    const ids = moduleFiles('make').filter(file => file.complete).map(file => file.id);
    const same = ids.length === state.torrentSelected.size &&
      ids.every(id => state.torrentSelected.has(id));
    if (!same) state.torrentSelected = new Set(ids);
  }

  function isJobRunning() {
    const job = state.jobs.find(item => item.id === state.torrentJobId);
    return !!job && (job.status === 'queued' || job.status === 'running');
  }

  function selectedCompleteFiles() {
    return Array.from(state.torrentSelected)
      .map(id => findFile(id))
      .filter(file => file && file.complete);
  }

  let ed2kRequestAt = 0;
  const ed2kRequested = new Set();


  function ensureEd2kComputation() {
    const toggle = $('#torrentEmbedEd2k');
    if (!toggle || !toggle.checked) return;
    const missing = selectedCompleteFiles().filter(file => {
      const status = file.ed2k && file.ed2k.status;
      return status !== 'done' && status !== 'queued' && status !== 'running' &&
        status !== 'error' && !ed2kRequested.has(file.id);
    });
    if (!missing.length) return;
    const now = Date.now();
    if (now - ed2kRequestAt < 1200) return;
    ed2kRequestAt = now;
    missing.forEach(file => ed2kRequested.add(file.id));
    api('/api/ed2k/hash', { method: 'POST', body: { ids: missing.map(file => file.id) } })
      .then(() => schedulePoll(300))
      .catch(() => missing.forEach(file => ed2kRequested.delete(file.id)));
  }

  function updateTorrentButtons() {
    const button = $('#generateTorrentBtn');
    if (!button) return;
    const running = isJobRunning();
    const embed = $('#torrentEmbedEd2k') && $('#torrentEmbedEd2k').checked;
    const selected = selectedCompleteFiles();
    const pending = embed
      ? selected.filter(file => {
          const status = file.ed2k && file.ed2k.status;
          return status !== 'done' && status !== 'error';
        })
      : [];
    const computing = pending.length > 0;
    button.disabled = selected.length === 0 || running || computing;
    if (running) {
      button.innerHTML = icon('refresh') + ' 正在生成…';
      button.title = '种子正在生成，请稍候';
    } else if (computing) {
      const progress = Math.round(pending.reduce((sum, file) => {
        return sum + (Number(file.ed2k && file.ed2k.progress) || 0);
      }, 0) / pending.length);
      button.innerHTML = icon('refresh') + ' 正在计算 ED2K ' + progress + '%…';
      button.title = '所选文件的 ED2K 计算完成后即可生成种子';
    } else {
      button.innerHTML = icon('magnet') + ' 生成 .torrent';
      button.title = '用所选文件生成 .torrent';
    }
    ensureEd2kComputation();
  }

  function currentTorrentResult() {
    const job = state.jobs.find(item => item.id === state.torrentJobId);
    return job && job.status === 'done' && job.result ? job.result : null;
  }

  function updateTorrentResultActions() {
    const result = currentTorrentResult();
    ['makeBarDownload', 'makeBarPush115', 'makeBarMagnet'].forEach(id => {
      const el = $('#' + id);
      if (el) el.hidden = !result;
    });
    const qb = $('#makeBarQb');
    if (qb) {
      qb.innerHTML = result
        ? (state.integrations.qb_servers || []).map(server =>
            '<button class="btn btn-secondary btn-sm" type="button" data-push="qb" data-server="' + esc(server.id) + '" title="推送到 ' + esc(server.name) + '">' +
            icon('server') + ' ' + esc(server.name) + '</button>').join('')
        : '';
    }
    if (!result) return;
    const download = $('#makeBarDownload');
    if (download) {
      download.href = result.download || '#';
      download.setAttribute('download', result.file_name || '');
    }
    const magnet = $('#makeBarMagnet');
    if (magnet) magnet.dataset.copyMagnet = magnetForTorrent(result);
  }

  function toggleTorrentFolder(path) {
    if (state.torrentCollapsed.has(path)) state.torrentCollapsed.delete(path);
    else state.torrentCollapsed.add(path);
    state.pickerSig = '';
    renderTorrentPicker();
  }

  function toggleTorrentFolderSelected(path) {
    const files = filesUnderFolder(path, moduleFiles('make').filter(file => file.complete));
    if (!files.length) return;
    const all = files.every(file => state.torrentSelected.has(file.id));
    files.forEach(file => {
      if (all) state.torrentSelected.delete(file.id);
      else state.torrentSelected.add(file.id);
    });
    state.torrentTouched = true;
    state.pickerSig = '';
    renderTorrentPicker();
  }

  function renderTorrentPicker() {
    syncTorrentSelection();
    const complete = moduleFiles('make').filter(file => file.complete);
    const tree = buildTree(complete);
    const entries = flattenTree(tree, state.torrentCollapsed);
    const signature = entries.map(entry => entry.type === 'folder'
      ? 'f:' + entry.folder.path + '@' + entry.depth
      : 'i:' + entry.file.id + '@' + entry.depth
    ).join('|') + '#' + Array.from(state.torrentSelected).sort().join(',');
    const picker = $('#torrentPicker');

    if (signature !== state.pickerSig) {
      state.pickerSig = signature;
      if (!complete.length) {
        picker.innerHTML = '<div class="picker-empty">还没有可用文件，点击右上角「添加文件」或「文件夹」开始</div>';
      } else {
        picker.innerHTML = entries.map(entry => {
          const indent = 12 + Math.min(8, entry.depth) * 16;
          if (entry.type === 'folder') {
            const files = filesUnderFolder(entry.folder.path, complete);
            const selected = files.filter(file => state.torrentSelected.has(file.id)).length;
            const all = files.length > 0 && selected === files.length;
            const partial = selected > 0 && !all;
            const expanded = !state.torrentCollapsed.has(entry.folder.path);
            return '<div class="picker-row folder-row" data-folder="' + esc(entry.folder.path) + '" style="padding-left:' + indent + 'px">' +
              '<button class="tree-toggle' + (expanded ? ' is-expanded' : '') + '" type="button" data-act="toggle-folder" title="展开 / 收起" aria-label="展开或收起">' + icon('chevron') + '</button>' +
              '<label class="checkbox' + (all ? ' is-checked' : '') + (partial ? ' is-partial' : '') + '" title="选中该文件夹内全部文件">' +
                '<input type="checkbox" data-folder-pick="' + esc(entry.folder.path) + '"' + (all ? ' checked' : '') + '>' +
                '<span class="box">' + icon('check') + '</span>' +
              '</label>' +
              '<span class="folder-icon">' + icon('folder') + '</span>' +
              '<span class="picker-body"><strong>' + esc(entry.folder.name) + '</strong><small class="meta-chips">' + metaChips([files.length + ' 个文件', '已选 ' + selected]) + '</small></span>' +
            '</div>';
          }
          const file = entry.file;
          const selected = state.torrentSelected.has(file.id);
          const kind = fileKind(file.name);
          return '<div class="picker-row' + (selected ? ' is-selected' : '') + '" data-id="' + file.id + '" style="padding-left:' + indent + 'px">' +
            '<label class="checkbox' + (selected ? ' is-checked' : '') + '" title="选择该文件加入种子"><input type="checkbox" data-pick="' + file.id + '"' + (selected ? ' checked' : '') + '>' +
            '<span class="box">' + icon('check') + '</span></label>' +
            '<span class="file-icon ' + kind.cls + '">' + icon(kind.icon) + '</span>' +
            '<span class="picker-body"><strong>' + esc(fileRelPath(file)) + '</strong>' +
            '<small>' + fmtSize(file.size) + '</small></span>' +
          '</div>';
        }).join('');
      }
    }

    $('#torrentSelectedCount').textContent = state.torrentSelected.size + ' 已选';
    updateTorrentButtons();
    updateSelectionUI();
    scheduleEstimate();
  }

  let estimateTimer = null;
  let estimateSeq = 0;
  let estimateKey = '';


  function pieceSizeValue() {
    const input = $('#torrentPiece');
    if (!input) return 0;
    const text = String(input.value || '').trim();
    if (!text || text === '0') return 0;
    const bytes = Number(text);
    if (!Number.isFinite(bytes) || bytes < 16384 || bytes > 134217728) return NaN;
    return bytes;
  }

  function pieceSizeLabel(bytes) {
    if (!bytes) return '自动（推荐）';
    if (bytes >= 1048576) return (bytes / 1048576) + ' MiB';
    return (bytes / 1024) + ' KiB';
  }


  function setPieceSize(bytes) {
    const wrap = $('#torrentPieceMenu');
    const input = $('#torrentPiece');
    if (!wrap || !input) return;
    const valid = Number(bytes) > 0 ? Number(bytes) : 0;
    input.value = String(valid);
    wrap.dataset.value = String(valid);
    const label = $('#torrentPieceLabel', wrap);
    if (label) label.textContent = pieceSizeLabel(valid);
    $$('.select-option', wrap).forEach(option => {
      const on = Number(option.dataset.value) === valid;
      option.classList.toggle('is-active', on);
      option.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }


  function legacyPieceBytes(text) {
    const match = String(text || '').trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(kib|kb|k|mib|mb|m|b)?$/i);
    if (!match) return NaN;
    const amount = Number(match[1]);
    const unit = (match[2] || '').toLowerCase();
    if (!unit || unit === 'b') return Math.round(amount);
    if (unit === 'kib' || unit === 'kb' || unit === 'k') return Math.round(amount * 1024);
    return Math.round(amount * 1024 * 1024);
  }

  function estimateSignature() {
    return [
      Array.from(state.torrentSelected).sort().map(id => {
        const file = findFile(id);
        const link = file && file.ed2k && file.ed2k.status === 'done' ? file.ed2k.link : '';
        return id + ':' + link.length;
      }).join(','),
      $('#torrentName').value,
      $('#torrentTrackers').value,
      $('#torrentPiece').value,
      $('#torrentPrivate').checked,
      $('#torrentEmbedEd2k').checked,
      $('#torrentComment').value
    ].join('|');
  }

  function scheduleEstimate() {
    const signature = estimateSignature();
    if (signature === estimateKey) return;
    estimateKey = signature;
    clearTimeout(estimateTimer);
    estimateTimer = setTimeout(updateTorrentEstimate, 300);
  }

  async function updateTorrentEstimate() {
    const line = $('#torrentEstimate');
    if (!line) return;
    const ids = Array.from(state.torrentSelected);
    if (!ids.length) {
      estimateSeq += 1;
      line.textContent = '预计 —';
      return;
    }
    const seq = ++estimateSeq;
    const piece = pieceSizeValue();
    if (Number.isNaN(piece)) {
      line.textContent = '分块大小无效';
      line.title = '请选择 16 KiB 到 128 MiB 的固定档位';
      return;
    }
    try {
      const data = await api('/api/torrent/estimate', {
        method: 'POST',
        body: {
          ids: ids,
          name: $('#torrentName').value.trim(),
          trackers: trackerEntries(),
          piece_size: piece,
          private: $('#torrentPrivate').checked,
          embed_ed2k: $('#torrentEmbedEd2k').checked,
          comment: $('#torrentComment').value.trim()
        }
      });
      if (seq !== estimateSeq) return;
      const bytes = Number(data.size) || 0;
      line.classList.add('meta-chips');
      line.innerHTML = metaChips(['预计 ' + fmtSize(bytes), bytes.toLocaleString('en-US') + ' B', data.piece_count + ' 块']);
      line.title = '预计 .torrent 大小：' + bytes.toLocaleString('en-US') +
        ' 字节（按当前文件、分块大小、Tracker、私有与内嵌选项精确计算）';
    } catch (err) {
      if (seq !== estimateSeq) return;
      line.textContent = '预计 —';
    }
  }

  function torrentTreeHtml(files, rootName) {
    const list = (Array.isArray(files) ? files : []).slice(0, 500);
    if (!list.length) return '';
    const single = list.length === 1 && String(list[0].path || '').indexOf('/') < 0 &&
      (!rootName || list[0].path === rootName);
    const root = { dirs: new Map(), files: [] };
    list.forEach(item => {
      const parts = String(item.path || '').split('/').filter(Boolean);
      const name = parts.pop() || String(item.path || '');
      let node = root;
      parts.forEach(part => {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      });
      node.files.push({ name: name, size: item.size });
    });
    const row = (name, size, depth, folder) =>
      '<div class="tree-row" style="padding-left:' + (depth * 14) + 'px">' +
        '<span class="tree-icon">' + icon(folder ? 'folder' : fileKind(name).icon) + '</span>' +
        '<span class="tree-name">' + esc(name) + '</span>' +
        (size ? '<span class="tree-size">' + fmtSize(size) + '</span>' : '') +
      '</div>';
    let body = '';
    if (single) {
      body = row(list[0].path, list[0].size, 0, false);
    } else {
      body = row(rootName || '种子根目录', 0, 0, true);
      const walk = (node, depth) => {
        let html = '';
        node.dirs.forEach((child, name) => {
          html += row(name, 0, depth, true) + walk(child, depth + 1);
        });
        node.files
          .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'))
          .forEach(file => { html += row(file.name, file.size, depth, false); });
        return html;
      };
      body += walk(root, 1);
    }
    return '<details class="torrent-tree">' +
      '<summary>' + icon('folder') + ' 目录结构<span>' + list.length + ' 个文件</span></summary>' +
      '<div class="torrent-tree-body">' + body + '</div>' +
    '</details>';
  }

  function magnetName(name) {
    return Array.from(String(name || '')).map(ch => {
      const code = ch.codePointAt(0);
      if (code >= 128) return ch;
      return /[A-Za-z0-9\-._~]/.test(ch) ? ch : '%' + code.toString(16).toUpperCase().padStart(2, '0');
    }).join('');
  }

  function magnetForTorrent(result) {
    let magnet = 'magnet:?xt=urn:btih:' + (result.info_hash || '') +
      '&dn=' + magnetName(result.name || '');
    (result.trackers || []).slice(0, 30).forEach(tracker => {
      magnet += '&tr=' + encodeURIComponent(tracker);
    });
    return magnet;
  }

  function renderTorrentJob() {
    const panel = $('#torrentJob');
    if (!panel) return;

    const job = state.jobs.find(item => item.id === state.torrentJobId);
    if (!job) {
      if (state.torrentJobId && state.rev >= 0) {
        state.torrentJobId = '';
        state.torrentJobSig = '';
        localStorage.removeItem(LS.lastJob);
        savePrefs({ last_torrent_job: '' });
      }
      panel.hidden = true;
      panel.innerHTML = '';
      updateTorrentButtons();
      return;
    }

    const signature = job.status + '|' + job.progress + '|' + (job.error || '') +
      '|' + (job.result ? job.result.info_hash : '');
    if (signature === state.torrentJobSig) {
      updateTorrentButtons();
      return;
    }
    state.torrentJobSig = signature;
    panel.hidden = false;

    if (job.status === 'queued' || job.status === 'running') {
      const percent = Math.max(0, Math.min(100, Number(job.progress) || 0));
      panel.innerHTML =
        '<div class="job-head"><strong>' + (job.status === 'queued' ? '等待处理' : '正在生成种子') + '</strong><span>' + percent.toFixed(0) + '%</span></div>' +
        '<div class="bar"><span style="width:' + percent + '%"></span></div>' +
        '<p class="job-msg">' + esc(job.message || '正在读取文件并计算 SHA-1 分块…') + '</p>';
    } else if (job.status === 'done' && job.result) {
      const result = job.result;
      const trackerText = result.trackers && result.trackers.length
        ? result.trackers.length + ' 个'
        : '未设置';
      panel.innerHTML =
        '<div class="torrent-result">' +
          '<div class="result-top">' +
            '<div class="result-head">' +
              '<span class="file-icon kind-video">' + icon('magnet') + '</span>' +
              '<div><strong>' + esc(result.file_name) + '</strong>' +
              '<span class="meta-chips">' + metaChips([result.file_count + ' 个文件', fmtSize(result.total_size)]) + '</span></div>' +
            '</div>' +
            '<div class="meta-row">' +
              '<div class="meta-item"><span class="meta-label">Info Hash</span><span class="meta-value" title="' + esc(result.info_hash) + '"><code>' + esc(result.info_hash) + '</code></span></div>' +
              '<div class="meta-item"><span class="meta-label">种子大小</span><span class="meta-value">' + fmtSize(result.size || 0) + '</span></div>' +
              '<div class="meta-item"><span class="meta-label">分块</span><span class="meta-value meta-chips">' + metaChips([fmtPiece(result.piece_length), result.piece_count + ' 块']) + '</span></div>' +
              '<div class="meta-item"><span class="meta-label">类型</span><span class="meta-value">' + (result.private ? '私有种子' : '公开种子') + '</span></div>' +
              '<div class="meta-item"><span class="meta-label">内嵌 ED2K</span><span class="meta-value">' + (result.embedded_count ? result.embedded_count + ' 条' : '未写入') + '</span></div>' +
              '<div class="meta-item"><span class="meta-label">Tracker</span><span class="meta-value">' + trackerText + '</span></div>' +
            '</div>' +
          '</div>' +
          torrentTreeHtml(result.files, result.name) +
        '</div>';
    } else {
      panel.innerHTML =
        '<div class="job-head"><strong>生成失败</strong></div>' +
        '<div class="job-error">' + esc(job.error || '未知错误') + '</div>';
    }

    updateTorrentButtons();
  }

  function currentImports() {
    if (state.torrentImports && state.torrentImports.length) return state.torrentImports;
    if (state.torrentImport) return [{ info: state.torrentImport, blob: state.torrentImportFile }];
    return [];
  }

  function buildParseItems() {
    const items = [];
    currentImports().forEach((entry, torrentIndex) => {
      const info = entry.info;
      const embedded = Array.isArray(info.embedded_links) ? info.embedded_links : [];
      const used = new Set();
      const prefix = torrentIndex + ':';
      (info.matched_files || []).slice(0, 200).forEach((match, index) => {
        const live = match.file_id ? findFile(match.file_id) : null;
        const base = String(match.path || '').split('/').pop();
        let embeddedIndex = -1;
        for (let i = 0; i < embedded.length; i += 1) {
          if (used.has(i) || !embedded[i].link) continue;
          const sameName = (embedded[i].name || '') === base || (embedded[i].name || '') === (match.path || '');
          const sameSize = !embedded[i].size || !match.size || Number(embedded[i].size) === Number(match.size);
          if (sameName && sameSize) {
            embeddedIndex = i;
            used.add(i);
            break;
          }
        }
        const liveLink = live && live.ed2k && live.ed2k.status === 'done' ? live.ed2k.link : '';
        const embeddedLink = embeddedIndex >= 0 ? embedded[embeddedIndex].link : '';
        items.push({
          key: prefix + 'm' + index,
          name: match.path || base,
          path: match.path || '',
          size: match.size,
          link: liveLink || embeddedLink,
          matched: !!match.file_id,
          embedded: embeddedIndex >= 0,
          live: !!liveLink,
          status: live && live.ed2k ? live.ed2k.status : ''
        });
      });
      embedded.forEach((embed, index) => {
        if (used.has(index) || !embed.link) return;
        items.push({
          key: prefix + 'e' + index,
          name: embed.name || 'ED2K',
          path: embed.name || '',
          size: embed.size,
          link: embed.link,
          matched: false,
          embedded: true,
          live: false,
          status: ''
        });
      });
    });
    return items;
  }

  function parsePushableItems() {
    return buildParseItems()
      .filter(item => item.link)
      .map(item => ({ key: item.key, url: item.link, path: item.path, label: item.name }));
  }

  function parseSelectedLinks() {
    return parsePushableItems()
      .filter(item => state.parseSelected.has(item.key))
      .map(item => item.url)
      .filter(Boolean);
  }

  function updateParsePushUI() {
    updateSelectionUI();
  }

  function renderTorrentImport(force) {
    const container = $('#torrentImportResult');
    if (!container) return;
    const imports = currentImports();
    if (!imports.length) {
      container.innerHTML = '';
      state.torrentImportSig = '';
      return;
    }

    const signature = imports.map(entry => {
      const info = entry.info;
      return info.info_hash + '|' + info.matched_files.map(item => {
        const file = item.file_id ? findFile(item.file_id) : null;
        return (item.file_id || '') + ':' + (file && file.ed2k ? file.ed2k.status : 'gone') + ':' + (file && file.ed2k ? file.ed2k.link : '');
      }).join(',');
    }).join('||') + '#' + librarySig();
    if (!force && signature === state.torrentImportSig) return;
    state.torrentImportSig = signature;


    const openTrees = Array.from(container.querySelectorAll('details.torrent-tree')).map(node => node.open);
    const pageScroll = window.scrollY || window.pageYOffset || 0;
    const prevList = $('.parse-list', container);
    const listScroll = prevList ? prevList.scrollTop : 0;

    const single = imports.length === 1;
    const totalFiles = imports.reduce((sum, entry) => sum + (entry.info.file_count || 0), 0);
    const countPill = $('#parseCountPill');
    if (countPill) {
      countPill.textContent = single
        ? totalFiles + ' 个文件'
        : imports.length + ' 个种子 · ' + totalFiles + ' 个文件';
    }

    const items = buildParseItems();
    const rows = items.map(item => {
      const picked = item.link && state.parseSelected.has(item.key);
      const kind = fileKind(item.name);
      let caption = fmtSize(item.size);
      if (item.live) caption += ' · 已匹配，可直接推送';
      else if (item.embedded && item.matched) caption += ' · 内嵌 ED2K';
      else if (item.embedded) caption += ' · 仅内嵌链接';
      else if (item.matched && (item.status === 'running' || item.status === 'queued')) caption += ' · 计算中';
      else if (item.matched && item.status === 'error') caption += ' · 计算失败';
      else if (item.matched) caption += ' · 待计算';
      else caption += ' · 未找到同大小文件';
      return '<div class="picker-row' + (picked ? ' is-selected' : '') + '" data-parse-key="' + item.key + '">' +
        (item.link
          ? '<label class="checkbox' + (picked ? ' is-checked' : '') + '" title="选择该链接用于复制或推送"><input type="checkbox" class="parse-check" data-pick="' + item.key + '"' + (picked ? ' checked' : '') + '><span class="box">' + icon('check') + '</span></label>'
          : '<span class="parse-check-spacer"></span>') +
        '<span class="file-icon ' + kind.cls + '">' + icon(kind.icon) + '</span>' +
        '<span class="picker-body"><strong>' + esc(item.name) + '</strong><small>' + esc(caption) + '</small>' +
          (item.link ? '<code class="picker-link" title="' + esc(item.link) + '">' + esc(item.link) + '</code>' : '') +
        '</span>' +
        (item.link
          ? '<button class="mini-copy" type="button" data-parse-copy="' + item.key + '" title="复制链接" aria-label="复制链接">' + icon('copy') + '</button>'
          : '') +
      '</div>';
    }).join('');

    const qbButtons = single
      ? ((state.integrations && state.integrations.qb_servers) || []).map(server =>
          '<button class="btn btn-secondary btn-sm" type="button" data-action="push-qb" data-server="' + esc(server.id) + '" title="把种子推送到 ' + esc(server.name) + '">' +
            icon('server') + ' 推送 ' + esc(server.name) + '</button>'
        ).join('')
      : '';
    const hashButton = '<button class="btn btn-secondary btn-sm" type="button" data-action="hash" title="按路径与大小匹配种子内文件并计算 ED2K 链接">' + icon('refresh') + ' 计算匹配文件</button>';

    let totalMatched = 0;
    let totalEmbedded = 0;
    const cards = imports.map((entry, torrentIndex) => {
      const info = entry.info;
      const embedded = Array.isArray(info.embedded_links) ? info.embedded_links : [];
      const matchedCount = (info.matched_files || []).filter(item => item.file_id).length;
      const trackerCount = (info.trackers || []).length;
      const magnet = magnetForTorrent(info);
      totalMatched += matchedCount;
      totalEmbedded += embedded.length;
      return '<div class="torrent-result parse-result">' +
        '<div class="result-top">' +
          '<div class="result-head">' +
            '<span class="file-icon kind-video">' + icon('magnet') + '</span>' +
            '<div><strong>' + esc(info.name) + '</strong>' +
            '<span class="meta-chips">' + metaChips([info.file_count + ' 个文件', fmtSize(info.total_size)]) + '</span></div>' +
          '</div>' +
          '<div class="meta-row">' +
            '<div class="meta-item"><span class="meta-label">Info Hash</span><span class="meta-value" title="' + esc(info.info_hash) + '"><code>' + esc(info.info_hash) + '</code></span></div>' +
            '<div class="meta-item"><span class="meta-label">种子大小</span><span class="meta-value">' + fmtSize(info.torrent_size || 0) + '</span></div>' +
            '<div class="meta-item"><span class="meta-label">分块</span><span class="meta-value meta-chips">' + metaChips([fmtPiece(info.piece_length), info.piece_count + ' 块']) + '</span></div>' +
            '<div class="meta-item"><span class="meta-label">已匹配</span><span class="meta-value">' + matchedCount + ' / ' + info.file_count + '</span></div>' +
            '<div class="meta-item"><span class="meta-label">内嵌 ED2K</span><span class="meta-value">' + (embedded.length ? embedded.length + ' 条' : '无') + '</span></div>' +
            '<div class="meta-item"><span class="meta-label">Tracker</span><span class="meta-value">' + (trackerCount ? trackerCount + ' 个' : '未设置') + '</span></div>' +
          '</div>' +
        '</div>' +
        '<button class="link-chip magnet-chip" type="button" data-action="magnet" data-magnet="' + torrentIndex + '" title="复制磁力链"><code>' + esc(magnet) + '</code><span class="chip-action">复制磁力链</span></button>' +
        torrentTreeHtml(info.files, info.name) +
        (single ? '<div class="import-actions">' + qbButtons + hashButton + '</div>' : '') +
      '</div>';
    }).join('');

    const pushable = parsePushableItems();
    const pickHead = pushable.length
      ? '<div class="picker-head">' +
          '<span class="picker-hint">' + icon('cloud') + ' 可离线 ' + pushable.length + ' 条</span>' +
          '<span class="picker-actions">' +
            '<button class="mini-btn" type="button" data-action="parse-all" title="选中所有可推送的链接">全选可推送</button>' +
            '<button class="mini-btn" type="button" data-action="parse-none" title="清空当前选择">清空</button>' +
          '</span>' +
        '</div>'
      : '';
    container.innerHTML = cards +
      '<div class="picker parse-picker">' +
        pickHead +
        '<div class="picker-list parse-list">' +
          (rows || '<div class="picker-empty">种子里没有可显示的文件</div>') +
        '</div>' +
      '</div>' +
      (single ? '' : '<div class="import-actions">' + hashButton + '</div>') +
      '<p class="hint">已匹配 ' + totalMatched + ' / ' + totalFiles + ' 个文件。' +
        (totalEmbedded ? '种子里带有 ' + totalEmbedded + ' 条内嵌 ED2K 链接，已合并显示在列表中。' : '') +
        '未匹配的文件需要先添加对应文件并计算，才能得到 ED2K 链接。</p>';


    Array.from(container.querySelectorAll('details.torrent-tree')).forEach((node, index) => {
      if (openTrees[index]) node.open = true;
    });
    const nextList = $('.parse-list', container);
    if (nextList && listScroll) nextList.scrollTop = listScroll;
    if (pageScroll) window.scrollTo(0, pageScroll);
    ensureParseEd2k();
    maybeRematchParse();
  }

  let reparsing = false;
  let rematchTimer = null;

  function librarySig() {
    const files = moduleFiles('parse');
    return files.length + ':' + files.filter(file => file.complete).length;
  }


  function maybeRematchParse() {
    const imports = currentImports();
    if (!imports.length) return;
    const sig = librarySig();
    if (state.lastParseFileSig === sig) return;
    state.lastParseFileSig = sig;
    if (!imports.some(entry => entry.blob)) return;
    clearTimeout(rematchTimer);
    rematchTimer = setTimeout(runRematchParse, 900);
  }

  async function runRematchParse() {
    if (reparsing) return;
    const imports = currentImports();
    if (!imports.length) return;
    reparsing = true;
    try {
      const next = [];
      for (const entry of imports) {
        if (!entry.blob) {
          next.push(entry);
          continue;
        }
        try {
          const response = await fetch('/api/torrent/parse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-bittorrent' },
            body: await entry.blob.arrayBuffer()
          });
          if (response.ok) next.push({ info: await response.json(), blob: entry.blob });
          else next.push(entry);
        } catch (err) {
          next.push(entry);
        }
      }
      state.torrentImports = next;
      if (next.length) {
        state.torrentImport = next[next.length - 1].info;
        state.torrentImportFile = next[next.length - 1].blob;
      }
      state.torrentImportSig = '';
      renderTorrentImport(true);
    } finally {
      reparsing = false;
    }
  }

  let parseHashSig = '';


  function editorSelectedEntries() {
    return state.editorTorrents.filter(entry => state.editorSelected.has(entry.key));
  }

  async function loadEditorFiles(files) {
    const list = Array.from(files || []).filter(file => /\.torrent$/i.test(file.name));
    if (!list.length) {
      toast('请选择 .torrent 文件', 'warn');
      return;
    }
    const added = [];
    for (const file of list) {
      try {
        const buffer = await file.arrayBuffer();
        const response = await fetch('/api/torrent/parse?tree=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-bittorrent' },
          body: buffer
        });
        let info = null;
        try { info = await response.json(); } catch (err) { info = null; }
        if (!response.ok) throw new Error((info && info.error) || '解析失败');
        added.push({
          key: info.info_hash + ':' + Date.now() + ':' + Math.random().toString(16).slice(2),
          name: info.name,
          blob: file,
          info: info
        });
      } catch (err) {
        toast('无法载入 ' + file.name + '：' + err.message, 'error');
      }
    }
    if (!added.length) return;
    added.forEach(entry => {
      state.editorTorrents.push(entry);
      state.editorSelected.add(entry.key);
    });
    state.editorTreeSelected = null;
    state.editorTreeExpanded = new Set(['[]']);
    state.editorRawDirty = false;
    switchTab('edit');
    renderEditor();
    toast('已载入 ' + added.length + ' 个种子', 'ok');
  }

  function updateEditTrackerCount() {
    const pill = $('#editTrackerCount');
    if (!pill) return;
    const trackers = $('#editTrackers').value.split(/[\r\n,]+/).filter(item => item.trim());
    pill.textContent = trackers.length ? trackers.length + ' 个' : '未设置';
  }

  function editorEntry() {
    const selected = editorSelectedEntries();
    return selected.length === 1 ? selected[0] : null;
  }

  function treePathKey(path) {
    return JSON.stringify(path || []);
  }

  function treeNodeType(node) {
    if (Array.isArray(node)) return 'list';
    if (node && typeof node === 'object') {
      if (Object.keys(node).length === 1 && Object.prototype.hasOwnProperty.call(node, '$b64')) return 'binary';
      return 'dict';
    }
    if (typeof node === 'number') return 'int';
    return 'string';
  }

  function treeNodeAt(entry, path) {
    let node = entry && entry.info ? entry.info.tree : null;
    for (const key of path || []) {
      if (node === null || node === undefined) return undefined;
      node = node[key];
    }
    return node;
  }

  function editTabsDisabled(batch) {
    $$('.edit-tab').forEach(button => {
      button.disabled = batch && button.dataset.editTab !== 'summary';
    });
  }

  function applyEditorTab() {
    if (state.editorTab !== 'summary' && editorSelectedEntries().length > 1) state.editorTab = 'summary';
    $$('.edit-tab').forEach(button => {
      const active = button.dataset.editTab === state.editorTab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $$('.edit-panel').forEach(panel => {
      panel.hidden = panel.dataset.editPanel !== state.editorTab;
    });
    if (state.editorTab === 'files') renderEditorFiles();
    else if (state.editorTab === 'tree') renderEditorTree();
    else if (state.editorTab === 'raw') renderEditorRaw();
  }

  function renderEditorMeta(entry) {
    const info = entry && entry.info ? entry.info : {};
    $('#editPieceLength').textContent = fmtPiece(info.piece_length);
    $('#editPieceCount').textContent = info.piece_count ? String(info.piece_count) : '—';
    $('#editTotalSize').textContent = fmtSize(info.total_size || 0);
    $('#editFileCount').textContent = (info.file_count || 0) + ' 个';
    $('#editInfoHash').textContent = info.info_hash || '—';
    $('#editCreatedBy').textContent = info.created_by || '—';
  }

  function renderEditorFiles() {
    const entry = editorEntry();
    const body = $('#editFilesBody');
    if (!body) return;
    if (!entry) {
      body.innerHTML = '';
      return;
    }
    const files = Array.isArray(entry.info.files) ? entry.info.files : [];
    const pieceLength = Number(entry.info.piece_length) || 0;
    let offset = 0;
    body.innerHTML = files.map((file, index) => {
      const size = Number(file.size) || 0;
      let pieces = 1;
      if (pieceLength > 0 && size > 0) {
        pieces = Math.floor((offset + size - 1) / pieceLength) - Math.floor(offset / pieceLength) + 1;
      }
      offset += size;
      return '<tr>' +
        '<td class="idx">' + (index + 1) + '</td>' +
        '<td><input class="path-input" data-edit-path="' + index + '" value="' + esc(file.path || '') + '" title="可修改文件路径；修改会改变 Info Hash"></td>' +
        '<td class="size">' + fmtSize(size) + '</td>' +
        '<td class="pieces">' + pieces + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="4">种子里没有文件</td></tr>';
    $('#editPieceLengthInput').value = fmtPiece(entry.info.piece_length);
    $('#editTotalSizeInput').value = fmtSize(entry.info.total_size || 0);
    $('#editRootName').value = entry.info.name || '';
  }

  function flattenEditorTree(node, key, path, depth, parentType, out) {
    const type = treeNodeType(node);
    out.push({ path: path, key: key, depth: depth, type: type, parentType: parentType });
    if ((type === 'dict' || type === 'list') && state.editorTreeExpanded.has(treePathKey(path))) {
      if (type === 'dict') {
        Object.keys(node).forEach(child => flattenEditorTree(node[child], child, path.concat(child), depth + 1, 'dict', out));
      } else {
        node.forEach((child, index) => flattenEditorTree(child, index, path.concat(index), depth + 1, 'list', out));
      }
    }
    return out;
  }

  const TREE_TYPE_LABEL = { dict: '字典', list: '列表', int: '整数', string: '字符串', binary: '二进制' };

  function renderEditorTree() {
    const container = $('#editTree');
    const entry = editorEntry();
    if (!container) return;
    if (!entry || !entry.info || !entry.info.tree) {
      container.innerHTML = '<div class="picker-empty">暂无树形数据</div>';
      state.editorTreeRows = [];
      return;
    }
    const rows = flattenEditorTree(entry.info.tree, 'root', [], 0, null, []);
    state.editorTreeRows = rows;
    const selectedKey = state.editorTreeSelected ? treePathKey(state.editorTreeSelected) : '';
    container.innerHTML = rows.map((row, index) => {
      const node = treeNodeAt(entry, row.path);
      const expanded = state.editorTreeExpanded.has(treePathKey(row.path));
      const toggle = (row.type === 'dict' || row.type === 'list')
        ? '<button class="tree-toggle' + (expanded ? ' is-expanded' : '') + '" type="button" data-tree-toggle="' + index + '" title="展开 / 收起">' + icon('chevron') + '</button>'
        : '<span class="tree-toggle" style="visibility:hidden"></span>';
      let keyEl;
      if (!row.path.length) {
        keyEl = '<span class="edit-tree-key root">root</span>';
      } else if (row.parentType === 'dict') {
        keyEl = '<input class="edit-tree-key" data-tree-key="' + index + '" value="' + esc(row.key) + '" title="可修改键名">';
      } else {
        keyEl = '<span class="edit-tree-key">' + esc(String(row.key)) + '</span>';
      }
      let valueEl;
      if (row.type === 'dict' || row.type === 'list') {
        const count = row.type === 'dict' ? Object.keys(node).length : node.length;
        valueEl = '<span class="edit-tree-value binary">' + count + ' 项</span>';
      } else if (row.type === 'binary') {
        const raw = node && typeof node === 'object' ? String(node.$b64 || '') : '';
        const bytes = Math.floor(raw.length * 3 / 4);
        valueEl = '<span class="edit-tree-value binary">[二进制 ' + bytes + ' 字节]</span>';
      } else {
        valueEl = '<input class="edit-tree-value" data-tree-value="' + index + '" value="' + esc(String(node === undefined ? '' : node)) + '" title="可修改值">';
      }
      const remove = row.path.length
        ? '<button class="edit-tree-del" type="button" data-tree-del="' + index + '" title="删除该节点">' + icon('trash') + '</button>'
        : '';
      return '<div class="edit-tree-row' + (selectedKey === treePathKey(row.path) ? ' is-selected' : '') + '" data-tree-row="' + index + '" style="padding-left:' + (10 + row.depth * 18) + 'px">' +
        toggle + keyEl +
        '<span class="edit-tree-type">' + TREE_TYPE_LABEL[row.type] + '</span>' + valueEl + remove +
      '</div>';
    }).join('') || '<div class="picker-empty">树中没有内容</div>';
  }

  function updateRawGutter() {
    const textarea = $('#editRawText');
    const gutter = $('#editRawGutter');
    if (!textarea || !gutter) return;
    const lines = textarea.value.split('\n').length;
    let text = '';
    for (let i = 1; i <= lines; i += 1) text += i + '\n';
    gutter.textContent = text;
  }

  function renderEditorRaw() {
    const entry = editorEntry();
    const textarea = $('#editRawText');
    if (!textarea) return;
    const key = entry ? entry.key : '';
    if (state.editorRawKey !== key) {
      state.editorRawKey = key;
      state.editorRawDirty = false;
      textarea.value = entry && entry.info.tree ? JSON.stringify(entry.info.tree, null, 2) : '';
    }
    updateRawGutter();
  }

  function commitRawIfNeeded() {
    if (!state.editorRawDirty) return true;
    const entry = editorEntry();
    if (!entry) return true;
    let parsed;
    try {
      parsed = JSON.parse($('#editRawText').value);
    } catch (err) {
      toast('原始数据不是有效的 JSON：' + err.message, 'error');
      return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      toast('原始数据的根节点必须是字典', 'error');
      return false;
    }
    entry.info.tree = parsed;
    state.editorRawDirty = false;
    return true;
  }

  function switchEditorTab(tab) {
    if (tab !== 'raw' && state.editorTab === 'raw' && state.editorRawDirty && !commitRawIfNeeded()) return;
    if (tab === 'raw') {
      state.editorRawKey = '';
      state.editorRawDirty = false;
    }
    state.editorTab = tab;
    applyEditorTab();
  }

  function syncEditorForm() {
    const card = $('#editFormCard');
    const selected = editorSelectedEntries();
    card.hidden = selected.length === 0;
    if (!selected.length) return;
    const batch = selected.length > 1;
    ['#editName', '#editComment', '#editSource', '#editPrivate'].forEach(selector => {
      $(selector).disabled = batch;
    });
    editTabsDisabled(batch);
    if (batch) state.editorTab = 'summary';
    $('#editModePill').textContent = batch ? '批量修改 ' + selected.length + ' 个种子' : '单个种子';
    $('#editTrackers').placeholder = batch
      ? '批量编辑：每行一个 Tracker，将覆盖所选 ' + selected.length + ' 个种子的 Tracker'
      : '每行一个 Tracker';
    if (batch) {
      $('#editName').value = '';
      $('#editComment').value = '';
      $('#editSource').value = '';
      $('#editPrivate').checked = false;
      $('#editTrackers').value = '';
      $('#editHashText').textContent = '将批量修改 ' + selected.length + ' 个种子的 Tracker（不影响 Info Hash）';
      $('#editHashWarning').hidden = true;
      $('#editTrackerHint').textContent = '每行一个；会覆盖所选种子的全部 Tracker';
    } else {
      const entry = selected[0];
      if (state.editorEntryKey !== entry.key) {
        state.editorEntryKey = entry.key;
        state.editorTreeSelected = null;
        state.editorTreeExpanded = new Set(['[]']);
      }
      $('#editName').value = entry.info.name || '';
      $('#editComment').value = entry.info.comment || '';
      $('#editSource').value = entry.info.source || '';
      $('#editPrivate').checked = !!entry.info.private;
      $('#editTrackers').value = (entry.info.trackers || []).join('\n');
      $('#editHashText').textContent = 'Info Hash：' + (entry.info.info_hash || '—');
      $('#editHashWarning').hidden = false;
      $('#editTrackerHint').textContent = '每行一个 Tracker';
      renderEditorMeta(entry);
    }
    applyEditorTab();
    updateEditTrackerCount();
  }

  function renderEditor() {
    const listEl = $('#editList');
    const countPill = $('#editCountPill');
    if (!listEl) return;
    const entries = state.editorTorrents;
    if (countPill) countPill.textContent = entries.length + ' 个';
    const hint = $('#editListHint');
    if (hint) {
      hint.textContent = entries.length
        ? '勾选需要编辑的种子；选中 1 个可完整编辑，多个仅批量改 Tracker'
        : '尚未载入种子，点击「选择种子」载入 .torrent 文件';
    }
    listEl.innerHTML = entries.map(entry => {
      const picked = state.editorSelected.has(entry.key);
      const kind = fileKind(entry.name);
      const trackerCount = (entry.info.trackers || []).length;
      return '<div class="picker-row' + (picked ? ' is-selected' : '') + '" data-edit-key="' + esc(entry.key) + '">' +
        '<label class="checkbox' + (picked ? ' is-checked' : '') + '" title="选择该种子进行编辑"><input type="checkbox" data-edit-pick="' + esc(entry.key) + '"' + (picked ? ' checked' : '') + '><span class="box">' + icon('check') + '</span></label>' +
        '<span class="file-icon ' + kind.cls + '">' + icon(kind.icon) + '</span>' +
        '<span class="picker-body"><strong>' + esc(entry.name) + '</strong>' +
          '<small class="meta-chips">' + metaChips([
            entry.info.file_count + ' 个文件',
            fmtSize(entry.info.total_size),
            trackerCount ? trackerCount + ' 个 Tracker' : '无 Tracker'
          ]) + '</small>' +
          '<code class="picker-link" title="Info Hash：' + esc(entry.info.info_hash) + '">' + esc(entry.info.info_hash) + '</code>' +
        '</span>' +
        '<button class="mini-copy" type="button" data-edit-remove="' + esc(entry.key) + '" title="移除该种子" aria-label="移除该种子">' + icon('trash') + '</button>' +
      '</div>';
    }).join('') || '<div class="picker-empty">尚未载入种子</div>';
    syncEditorForm();
    updateSelectionBar();
  }

  async function saveEditedTorrents() {
    const selected = editorSelectedEntries();
    if (!selected.length) {
      toast('请先勾选要编辑的种子', 'warn');
      return;
    }
    const batch = selected.length > 1;
    const text = $('#editTrackers').value;
    const trackers = text.split(/[\r\n,]+/).map(item => item.trim()).filter(Boolean);
    const button = $('#editSaveBtn');
    button.disabled = true;
    button.textContent = '正在保存…';
    try {
      const items = [];
      for (const entry of selected) {
        items.push({ name: entry.name, data: await blobToBase64(entry.blob) });
      }
      const payload = { items: items, trackers: trackers };
      if (batch) {
        payload.batch = true;
      } else {
        if (!commitRawIfNeeded()) {
          button.disabled = false;
          button.innerHTML = icon('download') + ' 保存并下载';
          return;
        }
        const entry = selected[0];
        if (state.editorTab === 'tree' || state.editorTab === 'raw') {
          payload.tree = entry.info.tree;
        } else {
          payload.name = $('#editName').value.trim();
          payload.comment = $('#editComment').value.trim();
          payload.source = $('#editSource').value.trim();
          payload.private = $('#editPrivate').checked;
          const files = Array.isArray(entry.info.files) ? entry.info.files : [];
          const hasFileList = !!(entry.info.tree && entry.info.tree.info && Array.isArray(entry.info.tree.info.files));
          if (hasFileList) payload.files = files.map(item => item.path || '');
        }
      }
      const response = await fetch('/api/torrent/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        let data = null;
        try { data = await response.json(); } catch (err) { data = null; }
        throw new Error((data && data.error) || '保存失败');
      }
      const blob = await response.blob();
      if (batch) {
        downloadBlob(blob, 'edited-torrents.zip');
        toast('已导出 ' + selected.length + ' 个编辑后的种子（ZIP）', 'ok');
      } else {
        const entry = selected[0];
        const buffer = await blob.arrayBuffer();
        let refreshed = null;
        try {
          const parseResponse = await fetch('/api/torrent/parse?tree=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-bittorrent' },
            body: buffer
          });
          if (parseResponse.ok) refreshed = await parseResponse.json();
        } catch (err) { refreshed = null; }
        const filename = ((refreshed && refreshed.name) || payload.name || entry.name || 'torrent')
          .replace(/[\\/:*?"<>|]/g, '_') + '.torrent';
        downloadBlob(new Blob([buffer], { type: 'application/x-bittorrent' }), filename);
        entry.blob = new Blob([buffer], { type: 'application/x-bittorrent' });
        if (refreshed) {
          entry.info = refreshed;
          entry.name = refreshed.name || entry.name;
        }
        state.editorRawKey = '';
        state.editorEntryKey = entry.key;
        renderEditor();
        toast('已保存并下载编辑后的种子', 'ok');
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
      button.innerHTML = icon('download') + ' 保存并下载';
    }
  }


  function ensureParseEd2k() {
    const imports = currentImports();
    if (!imports.length) return;
    const ids = [];
    imports.forEach(entry => {
      (entry.info.matched_files || []).forEach(item => {
        if (!item.file_id || ids.indexOf(item.file_id) >= 0) return;
        const file = findFile(item.file_id);
        if (!file || !file.complete) return;
        const status = file.ed2k && file.ed2k.status;
        if (status === 'done' || status === 'queued' || status === 'running' || status === 'error') return;
        ids.push(item.file_id);
      });
    });
    if (!ids.length) return;
    const sig = imports.map(entry => entry.info.info_hash).join('|') + ':' + ids.join(',');
    if (sig === parseHashSig) return;
    parseHashSig = sig;
    api('/api/ed2k/hash', { method: 'POST', body: { ids: ids } })
      .then(() => schedulePoll(300))
      .catch(() => { parseHashSig = ''; });
  }

  async function hashMatchedFiles() {
    const ids = [];
    const seen = new Set();
    currentImports().forEach(entry => {
      (entry.info.matched_files || []).forEach(item => {
        if (!item.file_id || seen.has(item.file_id)) return;
        const file = findFile(item.file_id);
        if (!file || !file.complete) return;
        if (file.ed2k && ['done', 'running', 'queued'].indexOf(file.ed2k.status) >= 0) return;
        seen.add(item.file_id);
        ids.push(item.file_id);
      });
    });
    if (!ids.length) {
      toast('没有需要计算的匹配文件', 'warn');
      return;
    }
    try {
      await api('/api/ed2k/hash', { method: 'POST', body: { ids: ids } });
      toast('已开始计算 ' + ids.length + ' 个匹配文件', 'info');
      schedulePoll(300);
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function parseTorrentFile(file, silent) {
    if (!file) return false;
    if (!/\.torrent$/i.test(file.name)) {
      if (!silent) toast('请选择 .torrent 文件', 'warn');
      return false;
    }
    if (file.size > 64 * 1024 * 1024) {
      if (!silent) toast('种子文件过大', 'error');
      return false;
    }
    if (!silent) toast('正在解析种子…', 'info');
    try {
      const buffer = await file.arrayBuffer();
      const response = await fetch('/api/torrent/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-bittorrent' },
        body: buffer
      });
      let data = null;
      try { data = await response.json(); } catch (err) { data = null; }
      if (!response.ok) throw new Error((data && data.error) || '种子解析失败');
      if (!Array.isArray(state.torrentImports)) state.torrentImports = [];
      state.torrentImports.push({ info: data, blob: file });
      state.torrentImport = data;
      state.torrentImportFile = file;
      state.parseSelected = new Set();
      state.torrentImportSig = '';
      state.lastParseFileSig = librarySig();
      switchTab('parse');
      renderTorrentImport(true);
      if (!silent) toast('已解析：' + data.name + '（' + data.file_count + ' 个文件）', 'ok');
      return true;
    } catch (err) {
      if (!silent) toast('解析失败：' + err.message, 'error');
      return false;
    }
  }

  async function parseTorrentFiles(files) {
    const list = Array.from(files || []).filter(file => /\.torrent$/i.test(file.name));
    if (!list.length) {
      toast('请选择 .torrent 文件', 'warn');
      return;
    }
    state.torrentImports = [];
    state.torrentImport = null;
    state.torrentImportFile = null;
    state.parseSelected = new Set();
    state.torrentImportSig = '';
    toast('正在解析 ' + list.length + ' 个种子…', 'info');
    for (const file of list) await parseTorrentFile(file, true);
    const count = state.torrentImports.length;
    if (!count) {
      toast('种子解析失败', 'error');
      return;
    }
    switchTab('parse');
    renderTorrentImport(true);
    toast('已解析 ' + count + ' 个种子', 'ok');
  }

  async function generateTorrent() {
    const ids = Array.from(state.torrentSelected).filter(id => {
      const file = findFile(id);
      return file && file.complete;
    });
    if (!ids.length) {
      toast('请选择至少一个已上传完成的文件', 'warn');
      return;
    }
    saveTorrentOptions();
    const piece = pieceSizeValue();
    if (Number.isNaN(piece)) {
      toast('分块大小无效，请重新选择固定档位', 'warn');
      return;
    }
    const trackersText = $('#torrentTrackers').value.trim();
    const payload = {
      ids: ids,
      name: $('#torrentName').value.trim(),
      trackers: trackersText ? trackersText.split(/[\r\n,]+/).map(item => item.trim()).filter(Boolean) : [],
      piece_size: piece,
      private: $('#torrentPrivate').checked,
      embed_ed2k: $('#torrentEmbedEd2k').checked,
      comment: $('#torrentComment').value.trim()
    };

    try {
      const result = await api('/api/torrent/create', { method: 'POST', body: payload });
      state.torrentJobId = result.job_id;
      state.lastJobStatus = '';
      state.torrentJobSig = '';
      localStorage.setItem(LS.lastJob, result.job_id);
      savePrefs({ last_torrent_job: result.job_id });
      await refresh();
      renderTorrentJob();
      schedulePoll(300);
      toast('已开始生成种子', 'info');
    } catch (err) {
      toast('生成失败：' + err.message, 'error');
    }
  }

  function pieceOptionBytes(value) {
    if (value === null || value === undefined || value === '') return 0;
    const text = String(value);
    return /^[0-9]+$/.test(text) ? Number(text) : legacyPieceBytes(text);
  }


  function applyTorrentOptions(options) {
    if (!options) {
      setPieceSize(0);
      $('#torrentEmbedEd2k').checked = true;
      return;
    }
    if (typeof options.trackers === 'string') $('#torrentTrackers').value = options.trackers;
    const bytes = pieceOptionBytes(options.piece);
    setPieceSize(Number.isFinite(bytes) ? bytes : 0);
    $('#torrentPrivate').checked = !!options.private;
    const embed = options.embed_ed2k !== undefined ? options.embed_ed2k : options.embedEd2k;
    $('#torrentEmbedEd2k').checked = embed !== false;
  }

  function torrentOptionsPayload() {
    return {
      trackers: $('#torrentTrackers').value,
      piece: Number($('#torrentPiece').value) || 0,
      private: $('#torrentPrivate').checked,
      embed_ed2k: $('#torrentEmbedEd2k').checked
    };
  }

  function localTorrentOptions() {
    const value = torrentOptionsPayload();
    return {
      trackers: value.trackers,
      piece: String(value.piece),
      private: value.private,
      embedEd2k: value.embed_ed2k
    };
  }

  let torrentOptionsTimer = null;
  function syncTorrentOptions() {
    api('/api/torrent/options', { method: 'POST', body: { options: torrentOptionsPayload() } })
      .catch(() => { });
  }

  async function loadTorrentOptions() {

    const local = loadJSON(LS.torrentOpts, null);
    applyTorrentOptions(local);
    updateTrackerSummary();
    try {
      const data = await api('/api/torrent/options');
      if (!data || !data.options) return;
      applyTorrentOptions(data.options);
      updateTrackerSummary();
      if (data.stored) {
        saveJSON(LS.torrentOpts, localTorrentOptions());
      } else if (local) {

        syncTorrentOptions();
      }
    } catch (err) {

    }
  }

  function saveTorrentOptions() {
    saveJSON(LS.torrentOpts, localTorrentOptions());
    updateTrackerSummary();
    clearTimeout(torrentOptionsTimer);
    torrentOptionsTimer = setTimeout(syncTorrentOptions, 400);
  }


  let prefsPatch = {};
  let prefsTimer = null;

  function savePrefs(patch) {
    Object.assign(prefsPatch, patch);
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => {
      const body = { prefs: prefsPatch };
      prefsPatch = {};
      api('/api/prefs', { method: 'POST', body }).catch(() => { });
    }, 400);
  }

  async function loadPrefs() {
    let data = null;
    try {
      data = await api('/api/prefs');
    } catch (err) {
      return;
    }
    if (!data || !data.prefs) return;
    const prefs = data.prefs;
    if (data.stored) {
      applyTheme(prefs.theme || 'system', true);
      if (typeof prefs.browse_dir === 'string') saveJSON(LS.browseDir, prefs.browse_dir);
      const jobId = prefs.last_torrent_job || '';
      if (jobId !== state.torrentJobId) {
        state.torrentJobId = jobId;
        state.torrentJobSig = '';
        try {
          if (jobId) localStorage.setItem(LS.lastJob, jobId);
          else localStorage.removeItem(LS.lastJob);
        } catch (err) { }
        refresh().catch(() => { });
      }
      if (Array.isArray(prefs.imported)) {
        state.imported = prefs.imported.map(item => ({
          name: item.name, size: item.size, hash: item.hash, link: item.link
        }));
        saveJSON(LS.imported, state.imported);
        state.lastImportedSig = '';
        renderImported();
        updateSelectionUI();
      }
      return;
    }

    savePrefs({
      theme: themeMode(),
      browse_dir: loadJSON(LS.browseDir, ''),
      last_torrent_job: state.torrentJobId || '',
      imported: state.imported
    });
  }

  function trackerEntries() {
    return $('#torrentTrackers').value
      .split(/[\r\n,]+/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  function updateTrackerSummary() {
    const badge = $('#trackerCount');
    if (!badge) return;
    const count = trackerEntries().length;
    badge.textContent = count ? count + ' 个' : '未设置';
  }

  async function fetchPublicTrackers(options) {
    options = options || {};
    if (state.trackerLoading) return;
    state.trackerLoading = true;
    const button = $('#fetchTrackersBtn');
    const status = $('#trackerStatus');
    if (button) {
      button.disabled = true;
      button.textContent = '获取中…';
    }
    if (status) status.textContent = '正在获取公共 Tracker 列表…';
    try {
      const data = await api('/api/trackers' + (options.force ? '?refresh=1' : ''));
      const incoming = Array.isArray(data.trackers) ? data.trackers : [];
      if (!incoming.length) throw new Error('列表为空');
      const current = trackerEntries();
      const seen = new Set(current);
      const merged = current.slice();
      incoming.forEach(tracker => {
        if (!seen.has(tracker)) {
          seen.add(tracker);
          merged.push(tracker);
        }
      });
      $('#torrentTrackers').value = merged.join('\n');
      saveTorrentOptions();
      scheduleEstimate();
      const added = merged.length - current.length;
      const when = data.updated
        ? new Date(data.updated * 1000).toLocaleString('zh-CN', { hour12: false })
        : '';
      if (status) {
        status.textContent = '公共 Tracker ' + incoming.length + ' 个' +
          (data.stale ? '（缓存，更新失败）' : '') +
          (when ? ' · 更新于 ' + when : '') +
          (added ? ' · 新增 ' + added : ' · 已是最新');
      }
      if (!options.silent) {
        toast(added ? '已填入 ' + added + ' 个公共 Tracker' : '公共 Tracker 已是最新', added ? 'ok' : 'info');
        if (data.warning) toast(data.warning, 'warn');
      }
    } catch (err) {
      if (status) status.textContent = '获取公共 Tracker 失败：' + err.message;
      if (!options.silent) toast('获取公共 Tracker 失败：' + err.message, 'error');
    } finally {
      state.trackerLoading = false;
      if (button) {
        button.disabled = false;
        button.textContent = '更新 Tracker';
      }
    }
  }

  function maybeAutoLoadTrackers() {
    if (state.trackerAutoLoaded) return;
    if ($('#torrentPrivate').checked) return;
    state.trackerAutoLoaded = true;
    fetchPublicTrackers({ silent: true });
  }


  function switchTab(tab) {
    state.tab = tab;
    $$('.seg-btn').forEach(button => {
      const active = button.dataset.tab === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('#view-ed2k').hidden = tab !== 'ed2k';
    $('#view-make').hidden = tab !== 'make';
    $('#view-parse').hidden = tab !== 'parse';
    $('#view-edit').hidden = tab !== 'edit';
    if (tab === 'make') {
      state.pickerSig = '';
      renderTorrentPicker();
      renderTorrentJob();
      maybeAutoLoadTrackers();
    } else if (tab === 'parse') {
      renderTorrentImport(true);
    } else if (tab === 'edit') {
      renderEditor(true);
    }
    updateSelectionUI();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function modalOpen() {
    return $('#modalRoot').children.length > 0;
  }

  function closeModal() {
    const root = $('#modalRoot');
    if (!root.children.length) return;
    root.innerHTML = '';
    document.body.classList.remove('modal-open');
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (err) { }
    }
    lastFocus = null;
  }

  function openModal(html, onReady, className) {
    closeModal();
    lastFocus = document.activeElement;
    const root = $('#modalRoot');
    root.innerHTML = '<div class="modal-backdrop"><div class="modal' +
      (className ? ' ' + className : '') +
      '" role="dialog" aria-modal="true">' + html + '</div></div>';
    const backdrop = root.firstElementChild;
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => backdrop.classList.add('is-open'));
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop || event.target.closest('[data-act="close"]')) closeModal();
    });
    setTimeout(() => {
      const target = root.querySelector('textarea') || root.querySelector('input') || root.querySelector('button');
      if (target) target.focus();
    }, 80);
    if (onReady) onReady(root);
  }

  async function loadIntegrations() {
    try {
      const data = await api('/api/integrations');
      state.integrations = {
        qb_servers: Array.isArray(data.qb_servers) ? data.qb_servers : [],
        offline115: data.offline115 || {}
      };
    } catch (err) {
      state.integrations = { qb_servers: [], offline115: {} };
    }
    state.torrentJobSig = '';
    state.torrentImportSig = '';
    renderTorrentJob();
    renderTorrentImport();
    updateSelectionUI();
  }

  function cookieStatusText(offline) {
    if (offline.cookie_locked) return '已加密保存（已锁定），输入密码解锁后才会用于推送';
    if (offline.cookie_encrypted) return '已加密（已解锁，' + offline.cookie_length + ' 字符）';
    if (offline.has_cookie) return '未加密（' + offline.cookie_length + ' 字符），建议设置加密密码';
    return '未设置';
  }

  function qbServerRowHtml(server, index) {
    const passwordHint = server.has_password ? '已设置，留空保持不变' : '未设置';
    return '<div class="qb-server">' +
      '<div class="qb-server-head">' +
        '<input class="qb-server-name" type="text" data-server-index="' + index + '" data-key="name" value="' + esc(server.name || '') + '" placeholder="服务器名称，如 qb下载 / qb做种" maxlength="24" autocomplete="off" title="服务器名称，会显示在种子结果的推送按钮上">' +
        '<button class="mini-btn" type="button" data-test-server="' + index + '" title="测试与 qBittorrent 的连接">测试</button>' +
        '<button class="mini-btn danger" type="button" data-remove-server="' + index + '" title="删除该服务器">删除</button>' +
      '</div>' +
      '<label class="field"><span>qBittorrent 地址</span>' +
        '<input type="text" data-server-index="' + index + '" data-key="url" value="' + esc(server.url || '') + '" placeholder="http://192.168.1.10:8080" autocomplete="off" title="qBittorrent WebUI 地址，例如 http://192.168.1.10:8080"></label>' +
      '<div class="form-row">' +
        '<label class="field"><span>用户名</span>' +
          '<input type="text" data-server-index="' + index + '" data-key="username" value="' + esc(server.username || '') + '" autocomplete="off" title="qBittorrent 登录用户名"></label>' +
        '<label class="field"><span>密码</span>' +
          '<input type="password" data-server-index="' + index + '" data-key="password" value="' + esc(server.password || '') + '" placeholder="' + passwordHint + '" autocomplete="new-password" title="' + passwordHint + '；输入新密码可替换"></label>' +
      '</div>' +
      '<label class="field"><span>qBittorrent 保存路径（qB 所在机器）</span>' +
        '<input type="text" data-server-index="' + index + '" data-key="remote_prefix" value="' + esc(server.remote_prefix || '') + '" placeholder="例如 D:\\Documents\\Downloads" autocomplete="off" title="qB 所在机器上的保存路径，例如 D:\\Documents\\Downloads"></label>' +
      '<details class="advanced-mapping">' +
        '<summary title="仅当工具能直接读取 NAS 上的源文件时填写，用于按子目录自动换算保存路径">高级：本工具路径前缀（可选）</summary>' +
        '<label class="field"><span>本工具路径前缀（NAS/容器内）</span>' +
          '<input type="text" data-server-index="' + index + '" data-key="local_prefix" value="' + esc(server.local_prefix || '') + '" placeholder="例如 /downloads" autocomplete="off" title="仅当工具能直接读取 NAS 上的源文件时填写，用于按子目录自动换算保存路径；留空时直接使用上面的 qB 保存路径"></label>' +
      '</details>' +
    '</div>';
  }

  async function openIntegrations() {
    let data;
    try {
      data = await api('/api/integrations');
    } catch (err) {
      toast('读取设置失败：' + err.message, 'error');
      return;
    }
    const offline = data.offline115 || {};
    const trackerText = $('#torrentTrackers').value;
    const servers = (Array.isArray(data.qb_servers) ? data.qb_servers : []).map(server => ({
      id: server.id || '',
      name: server.name || 'qB',
      url: server.url || '',
      username: server.username || '',
      has_password: !!server.has_password,
      password: '',
      local_prefix: server.local_prefix || '',
      remote_prefix: server.remote_prefix || ''
    }));

    const trackersSection =
      '<section class="settings-section">' +
        '<div class="settings-title">' +
          '<div class="settings-title-text"><h3 title="生成种子时写入的 announce 列表，每行一个，支持 udp:// 与 http(s)://">Tracker 服务器</h3></div>' +
          '<span class="settings-actions">' +
            '<button class="mini-btn" type="button" id="cfgFetchTrackers" title="从 trackerslist.com 获取公共 Tracker 并合并到列表">获取公共</button>' +
            '<button class="mini-btn" type="button" id="cfgClearTrackers" title="清空 Tracker 列表">清空</button>' +
          '</span>' +
        '</div>' +
        '<textarea id="cfgTrackers" rows="4" spellcheck="false" title="每行一个 Tracker，支持 udp:// 与 http(s)://，保存后立即生效" placeholder="udp://tracker.opentrackr.org:1337/announce&#10;https://tracker.example.com/announce">' + esc(trackerText) + '</textarea>' +
      '</section>';

    openModal(
      '<div class="settings-head">' +
        '<div class="settings-heading">' +
          '<span class="settings-kicker">LINKSEED · 链种工坊</span>' +
          '<h2 title="Tracker、做种服务器与 115 离线，集中在这里管理">设置</h2>' +
        '</div>' +
        '<button class="icon-btn settings-close" type="button" data-act="close" aria-label="关闭" title="关闭设置">' + icon('x') + '</button>' +
      '</div>' +
      '<div class="settings-body">' +
        trackersSection +
        '<section class="settings-section">' +
          '<div class="settings-title">' +
            '<div class="settings-title-text"><h3 title="可添加多台，按名称区分推送目标；保存路径填 qB 所在机器上的路径">qBittorrent 做种服务器</h3></div>' +
            '<button class="mini-btn" type="button" id="cfgAddServer" title="添加一台 qBittorrent 服务器">添加服务器</button>' +
          '</div>' +
          '<div class="qb-server-list" id="cfgServerList"></div>' +
        '</section>' +
        '<section class="settings-section">' +
          '<div class="settings-title">' +
            '<div class="settings-title-text"><h3 title="用于 115 离线推送；Cookie 会加密保存，查看需输入加密密码">115 离线</h3></div>' +
            '<span class="settings-actions">' +
              (offline.has_cookie ? '<button class="mini-btn" type="button" id="cfg115RevealBtn" title="输入加密密码后查看已保存的 Cookie">查看 Cookie</button>' : '') +
              (offline.cookie_locked ? '<button class="mini-btn" type="button" id="cfg115UnlockBtn" title="输入加密密码解锁，本次运行期间有效">解锁</button>' : '') +
            '</span>' +
          '</div>' +
          '<label class="field"><span>Cookie</span>' +
            '<textarea id="cfg115Cookie" rows="3" title="' + esc(cookieStatusText(offline)) + '；已保存的 Cookie 不会在这里显示，粘贴新 Cookie 可替换" placeholder="' +
              (offline.has_cookie ? '已加密保存，不会在这里显示；粘贴新 Cookie 可替换' : 'UID=...; CID=...; SEID=...; KID=...') +
            '" spellcheck="false"></textarea></label>' +
          '<label class="field"><span>加密密码</span>' +
            '<input type="password" id="cfg115Pass" placeholder="' +
              (offline.cookie_locked ? '输入加密密码解锁' : '设置加密密码（至少 8 位）') +
            '" autocomplete="new-password" title="' +
              (offline.cookie_encrypted ? '输入密码可解锁或更换加密密码' : '至少 8 位') +
              ((offline.has_cookie && !offline.cookie_encrypted) ? '；当前 Cookie 未加密，建议填写密码后保存' : '') +
            '"></label>' +
          '<div class="cookie-reveal" id="cfg115Reveal" hidden>' +
            '<label class="field"><span>已保存的 Cookie</span>' +
              '<textarea id="cfg115RevealValue" rows="3" readonly spellcheck="false" title="仅本次显示，请勿泄露"></textarea></label>' +
            '<button class="mini-btn" type="button" id="cfg115RevealCopy" title="复制已显示的 Cookie">复制 Cookie</button>' +
          '</div>' +
          '<label class="field"><span>离线保存目录 CID</span>' +
            '<input type="text" id="cfg115Cid" value="' + esc(offline.save_cid || '') + '" placeholder="可选，例如 0" autocomplete="off" title="可选，留空使用默认云下载目录"></label>' +
        '</section>' +
      '</div>' +
      '<div class="settings-foot">' +
        '<button class="btn btn-ghost" type="button" data-act="close" title="取消并关闭">取消</button>' +
        '<button class="btn btn-primary" type="button" id="saveIntegrationsBtn" title="保存全部设置并立即生效">保存设置</button>' +
      '</div>',
      root => {
        const list = $('#cfgServerList', root);
        const trackerArea = $('#cfgTrackers', root);
        const MAX_SERVERS = 10;

        function renderServers() {
          if (!servers.length) {
            list.innerHTML = '<p class="qb-server-empty">还没有 qBittorrent 服务器，点击「添加服务器」开始配置。</p>';
            return;
          }
          list.innerHTML = servers.map((server, index) => qbServerRowHtml(server, index)).join('');
        }

        function collectServers() {
          Array.from(list.querySelectorAll('[data-server-index]')).forEach(input => {
            const index = Number(input.dataset.serverIndex);
            if (servers[index]) servers[index][input.dataset.key] = input.value;
          });
        }

        renderServers();

        list.addEventListener('click', async event => {
          const testButton = event.target.closest('[data-test-server]');
          if (testButton) {
            collectServers();
            const server = servers[Number(testButton.dataset.testServer)];
            if (!server) return;
            testButton.disabled = true;
            testButton.textContent = '测试中…';
            try {
              const result = await api('/api/qb/test', {
                method: 'POST',
                body: {
                  server_id: server.id || '',
                  server: {
                    url: server.url,
                    username: server.username,
                    password: server.password,
                    local_prefix: server.local_prefix,
                    remote_prefix: server.remote_prefix
                  }
                }
              });
              toast((result.message || '连接成功') +
                (result.save_path ? '；qB 默认保存路径：' + result.save_path : ''), 'ok');
            } catch (err) {
              toast('连接失败：' + err.message, 'error');
            } finally {
              testButton.disabled = false;
              testButton.textContent = '测试';
            }
            return;
          }
          const removeButton = event.target.closest('[data-remove-server]');
          if (removeButton) {
            collectServers();
            servers.splice(Number(removeButton.dataset.removeServer), 1);
            renderServers();
          }
        });

        $('#cfgAddServer', root).addEventListener('click', () => {
          collectServers();
          if (servers.length >= MAX_SERVERS) {
            toast('最多添加 ' + MAX_SERVERS + ' 台 qBittorrent 服务器', 'warn');
            return;
          }
          servers.push({
            id: '', name: 'qB ' + (servers.length + 1), url: '', username: '',
            has_password: false, password: '', local_prefix: '', remote_prefix: ''
          });
          renderServers();
          const inputs = list.querySelectorAll('[data-server-index][data-key="name"]');
          const last = inputs[inputs.length - 1];
          if (last) { last.focus(); last.select(); }
        });

        $('#cfgFetchTrackers', root).addEventListener('click', async () => {
          $('#torrentTrackers').value = trackerArea.value;
          await fetchPublicTrackers({ force: true });
          trackerArea.value = $('#torrentTrackers').value;
        });

        $('#cfgClearTrackers', root).addEventListener('click', () => {
          trackerArea.value = '';
        });

        const revealButton = $('#cfg115RevealBtn', root);
        if (revealButton) {
          const revealBox = $('#cfg115Reveal', root);
          const revealValue = $('#cfg115RevealValue', root);
          const revealCopy = $('#cfg115RevealCopy', root);
          revealButton.addEventListener('click', async () => {
            const password = $('#cfg115Pass', root).value;
            if (!password) {
              toast('请先输入加密密码，再查看 Cookie', 'warn');
              return;
            }
            revealButton.disabled = true;
            revealButton.textContent = '验证中…';
            try {
              const data = await api('/api/integrations/reveal', {
                method: 'POST',
                body: { password: password }
              });
              revealValue.value = data.cookie || '';
              revealBox.hidden = false;
              revealCopy.disabled = !revealValue.value;
              revealBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              toast('已显示已保存的 Cookie', 'ok');
            } catch (err) {
              toast('查看失败：' + err.message, 'error');
            } finally {
              revealButton.disabled = false;
              revealButton.textContent = '查看 Cookie';
            }
          });
          revealCopy.addEventListener('click', () => copyText(revealValue.value, '已复制 Cookie'));
        }

        const unlockButton = $('#cfg115UnlockBtn', root);
        if (unlockButton) {
          unlockButton.addEventListener('click', async () => {
            const password = $('#cfg115Pass', root).value;
            if (!password) {
              toast('请输入加密密码', 'warn');
              return;
            }
            unlockButton.disabled = true;
            unlockButton.textContent = '解锁中…';
            try {
              await api('/api/integrations/unlock', { method: 'POST', body: { password: password } });
              toast('115 Cookie 已解锁，本次运行期间有效', 'ok');
              closeModal();
              await loadIntegrations();
              openIntegrations();
            } catch (err) {
              toast('解锁失败：' + err.message, 'error');
              unlockButton.disabled = false;
              unlockButton.textContent = '解锁';
            }
          });
        }

        const button = $('#saveIntegrationsBtn', root);
        button.addEventListener('click', async () => {
          collectServers();
          $('#torrentTrackers').value = trackerArea.value;
          $('#torrentTrackers').dispatchEvent(new Event('input'));
          button.disabled = true;
          button.textContent = '保存中…';
          try {
            await api('/api/integrations', {
              method: 'POST',
              body: {
                qb_servers: servers.map(server => ({
                  id: server.id || '',
                  name: server.name.trim(),
                  url: server.url.trim(),
                  username: server.username.trim(),
                  password: server.password,
                  local_prefix: server.local_prefix.trim(),
                  remote_prefix: server.remote_prefix.trim()
                })),
                offline115: {
                  cookie: $('#cfg115Cookie', root).value.trim(),
                  cookie_password: $('#cfg115Pass', root).value,
                  save_cid: $('#cfg115Cid', root).value.trim()
                }
              }
            });
            toast('设置已保存', 'ok');
            closeModal();
            await loadIntegrations();
          } catch (err) {
            toast('保存失败：' + err.message, 'error');
            button.disabled = false;
            button.textContent = '保存设置';
          }
        });
      },
      'settings-modal'
    );
  }

  async function openQbPush(job, server) {
    server = server || null;
    if (!server) {
      toast('请先在设置中添加 qBittorrent 服务器', 'warn');
      openIntegrations();
      return;
    }
    let prep;
    try {
      prep = await api('/api/qb/prepare', {
        method: 'POST',
        body: { job_id: job.id, server_id: server.id }
      });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const serverName = prep.server_name || server.name;
    openModal(
      '<div class="modal-head"><h2>推送 ' + esc(serverName) + '</h2>' +
        '<button class="icon-btn" type="button" data-act="close" aria-label="关闭" title="关闭">' + icon('x') + '</button></div>' +
      '<p class="modal-desc">把种子加入「' + esc(serverName) + '」，并让保存路径与生成种子时的源文件目录保持一致。</p>' +
      '<div class="push-form">' +
        (prep.mapping_error
          ? '<p class="push-note warn-note">路径映射未生效：' + esc(prep.mapping_error) +
            '<br>请手动填写 qB 所在机器上的保存路径，例如 D:\\Documents\\Downloads。</p>'
          : '') +
        '<label class="field" title="qB 所在机器上的做种保存路径"><span>做种保存路径<em>' + prep.file_count + ' 个源文件</em></span>' +
          '<input type="text" id="qbSavePath" value="' + esc(prep.savepath) + '" placeholder="例如 D:\\Documents\\Downloads" autocomplete="off" title="qB 所在机器上的做种保存路径"></label>' +
        (prep.remembered
          ? '<p class="push-note">已记忆该 qBittorrent 上次使用的保存路径，成功后会自动更新。</p>'
          : prep.qb_default
            ? '<p class="push-note">已读取该 qBittorrent 的默认下载目录：' + esc(prep.qb_default) + '</p>'
            : '') +
        '<p class="push-note">本工具路径：' + esc(prep.local_savepath) + '</p>' +
        '<label class="switch-field" title="文件已在本机计算过，跳过校验可加快加入速度">' +
          '<span>跳过校验</span>' +
          '<span class="switch-wrap"><input type="checkbox" id="qbSkipChecking" class="switch" checked><span class="switch-track"></span></span>' +
        '</label>' +
        '<label class="switch-field" title="开启后任务以暂停状态加入，需在 qB 中手动开始">' +
          '<span>加入后暂停</span>' +
          '<span class="switch-wrap"><input type="checkbox" id="qbPaused" class="switch"><span class="switch-track"></span></span>' +
        '</label>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn btn-ghost" type="button" data-act="close" title="取消并关闭">取消</button>' +
        '<button class="btn btn-primary" type="button" id="qbPushConfirm" title="提交种子到该 qBittorrent 服务器">推送到 ' + esc(serverName) + '</button>' +
      '</div>',
      root => {
        const button = $('#qbPushConfirm', root);
        button.addEventListener('click', async () => {
          const savepath = $('#qbSavePath', root).value.trim();
          if (!savepath) {
            toast('请填写做种保存路径', 'warn');
            return;
          }
          button.disabled = true;
          button.textContent = '推送中…';
          try {
            const result = await api('/api/qb/push', {
              method: 'POST',
              body: {
                job_id: job.id,
                server_id: server.id,
                savepath: savepath,
                skip_checking: $('#qbSkipChecking', root).checked,
                paused: $('#qbPaused', root).checked
              }
            });
            toast(result.message || '已推送到 ' + serverName, 'ok');
            closeModal();
          } catch (err) {
            toast('推送失败：' + err.message, 'error');
            button.disabled = false;
            button.textContent = '推送到 ' + serverName;
          }
        });
      }
    );
  }

  async function waitTorrentJob(jobId) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await refresh();
      const job = state.jobs.find(item => item.id === jobId);
      if (job && job.status === 'done') return job;
      if (job && job.status === 'error') throw new Error(job.error || '生成种子失败');
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    throw new Error('生成种子超时，请稍后重试');
  }

  async function pushEd2kToQb(serverId) {
    const servers = (state.integrations && state.integrations.qb_servers) || [];
    const server = servers.find(item => item.id === serverId);
    if (!server) {
      toast('qBittorrent 服务器不存在，请重新打开设置保存后再试', 'warn');
      return;
    }
    const pool = state.selected.size
      ? moduleFiles('ed2k').filter(file => state.selected.has(file.id))
      : moduleFiles('ed2k');
    const ids = pool.filter(file => file.complete).map(file => file.id);
    if (!ids.length) {
      toast('没有可推送的完整文件', 'warn');
      return;
    }
    toast('正在获取公共 Tracker…', 'info');
    let trackers = [];
    try {
      const trackerData = await api('/api/trackers');
      trackers = Array.isArray(trackerData.trackers) ? trackerData.trackers.slice(0, 30) : [];
    } catch (err) {

    }
    toast('正在生成种子并准备推送…', 'info');
    const firstFile = pool.find(file => file.complete);
    const defaultName = firstFile ? firstFile.name.replace(/\.[^.]+$/, '') : '';
    try {
      const created = await api('/api/torrent/create', {
        method: 'POST',
        body: {
          ids: ids,
          name: defaultName,
          trackers: trackers,
          piece_size: 0,
          private: false,
          embed_ed2k: true,
          comment: ''
        }
      });
      const job = await waitTorrentJob(created.job_id);
      await refresh();
      openQbPush(job, server);
    } catch (err) {
      toast('推送失败：' + err.message, 'error');
    }
  }

  function openParseQbPush(server) {
    if (!state.torrentImportFile) {
      toast('请先重新上传种子文件，再推送到 qBittorrent', 'warn');
      return;
    }
    const info = state.torrentImport || {};
    const fileName = state.torrentImportFile.name || 'upload.torrent';
    openModal(
      '<div class="modal-head"><h2>推送 ' + esc(server.name) + '</h2>' +
        '<button class="icon-btn" type="button" data-act="close" aria-label="关闭" title="关闭">' + icon('x') + '</button></div>' +
      '<p class="modal-desc">直接把当前种子提交到 ' + esc(server.url || server.name) +
        '，不会上传媒体文件。请确认 qB 所在机器已存在种子对应的文件。</p>' +
      '<div class="push-form">' +
        '<label class="field" title="qB 所在机器上已存在种子文件时填写保存路径"><span>qB 保存路径<em>' + (info.file_count || 0) + ' 个文件</em></span>' +
          '<input type="text" id="parseQbSavePath" value="' + esc(server.remote_prefix || '') +
            '" placeholder="例如 D:\\Documents\\Downloads" autocomplete="off" title="留空时使用 qB 的默认保存路径"></label>' +
        '<label class="switch-field" title="文件已完整存在时更快；不确定请不要开启">' +
          '<span>跳过校验</span>' +
          '<span class="switch-wrap"><input type="checkbox" id="parseQbSkip" class="switch"><span class="switch-track"></span></span>' +
        '</label>' +
        '<label class="switch-field" title="开启后任务以暂停状态加入，需在 qB 中手动开始">' +
          '<span>添加后暂停</span>' +
          '<span class="switch-wrap"><input type="checkbox" id="parseQbPaused" class="switch"><span class="switch-track"></span></span>' +
        '</label>' +
        '<p class="push-note">保存路径留空时使用 qB 的默认保存路径。</p>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn btn-ghost" type="button" data-act="close" title="取消并关闭">取消</button>' +
        '<button class="btn btn-primary" type="button" id="parseQbConfirm" title="把当前种子推送到该 qBittorrent 服务器">推送种子</button>' +
      '</div>',
      root => {
        const button = $('#parseQbConfirm', root);
        button.addEventListener('click', async () => {
          button.disabled = true;
          button.textContent = '推送中…';
          try {
            const params = new URLSearchParams({
              server_id: server.id,
              savepath: $('#parseQbSavePath', root).value.trim(),
              filename: fileName,
              skip_checking: $('#parseQbSkip', root).checked ? '1' : '0',
              paused: $('#parseQbPaused', root).checked ? '1' : '0'
            });
            const buffer = await state.torrentImportFile.arrayBuffer();
            const result = await api('/api/qb/push-torrent?' + params.toString(), {
              method: 'POST',
              body: buffer,
              headers: { 'Content-Type': 'application/x-bittorrent' }
            });
            toast(result.message || ('已推送到 ' + server.name), 'ok');
            closeModal();
          } catch (err) {
            toast('推送失败：' + err.message, 'error');
            button.disabled = false;
            button.textContent = '推送种子';
          }
        });
      }
    );
  }

  async function open115ParsePush(items) {
    if (!items.length) {
      toast('没有可推送的 ED2K 链接', 'warn');
      return;
    }
    if (items.length > 50) {
      toast('一次最多推送 50 条，请勾选要推送的文件', 'warn');
      return;
    }
    let online = {};
    try {
      online = (await api('/api/integrations')).offline115 || {};
    } catch (err) {
      online = {};
    }
    const preview = items.slice(0, 6).map(item =>
      '<li><span>' + esc(item.label || 'ED2K') + '</span><code>' + esc(item.url.slice(0, 72)) + '…</code></li>'
    ).join('');
    openModal(
      '<div class="modal-head"><h2>推送 115 离线</h2>' +
        '<button class="icon-btn" type="button" data-act="close" aria-label="关闭" title="关闭">' + icon('x') + '</button></div>' +
      '<p class="modal-desc">将提交 ' + items.length + ' 条 ED2K 链接。开启「保持目录结构」时，会按种子内的路径在 115 逐级创建文件夹。</p>' +
      '<div class="push-form">' +
        '<ul class="push-link-list">' + preview +
          (items.length > 6 ? '<li class="push-more">等共 ' + items.length + ' 条</li>' : '') +
        '</ul>' +
        '<label class="field" title="可选，留空使用默认云下载目录"><span>保存目录 CID</span>' +
          '<input type="text" id="push115BatchCid" value="' + esc(online.save_cid || '') + '" placeholder="例如 0" autocomplete="off" title="可选，留空使用默认云下载目录"></label>' +
        '<label class="switch-field" title="按种子内路径自动创建 115 文件夹，失败时回退到所选目录">' +
          '<span>保持目录结构</span>' +
          '<span class="switch-wrap"><input type="checkbox" id="push115KeepTree" class="switch" checked><span class="switch-track"></span></span>' +
        '</label>' +
        (!online.has_cookie
          ? '<p class="push-note">尚未设置 115 Cookie，请先在「设置」中粘贴。</p>'
          : online.cookie_locked
            ? '<p class="push-note warn-note">115 Cookie 已加密锁定，请先在「设置」中输入密码解锁。</p>'
            : '') +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn btn-ghost" type="button" data-act="close" title="取消并关闭">取消</button>' +
        '<button class="btn btn-primary" type="button" id="push115BatchConfirm" title="提交所选链接到 115 离线">推送 ' + items.length + ' 条</button>' +
      '</div>',
      root => {
        const button = $('#push115BatchConfirm', root);
        button.addEventListener('click', async () => {
          button.disabled = true;
          button.textContent = '提交中…';
          try {
            const data = await api('/api/115/push-items', {
              method: 'POST',
              body: {
                items: items.map(item => ({ url: item.url, path: item.path || '' })),
                save_cid: $('#push115BatchCid', root).value.trim(),
                keep_structure: $('#push115KeepTree', root).checked
              }
            });
            const parts = [];
            if (data.submitted) parts.push('已提交 ' + data.submitted + ' 条');
            if (data.duplicate) parts.push(data.duplicate + ' 条已存在');
            if (data.failed) parts.push(data.failed + ' 条失败');
            if (data.folders_created) parts.push('新建目录 ' + data.folders_created + ' 个');
            toast(parts.join('，') || '没有提交任何链接', data.failed ? 'warn' : 'ok');
            if (data.folder_failed) {
              toast(data.folder_failed + ' 个目录创建失败，已回退到所选目录', 'warn');
            }
            if (data.failed && data.error) toast(data.error, 'error');
            closeModal();
          } catch (err) {
            toast('推送失败：' + err.message, 'error');
            button.disabled = false;
            button.textContent = '推送 ' + items.length + ' 条';
          }
        });
      }
    );
  }

  async function push115Links() {
    const pool = state.selected.size
      ? moduleFiles('ed2k').filter(file => state.selected.has(file.id))
      : moduleFiles('ed2k');
    const ids = pool.filter(file => file.complete).map(file => file.id);
    if (!ids.length) {
      toast('没有可推送的完整文件', 'warn');
      return;
    }
    toast('正在获取公共 Tracker…', 'info');
    let trackers = [];
    try {
      const trackerData = await api('/api/trackers');
      trackers = Array.isArray(trackerData.trackers) ? trackerData.trackers.slice(0, 30) : [];
    } catch (err) {

    }
    toast('正在生成种子并准备推送 115 离线…', 'info');
    const firstFile = pool.find(file => file.complete);
    const defaultName = firstFile ? firstFile.name.replace(/\.[^.]+$/, '') : '';
    try {
      const created = await api('/api/torrent/create', {
        method: 'POST',
        body: {
          ids: ids,
          name: defaultName,
          trackers: trackers,
          piece_size: 0,
          private: false,
          embed_ed2k: true,
          comment: ''
        }
      });
      const job = await waitTorrentJob(created.job_id);
      await refresh();
      open115Push(job);
    } catch (err) {
      toast('推送失败：' + err.message, 'error');
    }
  }

  async function open115Push(job) {
    const result = job.result || {};
    let online = {};
    try {
      const data = await api('/api/integrations');
      online = data.offline115 || {};
    } catch (err) {
      online = {};
    }
    const trackers = (result.trackers || []).slice(0, 30);
    let magnet = 'magnet:?xt=urn:btih:' + (result.info_hash || '') +
      '&dn=' + magnetName(result.name || '');
    trackers.forEach(tracker => { magnet += '&tr=' + encodeURIComponent(tracker); });
    openModal(
      '<div class="modal-head"><h2>推送 115 离线</h2>' +
        '<button class="icon-btn" type="button" data-act="close" aria-label="关闭" title="关闭">' + icon('x') + '</button></div>' +
      '<p class="modal-desc">通过 115 离线接口提交磁力链。需要云端已有同一文件，否则会一直等待或失败。</p>' +
      '<div class="push-form">' +
        '<label class="field"><span>磁力链</span>' +
          '<textarea class="push-magnet" id="push115Magnet" rows="4" readonly spellcheck="false" title="要推送到 115 离线的磁力链">' + esc(magnet) + '</textarea></label>' +
        '<label class="field" title="可选，留空使用默认云下载目录"><span>保存目录 CID</span>' +
          '<input type="text" id="push115Cid" value="' + esc(online.save_cid || '') + '" placeholder="例如 0" autocomplete="off" title="可选，留空使用默认云下载目录"></label>' +
        (!online.has_cookie
          ? '<p class="push-note">尚未设置 115 Cookie，请先在「设置」中粘贴。</p>'
          : online.cookie_locked
            ? '<p class="push-note warn-note">115 Cookie 已加密锁定，请先在「设置」中输入密码解锁。</p>'
            : '') +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn btn-ghost" type="button" data-act="close" title="取消并关闭">取消</button>' +
        '<button class="btn btn-primary" type="button" id="push115Confirm" title="把磁力链提交到 115 离线">推送到 115</button>' +
      '</div>',
      root => {
        const button = $('#push115Confirm', root);
        button.addEventListener('click', async () => {
          button.disabled = true;
          button.textContent = '提交中…';
          try {
            const data = await api('/api/115/push', {
              method: 'POST',
              body: { job_id: job.id, save_cid: $('#push115Cid', root).value.trim() }
            });
            toast(data.message || '已提交 115 离线任务', 'ok');
            closeModal();
          } catch (err) {
            toast('推送失败：' + err.message, 'error');
            button.disabled = false;
            button.textContent = '推送到 115';
          }
        });
      }
    );
  }

  function historyItemHtml(item) {
    const isEd2k = item.type === 'ed2k';
    const title = item.torrent_name || item.name || (isEd2k ? 'ED2K 链接' : '未命名种子');
    const sub = isEd2k
      ? ['ED2K 链接', '1 个文件', fmtSize(item.total_size || 0),
        item.created ? new Date(item.created * 1000).toLocaleString() : '']
      : [
        item.torrent_name && item.name && item.torrent_name !== item.name ? '种子名 ' + item.name : '',
        item.dir ? '目录 ' + item.dir : '',
        (item.file_count || 0) + ' 个文件',
        fmtSize(item.total_size || 0),
        item.created ? new Date(item.created * 1000).toLocaleString() : ''
      ];
    const subText = sub.filter(Boolean).join(' · ');
    return '<div class="history-item' + (item.available ? '' : ' is-missing') + '" data-history-id="' + esc(item.id) + '">' +
      '<label class="history-pick" title="勾选后可批量操作"><input type="checkbox" class="history-check" data-history-check="' + esc(item.id) + '" aria-label="选择 ' + esc(title) + '"></label>' +
      '<div class="history-item-main">' +
        '<div class="history-item-name" title="' + esc(title) + '">' + esc(title) + '</div>' +
        '<div class="history-item-sub meta-chips" title="' + esc(subText) + '">' + metaChips(sub) + '</div>' +
      '</div>' +
      '<button class="history-info-btn" type="button" data-history-info="' + esc(item.id) + '" title="查看详情" aria-label="查看详情">!</button>' +
    '</div>' +
    '<div class="history-detail" data-history-detail="' + esc(item.id) + '" hidden></div>';
  }


  function historyDetailHtml(item) {
    const isEd2k = item.type === 'ed2k';
    const links = (item.ed2k_links || []).filter(Boolean);
    const primary = isEd2k
      ? links[0] || ''
      : (item.info_hash || '');
    const primaryLabel = isEd2k ? 'ED2K 链接' : 'Info Hash';
    const timeText = item.created ? new Date(item.created * 1000).toLocaleString() : '—';
    const meta = isEd2k
      ? [
        ['类型', 'ED2K 链接'],
        ['文件大小', fmtSize(item.total_size || 0)]
      ]
      : [
        ['种子大小', fmtSize(item.torrent_size || 0)],
        ['分块', fmtPiece(item.piece_length || 0)],
        ['块数', (item.piece_count || 0) + ' 块'],
        ['类型', item.private ? '私有种子' : '公开种子'],
        ['Tracker', (item.trackers || []).length + ' 个'],
        ['内嵌 ED2K', (item.embedded_count || 0) + ' 条'],
        ['文件数', (item.file_count || 0) + ' 个'],
        ['总大小', fmtSize(item.total_size || 0)]
      ];
    return '<div class="history-detail-rows">' +
        '<div class="history-detail-primary">' +
          '<span class="history-detail-label">' + primaryLabel + '</span>' +
          '<code class="history-detail-code" title="' + esc(primary || '—') + '">' + esc(primary || '—') + '</code>' +
          '<span class="history-detail-time" title="生成时间"><b>时间</b>' + esc(timeText) + '</span>' +
        '</div>' +
        '<div class="history-detail-meta">' +
          meta.map(([label, value]) =>
            '<span class="history-detail-chip"><b>' + esc(label) + '</b>' + value + '</span>'
          ).join('') +
        '</div>' +
      '</div>' +
      (!isEd2k && links.length
        ? '<div class="history-links"><span class="history-links-title">内嵌 ED2K（' + links.length + ' 条）</span>' +
            links.slice(0, 50).map(link => '<code class="history-link" title="' + esc(link) + '">' + esc(link) + '</code>').join('') +
          '</div>'
        : '') +
      (item.available
        ? ''
        : '<p class="push-note warn-note">服务器上的种子文件已丢失，推送与下载不可用。</p>');
  }

  async function openTorrentHistory() {
    let items = [];
    try {
      const data = await api('/api/history');
      items = Array.isArray(data.items) ? data.items : [];
    } catch (err) {
      toast('加载历史失败：' + err.message, 'error');
      return;
    }
    if (!items.length) {
      toast('还没有生成过种子或 ED2K 链接', 'info');
      return;
    }
    const cache = new Map(items.map(item => [item.id, item]));
    const selected = new Set();
    const qbServers = (state.integrations && state.integrations.qb_servers) || [];
    let pendingRemove = false;
    openModal(
      '<div class="modal-head"><h2>历史记录</h2><span class="count-pill">' + items.length + ' 条</span>' +
        '<button class="icon-btn" type="button" data-act="close" aria-label="关闭" title="关闭">' + icon('x') + '</button></div>' +
      '<p class="modal-desc">这里保存了已生成的种子、磁力链与 ED2K 链接记录。勾选后可推送、导出或移除。</p>' +
      '<div class="history-modal-list">' + items.map(historyItemHtml).join('') + '</div>' +
      '<div class="history-qb-pick" id="historyQbPick" hidden></div>' +
      '<div class="modal-foot history-modal-foot">' +
        '<button class="btn btn-secondary btn-sm" type="button" id="historyPush115Btn" title="把所选记录推送到 115 离线"><svg class="icon" aria-hidden="true"><use href="#i-cloud"/></svg>推送115离线</button>' +
        '<button class="btn btn-secondary btn-sm" type="button" id="historyCopyBtn" title="复制所选记录的链接：种子复制磁力链，ED2K 记录复制 ED2K 链接"><svg class="icon" aria-hidden="true"><use href="#i-copy"/></svg>复制</button>' +
        (qbServers.length
          ? '<button class="btn btn-secondary btn-sm" type="button" id="historyPushQbBtn" title="把所选记录对应的种子推送到 qBittorrent 下载"><svg class="icon" aria-hidden="true"><use href="#i-server"/></svg>推送qb下载</button>'
          : '') +
        '<button class="btn btn-secondary btn-sm" type="button" id="historySelectAllBtn" title="全选或取消全选"><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg><span>全选</span></button>' +
        '<button class="btn btn-danger-ghost btn-sm" type="button" id="historyRemoveBtn" title="删除历史记录并清理对应的种子文件、磁力链与 ED2K 数据"><svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg><span>移除</span></button>' +
        '<button class="btn btn-secondary btn-sm" type="button" id="historyExportBtn" title="导出所选记录（未选择时导出全部）为 TXT"><svg class="icon" aria-hidden="true"><use href="#i-download"/></svg>导出TXT</button>' +
      '</div>',
      root => {
        const list = $('.history-modal-list', root);
        const pick = (entries) => entries.filter(Boolean);
        const chosen = () => {
          const ids = selected.size ? Array.from(selected) : items.map(item => item.id);
          return pick(ids.map(id => cache.get(id)));
        };
        const resetRemove = () => {
          pendingRemove = false;
          const button = $('#historyRemoveBtn', root);
          if (button) button.querySelector('span').textContent = '移除';
        };

        list.addEventListener('click', event => {
          const button = event.target.closest('[data-history-info]');
          if (!button) return;
          const id = button.dataset.historyInfo;
          const panel = list.querySelector('[data-history-detail="' + id + '"]');
          if (!panel) return;
          if (panel.hidden) {
            if (!panel.innerHTML) panel.innerHTML = historyDetailHtml(cache.get(id) || {});
            panel.hidden = false;
            button.classList.add('is-open');
          } else {
            panel.hidden = true;
            button.classList.remove('is-open');
          }
        });

        list.addEventListener('change', event => {
          const box = event.target.closest('[data-history-check]');
          if (!box) return;
          if (box.checked) selected.add(box.dataset.historyCheck);
          else selected.delete(box.dataset.historyCheck);
          resetRemove();
        });

        $('#historySelectAllBtn', root).addEventListener('click', () => {
          const boxes = Array.from(list.querySelectorAll('[data-history-check]'));
          const allChecked = boxes.length > 0 && boxes.every(box => box.checked);
          boxes.forEach(box => {
            box.checked = !allChecked;
            if (allChecked) selected.delete(box.dataset.historyCheck);
            else selected.add(box.dataset.historyCheck);
          });
          $('#historySelectAllBtn', root).querySelector('span').textContent = allChecked ? '全选' : '取消全选';
          resetRemove();
        });

        $('#historyExportBtn', root).addEventListener('click', () => {
          const entries = chosen();
          if (!entries.length) return;
          const lines = [];
          entries.forEach(item => {
            lines.push('# ' + (item.torrent_name || item.name || '未命名种子'));
            if (item.dir) lines.push('目录: ' + item.dir);
            if (item.info_hash) lines.push('Info Hash: ' + item.info_hash);
            if (item.magnet) lines.push('磁力链: ' + item.magnet);
            (item.ed2k_links || []).forEach(link => lines.push('ED2K: ' + link));
            lines.push('');
          });
          downloadText(lines.join('\r\n'), 'torrent-history-' + stamp() + '.txt');
          toast('已导出 ' + entries.length + ' 条历史记录', 'ok');
        });

        $('#historyRemoveBtn', root).addEventListener('click', async () => {
          const entries = chosen();
          if (!entries.length) {
            toast('请先勾选要移除的记录', 'warn');
            return;
          }
          if (!pendingRemove) {
            pendingRemove = true;
            const button = $('#historyRemoveBtn', root);
            button.querySelector('span').textContent = '确认移除 ' + entries.length + ' 条';
            toast('再次点击「确认移除」将删除记录、种子文件以及关联的磁力链与 ED2K 数据', 'warn');
            return;
          }
          const button = $('#historyRemoveBtn', root);
          button.disabled = true;
          try {
            const result = await api('/api/history/delete', {
              method: 'POST',
              body: { ids: entries.map(item => item.id) }
            });
            entries.forEach(item => {
              cache.delete(item.id);
              selected.delete(item.id);
              const row = list.querySelector('[data-history-id="' + item.id + '"]');
              const detail = list.querySelector('[data-history-detail="' + item.id + '"]');
              if (row) row.remove();
              if (detail) detail.remove();
            });

            if (entries.some(item => item.id === state.torrentJobId)) {
              state.torrentJobId = '';
              state.torrentJobSig = '';
              state.lastJobStatus = '';
              localStorage.removeItem(LS.lastJob);
              savePrefs({ last_torrent_job: '' });
              renderTorrentJob();
            }
            toast('已移除 ' + (result.removed || entries.length) + ' 条历史记录', 'ok');
            resetRemove();
            if (!list.querySelector('[data-history-id]')) {
              closeModal();
              toast('历史记录已清空', 'info');
            }
          } catch (err) {
            toast('移除失败：' + err.message, 'error');
            button.disabled = false;
            resetRemove();
          }
        });

        const pushTarget = (needTorrent) => {
          const entries = chosen();
          if (entries.length !== 1) {
            toast('请勾选 1 条记录后再推送', 'warn');
            return null;
          }
          const item = entries[0];
          if (needTorrent && item.type === 'ed2k') {
            toast('ED2K 链接记录不支持推送到 qBittorrent，请选择种子记录', 'warn');
            return null;
          }
          if (!item.available) {
            toast('该记录对应的种子文件已丢失，无法推送', 'warn');
            return null;
          }
          return item;
        };

        $('#historyPush115Btn', root).addEventListener('click', () => {
          const item = pushTarget(false);
          if (!item) return;
          if (item.type === 'ed2k') {
            const link = (item.ed2k_links || [])[0] || '';
            if (!link) {
              toast('该记录缺少 ED2K 链接', 'warn');
              return;
            }
            open115ParsePush([{ label: item.name || 'ED2K', url: link }]);
            return;
          }
          open115Push({ id: item.id, result: {
            info_hash: item.info_hash,
            name: item.dir || item.name,
            trackers: item.trackers || []
          } });
        });

        const copyTargets = () => {
          const picked = chosen();
          if (picked.length) return picked;
          const opened = Array.from(list.querySelectorAll('[data-history-info].is-open'))
            .map(button => cache.get(button.dataset.historyInfo))
            .filter(Boolean);
          return opened.length === 1 ? opened : [];
        };

        $('#historyCopyBtn', root).addEventListener('click', () => {
          const items = copyTargets();
          if (!items.length) {
            toast('请先勾选要复制的记录', 'warn');
            return;
          }
          const magnets = [];
          const ed2kLinks = [];
          items.forEach(item => {
            if (item.type === 'ed2k') {
              (item.ed2k_links || []).filter(Boolean).forEach(link => ed2kLinks.push(link));
            } else if (item.magnet) {
              magnets.push(item.magnet);
            }
          });
          const lines = magnets.concat(ed2kLinks);
          if (!lines.length) {
            toast('所选记录没有可复制的磁力链或 ED2K 链接', 'warn');
            return;
          }
          const detail = [];
          if (magnets.length) detail.push(magnets.length + ' 条磁力链');
          if (ed2kLinks.length) detail.push(ed2kLinks.length + ' 条 ED2K');
          copyText(lines.join('\n'), '已复制 ' + detail.join('、'));
        });

        const qbBtn = $('#historyPushQbBtn', root);
        if (qbBtn) qbBtn.addEventListener('click', () => {
          const item = pushTarget(true);
          if (!item) return;
          const servers = qbServers;
          if (!servers.length) {
            toast('请先在设置中添加 qBittorrent 服务器', 'warn');
            openIntegrations();
            return;
          }
          if (servers.length === 1) {
            openQbPush({ id: item.id, result: { file_name: item.torrent_name } }, servers[0]);
            return;
          }
          const holder = $('#historyQbPick', root);
          holder.hidden = false;
          holder.innerHTML = '<span class="history-qb-hint">选择 qBittorrent：</span>' +
            servers.map(server =>
              '<button class="btn btn-secondary btn-sm" type="button" data-history-qb="' + esc(server.id) + '">' + esc(server.name) + '</button>'
            ).join('');
          holder.onclick = event => {
            const button = event.target.closest('[data-history-qb]');
            if (!button) return;
            const server = servers.find(entry => entry.id === button.dataset.historyQb);
            if (server) openQbPush({ id: item.id, result: { file_name: item.torrent_name } }, server);
          };
        });
      },
      'history-modal'
    );
  }

  function openHelp() {
    openModal(
      '<div class="modal-head"><h2>快捷键与说明</h2>' +
        '<button class="icon-btn" type="button" data-act="close" aria-label="关闭" title="关闭">' + icon('x') + '</button></div>' +
      '<p class="modal-desc">在文件列表中可以使用键盘快速操作。</p>' +
      '<div class="kbd-list">' +
        '<div class="kbd-row"><span>全选 / 取消全选</span><span><kbd>Ctrl</kbd> + <kbd>A</kbd></span></div>' +
        '<div class="kbd-row"><span>删除选中文件</span><span><kbd>Delete</kbd></span></div>' +
        '<div class="kbd-row"><span>复制选中的链接（未选中时复制全部）</span><span><kbd>Ctrl</kbd> + <kbd>C</kbd></span></div>' +
        '<div class="kbd-row"><span>连续多选</span><span><kbd>Shift</kbd> + 点击</span></div>' +
        '<div class="kbd-row"><span>取消选择 / 关闭弹窗</span><span><kbd>Esc</kbd></span></div>' +
      '</div>' +
      '<div class="help-note">ED2K 哈希分块大小为 9500 KiB，由文件内容决定；BT 种子只含 SHA-1 分块信息，导入后需要匹配已添加文件才能生成 ED2K 链接。</div>' +
      '<div class="modal-foot"><button class="btn btn-primary" type="button" data-act="close" title="关闭提示">知道了</button></div>'
    );
  }

  function openLinkImport() {
    openModal(
      '<div class="modal-head"><h2>导入 ED2K 链接</h2>' +
        '<button class="icon-btn" type="button" data-act="close" aria-label="关闭" title="关闭">' + icon('x') + '</button></div>' +
      '<p class="modal-desc">粘贴任意包含 ed2k:// 的文本，将自动提取、去重并规范化为标准格式。</p>' +
      '<textarea id="linkImportText" class="import-textarea" rows="7" spellcheck="false" title="粘贴 ED2K 链接或磁力链，支持多行" ' +
        'placeholder="ed2k://|file|example.mkv|734003200|0123456789ABCDEF0123456789ABCDEF|/"></textarea>' +
      '<div class="modal-preview" id="linkPreview" hidden></div>' +
      '<div class="modal-foot">' +
        '<button class="btn btn-ghost" type="button" data-act="close" title="取消并关闭">取消</button>' +
        '<button class="btn btn-secondary" type="button" id="parseLinksBtn" title="解析文本框中的链接">解析链接</button>' +
        '<button class="btn btn-primary" type="button" id="saveLinksBtn" disabled title="把识别到的链接加入列表">导入到列表</button>' +
      '</div>',
      root => {
        const textarea = root.querySelector('#linkImportText');
        const preview = root.querySelector('#linkPreview');
        const saveButton = root.querySelector('#saveLinksBtn');
        let parsed = [];

        root.querySelector('#parseLinksBtn').addEventListener('click', async () => {
          try {
            const result = await api('/api/ed2k/parse', { method: 'POST', body: { text: textarea.value } });
            parsed = Array.isArray(result.links) ? result.links : [];
            saveButton.disabled = parsed.length === 0;
            preview.hidden = false;
            if (!parsed.length) {
              preview.innerHTML = '<div class="preview-head">未识别到有效的 ED2K 链接</div>';
              return;
            }
            preview.innerHTML = '<div class="preview-head">识别到 ' + parsed.length + ' 条链接' +
              (parsed.length > 6 ? '（仅预览前 6 条）' : '') + '</div>' +
              parsed.slice(0, 6).map(item =>
                '<div class="preview-row"><span class="mini-name">' + esc(item.name) + '</span>' +
                '<span class="preview-size">' + fmtSize(item.size) + '</span></div>'
              ).join('');
          } catch (err) {
            toast(err.message, 'error');
          }
        });

        saveButton.addEventListener('click', () => {
          if (!parsed.length) return;
          addImported(parsed);
          closeModal();
          if (state.tab !== 'ed2k') switchTab('ed2k');
        });
      }
    );
  }


  function openServerBrowse(options) {
    const torrentMode = !!(options && options.mode === 'torrents');
    const module = options && options.module ? options.module : 'ed2k';
    const onPick = options && typeof options.onPick === 'function' ? options.onPick : null;
    const title = onPick ? '从服务器载入种子' : (torrentMode ? '从服务器批量解析种子' : '从服务器目录添加');
    openModal(
      '<div class="modal-head"><h2>' + title + '</h2>' +
        '<button class="icon-btn" type="button" data-act="close" aria-label="关闭" title="关闭">' + icon('x') + '</button></div>' +
      '<p class="modal-desc">' + (onPick
        ? '选择服务器上的一个或多个 .torrent 文件载入编辑器。可浏览：<code id="browseRootsText"></code>'
        : torrentMode
          ? '选择服务器上的一个或多个 .torrent 文件，直接批量解析并匹配 ED2K。可浏览：<code id="browseRootsText"></code>'
          : '直接选择服务器上的文件或文件夹，按原文件计算 ED2K，无需上传。勾选文件夹会将整个目录加入处理队列。可浏览：<code id="browseRootsText"></code>') +
      '</p>' +
      '<div class="browse-bar">' +
        '<button class="mini-btn" id="browseUp" type="button" title="返回上一级目录">' + icon('up') + '上一级</button>' +
        '<div class="browse-path" id="browsePath"></div>' +
        '<button class="mini-btn" id="browseSelectAll" type="button" title="选中当前目录下的全部文件">全选当前</button>' +
      '</div>' +
      '<div class="browse-list" id="browseList"></div>' +
      '<div class="modal-foot browse-foot">' +
        '<span class="browse-summary" id="browseSummary">未选择文件</span>' +
        '<span class="browse-foot-actions">' +
          '<button class="btn btn-ghost" type="button" data-act="close" title="取消并关闭">取消</button>' +
          '<button class="btn btn-secondary" id="browseAddFolder" type="button" title="添加当前所在文件夹">添加当前文件夹</button>' +
          '<button class="btn btn-primary" id="browseAddSelected" type="button" disabled title="添加勾选的文件">添加选中</button>' +
        '</span>' +
      '</div>',
      root => {
        const listEl = root.querySelector('#browseList');
        const pathEl = root.querySelector('#browsePath');
        const upBtn = root.querySelector('#browseUp');
        const summaryEl = root.querySelector('#browseSummary');
        const addSelectedBtn = root.querySelector('#browseAddSelected');
        const addFolderBtn = root.querySelector('#browseAddFolder');
        const selectAllBtn = root.querySelector('#browseSelectAll');
        const rootsText = root.querySelector('#browseRootsText');
        if (torrentMode) {
          addFolderBtn.hidden = true;
          addSelectedBtn.textContent = onPick ? '载入选中' : '解析选中';
          addSelectedBtn.title = onPick ? '把勾选的 .torrent 载入编辑器' : '解析勾选的 .torrent 文件';
          selectAllBtn.title = '选中当前目录下的全部 .torrent 文件';
        }
        const selected = new Map();
        let current = null;
        let busy = false;

        function visibleFiles() {
          if (!current) return [];
          return torrentMode
            ? current.files.filter(file => /\.torrent$/i.test(file.name))
            : current.files;
        }

        function updateSummary() {
          let total = 0;
          let folders = 0;
          selected.forEach(item => {
            total += item.size || 0;
            if (item.folder) folders += 1;
          });
          summaryEl.textContent = selected.size
            ? (torrentMode ? '已选 ' + selected.size + ' 个种子' :
                '已选 ' + selected.size + ' 项' +
                (folders ? '（含 ' + folders + ' 个文件夹）' : '') +
                (total ? ' · ' + fmtSize(total) : ''))
            : (torrentMode ? '未选择种子文件' : '未选择文件或文件夹');
          addSelectedBtn.disabled = busy || selected.size === 0;
          addFolderBtn.disabled = busy || !current;
          selectAllBtn.disabled = busy || !current ||
            (visibleFiles().length === 0 && !torrentMode && current.dirs.length === 0);
        }

        function render() {
          pathEl.textContent = current.path;
          pathEl.title = current.path;
          if (rootsText) rootsText.textContent = current.roots.join('  ·  ');
          upBtn.disabled = busy || !current.parent;
          const files = visibleFiles();
          if (!current.dirs.length && !files.length) {
            listEl.innerHTML = '<div class="browse-empty">' +
              (torrentMode ? '此目录没有 .torrent 文件' : '此目录没有可读取的文件') + '</div>';
            return;
          }
          const dirRows = current.dirs.map(dir => {
            const active = selected.has(dir.path);
            return '<div class="browse-row is-dir' + (active ? ' is-selected' : '') + '" data-dir="' + esc(dir.path) + '" role="button" tabindex="0" title="点击进入该文件夹，勾选左侧可整目录添加">' +
              (torrentMode ? '<span class="browse-check is-hidden"></span>'
                : '<span class="browse-check" data-dir-check="' + esc(dir.path) + '" role="checkbox" aria-checked="' + (active ? 'true' : 'false') + '" title="选中整个文件夹">' + icon('check') + '</span>') +
              '<span class="browse-icon">' + icon('folder') + '</span>' +
              '<span class="browse-name">' + esc(dir.name) + '</span>' +
              '<span class="browse-arrow">›</span>' +
            '</div>';
          }).join('');
          const fileRows = files.map(file => {
            const active = selected.has(file.path);
            return '<div class="browse-row is-file' + (active ? ' is-selected' : '') + '" data-file="' + esc(file.path) + '" role="button" tabindex="0" title="点击勾选该文件">' +
              '<span class="browse-check">' + icon('check') + '</span>' +
              '<span class="browse-icon">' + icon(torrentMode ? 'magnet' : 'file') + '</span>' +
              '<span class="browse-name">' + esc(file.name) + '</span>' +
              '<span class="browse-size">' + fmtSize(file.size) + '</span>' +
            '</div>';
          }).join('');
          listEl.innerHTML = dirRows + fileRows;
        }

        async function load(path) {
          busy = true;
          updateSummary();
          listEl.innerHTML = '<div class="browse-empty">正在读取…</div>';
          try {
            const data = await api('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : ''));
            current = data;
            saveJSON(LS.browseDir, data.path || '');
            savePrefs({ browse_dir: data.path || '' });
            render();
          } catch (err) {
            if (path) {
              busy = false;
              updateSummary();
              return load('');
            }
            listEl.innerHTML = '<div class="browse-empty">' + esc(err.message) + '</div>';
          } finally {
            busy = false;
            updateSummary();
            if (current) upBtn.disabled = !current.parent;
          }
        }

        async function parsePaths(paths) {
          busy = true;
          updateSummary();
          addSelectedBtn.textContent = '正在解析…';
          const files = [];
          for (const path of paths) {
            try {
              const res = await fetch('/api/torrent/raw?path=' + encodeURIComponent(path));
              if (!res.ok) continue;
              const buffer = await res.arrayBuffer();
              const name = String(path).split(/[\\/]/).pop() || 'torrent.torrent';
              files.push(new File([buffer], name, { type: 'application/x-bittorrent' }));
            } catch (err) {

            }
          }
          busy = false;
          addSelectedBtn.textContent = onPick ? '载入选中' : '解析选中';
          updateSummary();
          if (!files.length) {
            toast('没有可解析的 .torrent 文件', 'warn');
            return;
          }
          closeModal();
          if (onPick) {
            await onPick(files);
            return;
          }
          await parseTorrentFiles(files);
        }

        async function addPaths(paths, label) {
          if (!paths.length || busy) return;
          if (torrentMode) {
            await parsePaths(paths);
            return;
          }
          busy = true;
          updateSummary();
          addSelectedBtn.textContent = '正在添加…';
          try {
            const result = await api('/api/add-path', { method: 'POST', body: { paths: paths, module: module } });
            const added = Number(result.added) || 0;
            const skipped = Number(result.skipped) || 0;
            if (result.truncated) {
              toast('文件数量过多，仅添加了前 ' + added + ' 个文件', 'warn');
            } else if (added > 0) {
              toast(label + '：已添加 ' + added + ' 个文件' + (skipped ? '，跳过 ' + skipped + ' 个' : ''), 'ok');
            } else {
              toast(skipped ? '这些文件已在列表中或无法读取' : '没有可添加的文件', 'warn');
            }
            if (added > 0) {
              closeModal();
              await refresh();
            }
          } catch (err) {
            toast(err.message, 'error');
          } finally {
            busy = false;
            addSelectedBtn.textContent = '添加选中';
            updateSummary();
          }
        }

        listEl.addEventListener('click', event => {
          const dirRow = event.target.closest('[data-dir]');
          if (dirRow) {
            if (event.target.closest('.browse-check')) {
              event.preventDefault();
              const path = dirRow.getAttribute('data-dir');
              if (selected.has(path)) selected.delete(path);
              else selected.set(path, { size: 0, folder: true });
              const active = selected.has(path);
              dirRow.classList.toggle('is-selected', active);
              const check = dirRow.querySelector('.browse-check');
              if (check) check.setAttribute('aria-checked', active ? 'true' : 'false');
              updateSummary();
              return;
            }
            load(dirRow.getAttribute('data-dir'));
            return;
          }
          const fileRow = event.target.closest('[data-file]');
          if (!fileRow) return;
          const path = fileRow.getAttribute('data-file');
          if (selected.has(path)) {
            selected.delete(path);
          } else {
            const file = current.files.find(item => item.path === path);
            selected.set(path, { size: file ? file.size : 0, folder: false });
          }
          fileRow.classList.toggle('is-selected', selected.has(path));
          updateSummary();
        });

        listEl.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          const dirRow = event.target.closest('[data-dir]');
          if (dirRow) {
            event.preventDefault();
            load(dirRow.getAttribute('data-dir'));
            return;
          }
          const fileRow = event.target.closest('[data-file]');
          if (!fileRow) return;
          event.preventDefault();
          fileRow.click();
        });

        upBtn.addEventListener('click', () => {
          if (current && current.parent) load(current.parent);
        });

        selectAllBtn.addEventListener('click', () => {
          if (!current) return;
          const files = visibleFiles();
          const allSelected = files.length > 0 && files.every(file => selected.has(file.path));
          files.forEach(file => {
            if (allSelected) selected.delete(file.path);
            else selected.set(file.path, { size: file.size, folder: false });
          });
          if (!torrentMode) {
            current.dirs.forEach(dir => {
              if (allSelected) selected.delete(dir.path);
              else selected.set(dir.path, { size: 0, folder: true });
            });
          }
          render();
          updateSummary();
        });

        addSelectedBtn.addEventListener('click', () => {
          addPaths(Array.from(selected.keys()), '添加选中');
        });

        addFolderBtn.addEventListener('click', () => {
          if (current) addPaths([current.path], '添加文件夹');
        });

        const lastDir = loadJSON(LS.browseDir, '');
        load(typeof lastDir === 'string' ? lastDir : '');
        updateSummary();
      }
    );
  }

  async function logout() {
    try {
      await api('/api/logout', { method: 'POST', body: {} });
    } catch (err) {

    }
    location.href = '/login';
  }


  function initMarquee() {
    const list = $('#fileList');
    let start = null;
    let box = null;
    let base = null;

    list.addEventListener('pointerdown', event => {
      if (event.pointerType === 'touch' || event.button !== 0) return;
      if (event.target.closest('button, input, label, a, code')) return;
      start = { x: event.clientX, y: event.clientY };
      base = (event.ctrlKey || event.metaKey || event.shiftKey)
        ? new Set(state.selected)
        : new Set();
    });

    list.addEventListener('pointermove', event => {
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!box && Math.hypot(dx, dy) < 6) return;
      if (!box) {
        box = document.createElement('div');
        box.className = 'marquee-box';
        document.body.appendChild(box);
        list.classList.add('is-marquee');
        try { list.setPointerCapture(event.pointerId); } catch (err) { }
      }
      const left = Math.min(start.x, event.clientX);
      const top = Math.min(start.y, event.clientY);
      const width = Math.abs(dx);
      const height = Math.abs(dy);
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.width = width + 'px';
      box.style.height = height + 'px';

      const right = left + width;
      const bottom = top + height;
      const next = new Set(base);
      list.querySelectorAll('.file-row[data-id]').forEach(row => {
        const rect = row.getBoundingClientRect();
        if (rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top) {
          next.add(row.dataset.id);
        }
      });
      const changed = next.size !== state.selected.size ||
        Array.from(next).some(id => !state.selected.has(id));
      if (changed) {
        state.selected = next;
        renderFileList();
        updateSelectionUI();
      }
    });

    function finish(event) {
      if (!start) return;
      start = null;
      base = null;
      if (box) {
        box.remove();
        box = null;
      }
      list.classList.remove('is-marquee');
      try { list.releasePointerCapture(event.pointerId); } catch (err) { }
    }

    list.addEventListener('pointerup', finish);
    list.addEventListener('pointercancel', finish);
  }


  function initKeyboard() {
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        if (modalOpen()) {
          closeModal();
          event.preventDefault();
        } else if (state.selected.size) {
          clearSelection();
        }
        return;
      }
      if (modalOpen()) return;

      const active = document.activeElement;
      const controlType = active && active.tagName === 'INPUT' ? String(active.type || '').toLowerCase() : '';
      const typing = !!active && (
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' ||
        active.isContentEditable ||
        (active.tagName === 'INPUT' && ['checkbox', 'radio', 'button', 'submit', 'file'].indexOf(controlType) < 0)
      );
      if (typing) return;

      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAllFiles();
        return;
      }
      if (mod && event.key.toLowerCase() === 'c') {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && selection.toString()) return;
        const links = state.selected.size
          ? collectLinks({ selectedOnly: true })
          : collectLinks({ includeImported: true });
        if (links.length) {
          event.preventDefault();
          copyText(links.join('\r\n'), '已复制 ' + links.length + ' 条链接');
        }
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && state.selected.size) {
        event.preventDefault();
        deleteFiles(Array.from(state.selected));
      }
    });
  }


  function bindEvents() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) schedulePoll(0);
    });
    $$('.seg-btn').forEach(button => {
      button.addEventListener('click', () => switchTab(button.dataset.tab));
    });

    $('#helpBtn').addEventListener('click', openHelp);
    $('#settingsBtn').addEventListener('click', openIntegrations);
    $('#push115LinksBtn').addEventListener('click', push115Links);
    $('#themeBtn').addEventListener('click', cycleTheme);
    $('#importLinkBtn').addEventListener('click', openLinkImport);
    $('#browseServerBtn').addEventListener('click', openServerBrowse);
    $('#logoutBtn').addEventListener('click', logout);

    const fileInput = $('#fileInput');
    const folderInput = $('#folderInput');

    $('#addFilesBtn').addEventListener('click', () => fileInput.click());
    $('#addFolderBtn').addEventListener('click', () => folderInput.click());

    [['#historyList', 'ed2k'], ['#makeHistoryList', 'make']].forEach(([selector, module]) => {
      const list = $(selector);
      if (!list) return;
      list.addEventListener('click', event => {
        const button = event.target.closest('[data-history-add]');
        if (!button) return;
        const ids = String(button.dataset.historyAdd || '').split(',').filter(Boolean);
        promoteHistory(ids, module);
      });
    });
    $('#historyAddAllBtn').addEventListener('click', () => {
      const ids = [];
      historyGroups('ed2k').forEach(group => ids.push.apply(ids, group.files));
      promoteHistory(ids, 'ed2k');
    });
    $('#makeHistoryAddAllBtn').addEventListener('click', () => {
      const ids = [];
      historyGroups('make').forEach(group => ids.push.apply(ids, group.files));
      promoteHistory(ids, 'make');
    });
    $('#makeAddFilesBtn').addEventListener('click', () => {
      state.torrentTouched = false;
      fileInput.click();
    });
    $('#makeAddFolderBtn').addEventListener('click', () => {
      state.torrentTouched = false;
      folderInput.click();
    });

    fileInput.addEventListener('change', event => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (!files.length) return;
      if (state.tab === 'parse') {
        const torrents = files.filter(file => /\.torrent$/i.test(file.name));
        const others = files.filter(file => !/\.torrent$/i.test(file.name));
        if (torrents.length) {
          if (others.length) {
            addItems(others.map(file => ({ file: file, relPath: file.name })), 'parse');
          }
          parseTorrentFiles(torrents);
          return;
        }
      }
      addItems(files.map(file => ({ file: file, relPath: file.name })));
    });

    folderInput.addEventListener('change', event => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (files.length) {
        addItems(files.map(file => ({
          file: file,
          relPath: file.webkitRelativePath || file.name
        })));
      }
    });

    $('#parseFolderInput').addEventListener('change', event => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (!files.length) return;
      const torrents = files.filter(file => /\.torrent$/i.test(file.name));
      const others = files.filter(file => !/\.torrent$/i.test(file.name));
      if (others.length) {
        addItems(others.map(file => ({
          file: file,
          relPath: file.webkitRelativePath || file.name
        })), 'parse');
      }
      if (torrents.length) {
        parseTorrentFiles(torrents);
      } else {
        toast('该文件夹内未找到 .torrent 文件，已加入用于匹配的文件', 'info');
      }
    });

    $('#selectAll').addEventListener('click', event => {
      event.preventDefault();
      const all = moduleFiles('ed2k');
      const allSelected = all.length > 0 && state.selected.size === all.length;
      if (allSelected) state.selected.clear();
      else all.forEach(file => state.selected.add(file.id));
      state.anchorId = null;
      renderFileList();
      updateSelectionUI();
    });

    $('#uploadPauseBtn').addEventListener('click', toggleUploadPause);
    $('#uploadCancelBtn').addEventListener('click', cancelUploads);

    $('#copyAllBtn').addEventListener('click', copyAllLinks);
    $('#exportAllBtn').addEventListener('click', exportAllLinks);
    $('#rehashBtn').addEventListener('click', rehashFiles);
    $('#deleteSelectedBtn').addEventListener('click', () => {
      const ids = state.selected.size
        ? Array.from(state.selected)
        : moduleFiles('ed2k').map(file => file.id);
      if (!ids.length) {
        toast('列表已经是空的', 'warn');
        return;
      }
      deleteFiles(ids);
    });
    $('#ed2kSelectionActions').addEventListener('click', event => {
      const setup = event.target.closest('[data-qb-setup]');
      if (setup) {
        openIntegrations();
        return;
      }
      const push = event.target.closest('[data-qb-push]');
      if (push) pushEd2kToQb(push.dataset.qbPush);
    });

    $('#copyImportedBtn').addEventListener('click', copyImported);
    $('#exportImportedBtn').addEventListener('click', exportImported);
    $('#clearImportedBtn').addEventListener('click', clearImported);

    $('#importedList').addEventListener('click', event => {
      const copyButton = event.target.closest('[data-import-copy]');
      if (copyButton) {
        const item = state.imported[Number(copyButton.dataset.importCopy)];
        if (item) copyText(item.link);
        return;
      }
      const removeButton = event.target.closest('[data-import-remove]');
      if (removeButton) {
        const index = Number(removeButton.dataset.importRemove);
        if (index >= 0 && index < state.imported.length) {
          state.imported.splice(index, 1);
          saveJSON(LS.imported, state.imported);
          savePrefs({ imported: state.imported });
          state.lastImportedSig = '';
          renderImported();
          updateSelectionUI();
          toast('已移除该链接', 'ok');
        }
      }
    });

    $('#fileList').addEventListener('click', event => {
      const folderRow = event.target.closest('.folder-row');
      if (folderRow) {
        const path = folderRow.dataset.folder;
        if (!path) return;
        const actionEl = event.target.closest('[data-act]');
        if (actionEl) {
          const action = actionEl.dataset.act;
          if (action === 'toggle') {
            event.preventDefault();
            if (state.collapsed.has(path)) state.collapsed.delete(path);
            else state.collapsed.add(path);
            renderFileList();
            return;
          }
          if (action === 'copy-folder') {
            event.preventDefault();
            copyFolderLinks(path);
            return;
          }
          if (action === 'export-folder') {
            event.preventDefault();
            exportFolderLinks(path);
            return;
          }
        }
        if (event.target.closest('.checkbox') || event.target.closest('input[type="checkbox"]')) {
          event.preventDefault();
          const files = filesUnderFolder(path);
          const all = files.length > 0 && files.every(file => state.selected.has(file.id));
          toggleFolderSelected(path, !all);
          return;
        }
        if (!event.target.closest('button, a')) {
          if (state.collapsed.has(path)) state.collapsed.delete(path);
          else state.collapsed.add(path);
          renderFileList();
        }
        return;
      }

      const row = event.target.closest('.file-row');
      if (!row) return;
      const id = row.dataset.id;
      if (!id) return;
      const actionEl = event.target.closest('[data-act]');
      if (actionEl) {
        const action = actionEl.dataset.act;
        if (action === 'copy') {
          const file = findFile(id);
          if (file && file.ed2k && file.ed2k.link) copyText(file.ed2k.link);
          return;
        }
        if (action === 'delete') {
          deleteFiles([id]);
          return;
        }
        if (action === 'retry') {
          retryUpload(id);
          return;
        }
      }
      const checkbox = event.target.closest('input[type="checkbox"]');
      if (checkbox) {
        event.preventDefault();
        const next = !state.selected.has(id);
        if (event.shiftKey) rangeSelect(id, next);
        else setSelected(id, next);
        return;
      }
      if (!event.target.closest('button, a, label, input')) {
        if (event.shiftKey) rangeSelect(id, true);
        else setSelected(id, !state.selected.has(id));
      }
    });

    $('#makeBrowseBtn').addEventListener('click', () => openServerBrowse({ module: 'make' }));
    $('#makeHistoryBtn').addEventListener('click', openTorrentHistory);
    $('#parseBrowseBtn').addEventListener('click', () => openServerBrowse({ mode: 'torrents' }));
    $('#parseAddFolderBtn').addEventListener('click', () => $('#parseFolderInput').click());
    $('#parseAddFilesBtn').addEventListener('click', () => fileInput.click());

    $('#editPickBtn').addEventListener('click', () => $('#editInput').click());
    $('#editBrowseBtn').addEventListener('click', () => openServerBrowse({
      mode: 'torrents',
      onPick: files => loadEditorFiles(files)
    }));
    $('#editInput').addEventListener('change', event => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (files.length) loadEditorFiles(files);
    });
    $('#editSelectAll').addEventListener('click', () => {
      if (state.editorSelected.size) state.editorSelected.clear();
      else state.editorTorrents.forEach(entry => state.editorSelected.add(entry.key));
      renderEditor();
    });
    $('#editSelectNone').addEventListener('click', () => {
      state.editorSelected.clear();
      renderEditor();
    });
    $('#editRemoveBtn').addEventListener('click', () => {
      if (!state.editorTorrents.length) {
        toast('列表已经是空的', 'warn');
        return;
      }
      if (state.editorSelected.size) {
        const removed = state.editorSelected.size;
        state.editorTorrents = state.editorTorrents.filter(entry => !state.editorSelected.has(entry.key));
        state.editorSelected.clear();
        toast('已移除 ' + removed + ' 个种子', 'ok');
      } else {
        state.editorTorrents = [];
        state.editorSelected.clear();
        toast('已清空已载入列表', 'ok');
      }
      state.editorEntryKey = '';
      state.editorTreeSelected = null;
      state.editorRawKey = '';
      state.editorTab = 'summary';
      renderEditor();
    });
    $$('.edit-tab').forEach(button => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        switchEditorTab(button.dataset.editTab);
      });
    });
    $('#editFilesBody').addEventListener('change', event => {
      const input = event.target.closest('[data-edit-path]');
      if (!input) return;
      const entry = editorEntry();
      if (!entry) return;
      const index = Number(input.dataset.editPath);
      const files = Array.isArray(entry.info.files) ? entry.info.files : [];
      if (!files[index]) return;
      const value = input.value.trim().replace(/\\/g, '/');
      if (!value) {
        input.value = files[index].path || '';
        toast('文件路径不能为空', 'warn');
        return;
      }
      files[index].path = value;
      toast('文件路径已修改，点击保存后生效', 'info');
    });
    $('#editRootName').addEventListener('input', () => {
      const entry = editorEntry();
      if (!entry) return;
      entry.info.name = $('#editRootName').value;
      $('#editName').value = entry.info.name;
    });
    $('#editRawText').addEventListener('input', () => {
      state.editorRawDirty = true;
      updateRawGutter();
    });
    $('#editRawText').addEventListener('scroll', () => {
      const textarea = $('#editRawText');
      const gutter = $('#editRawGutter');
      if (textarea && gutter) gutter.scrollTop = textarea.scrollTop;
    });
    $('#editTreeAdd').addEventListener('click', () => {
      const entry = editorEntry();
      if (!entry) return;
      const path = state.editorTreeSelected || [];
      const node = treeNodeAt(entry, path);
      if (Array.isArray(node)) {
        node.push('');
        state.editorTreeExpanded.add(treePathKey(path));
        renderEditorTree();
        return;
      }
      if (node && typeof node === 'object' && treeNodeType(node) === 'dict') {
        const key = String((window.prompt('新键名称') || '')).trim();
        if (!key) return;
        if (Object.prototype.hasOwnProperty.call(node, key)) {
          toast('该键名已存在', 'warn');
          return;
        }
        node[key] = '';
        state.editorTreeExpanded.add(treePathKey(path));
        renderEditorTree();
        return;
      }
      toast('请先选中一个字典或列表节点', 'warn');
    });
    $('#editTreeDelete').addEventListener('click', () => {
      const entry = editorEntry();
      const path = state.editorTreeSelected;
      if (!entry || !path || !path.length) {
        toast('请先选中要删除的节点（根节点不可删除）', 'warn');
        return;
      }
      const parent = treeNodeAt(entry, path.slice(0, -1));
      const key = path[path.length - 1];
      if (Array.isArray(parent)) parent.splice(key, 1);
      else if (parent && typeof parent === 'object') delete parent[key];
      state.editorTreeSelected = null;
      renderEditorTree();
    });
    $('#editTree').addEventListener('click', event => {
      const entry = editorEntry();
      if (!entry) return;
      const del = event.target.closest('[data-tree-del]');
      if (del) {
        const row = state.editorTreeRows[Number(del.dataset.treeDel)];
        if (!row || !row.path.length) return;
        const parent = treeNodeAt(entry, row.path.slice(0, -1));
        const key = row.path[row.path.length - 1];
        if (Array.isArray(parent)) parent.splice(key, 1);
        else if (parent && typeof parent === 'object') delete parent[key];
        state.editorTreeSelected = null;
        renderEditorTree();
        return;
      }
      const toggle = event.target.closest('[data-tree-toggle]');
      if (toggle) {
        const row = state.editorTreeRows[Number(toggle.dataset.treeToggle)];
        if (!row) return;
        const key = treePathKey(row.path);
        if (state.editorTreeExpanded.has(key)) state.editorTreeExpanded.delete(key);
        else state.editorTreeExpanded.add(key);
        renderEditorTree();
        return;
      }
      if (event.target.closest('input, button')) return;
      const rowEl = event.target.closest('[data-tree-row]');
      if (!rowEl) return;
      const row = state.editorTreeRows[Number(rowEl.dataset.treeRow)];
      if (!row) return;
      state.editorTreeSelected = row.path;
      renderEditorTree();
    });
    $('#editTree').addEventListener('change', event => {
      const entry = editorEntry();
      if (!entry) return;
      const keyInput = event.target.closest('[data-tree-key]');
      if (keyInput) {
        const row = state.editorTreeRows[Number(keyInput.dataset.treeKey)];
        if (!row) return;
        const newKey = keyInput.value.trim();
        const parent = treeNodeAt(entry, row.path.slice(0, -1));
        if (!newKey || !parent || Array.isArray(parent)) {
          keyInput.value = row.key;
          return;
        }
        if (Object.prototype.hasOwnProperty.call(parent, newKey)) {
          toast('该键名已存在', 'warn');
          keyInput.value = row.key;
          return;
        }
        const entries = Object.keys(parent).map(key => [key, parent[key]]);
        Object.keys(parent).forEach(key => delete parent[key]);
        entries.forEach(pair => {
          parent[pair[0] === String(row.key) ? newKey : pair[0]] = pair[1];
        });
        const nextPath = row.path.slice(0, -1).concat(newKey);
        const oldPrefix = treePathKey(row.path);
        const remapped = new Set();
        state.editorTreeExpanded.forEach(saved => {
          const parts = JSON.parse(saved);
          if (parts.length >= row.path.length && treePathKey(parts.slice(0, row.path.length)) === oldPrefix) {
            remapped.add(treePathKey(nextPath.concat(parts.slice(row.path.length))));
          } else {
            remapped.add(saved);
          }
        });
        state.editorTreeExpanded = remapped;
        state.editorTreeSelected = nextPath;
        renderEditorTree();
        return;
      }
      const valueInput = event.target.closest('[data-tree-value]');
      if (!valueInput) return;
      const row = state.editorTreeRows[Number(valueInput.dataset.treeValue)];
      if (!row) return;
      const parent = treeNodeAt(entry, row.path.slice(0, -1));
      const key = row.path[row.path.length - 1];
      if (!parent) return;
      if (row.type === 'int') {
        const number = Number(valueInput.value);
        if (!Number.isInteger(number)) {
          toast('整数格式无效', 'warn');
          valueInput.value = String(parent[key]);
          return;
        }
        parent[key] = number;
      } else {
        parent[key] = valueInput.value;
      }
      renderEditorTree();
    });
    $('#editTrackers').addEventListener('input', updateEditTrackerCount);
    $('#editSaveBtn').addEventListener('click', saveEditedTorrents);
    $('#editList').addEventListener('click', event => {
      const removeBtn = event.target.closest('[data-edit-remove]');
      if (removeBtn) {
        const key = removeBtn.dataset.editRemove;
        const index = state.editorTorrents.findIndex(entry => entry.key === key);
        if (index >= 0) state.editorTorrents.splice(index, 1);
        state.editorSelected.delete(key);
        renderEditor();
        return;
      }
      const row = event.target.closest('[data-edit-key]');
      if (!row) return;
      const key = row.dataset.editKey;
      if (state.editorSelected.has(key)) state.editorSelected.delete(key);
      else state.editorSelected.add(key);
      renderEditor();
    });

    $('#torrentPicker').addEventListener('click', event => {
      const folderRow = event.target.closest('.picker-row[data-folder]');
      if (folderRow) {
        const path = folderRow.dataset.folder;
        if (event.target.closest('[data-act="toggle-folder"]')) {
          event.preventDefault();
          toggleTorrentFolder(path);
          return;
        }
        if (event.target.closest('.checkbox') || event.target.closest('input')) {
          event.preventDefault();
          toggleTorrentFolderSelected(path);
          return;
        }
        toggleTorrentFolder(path);
        return;
      }
      if (event.target.closest('.checkbox') || event.target.closest('input')) return;
      const row = event.target.closest('.picker-row');
      if (!row) return;
      const id = row.dataset.id;
      if (!id) return;
      state.torrentTouched = true;
      if (state.torrentSelected.has(id)) state.torrentSelected.delete(id);
      else state.torrentSelected.add(id);
      state.pickerSig = '';
      renderTorrentPicker();
    });

    $('#torrentPicker').addEventListener('change', event => {
      const folderCheckbox = event.target.closest('input[data-folder-pick]');
      if (folderCheckbox) {
        toggleTorrentFolderSelected(folderCheckbox.dataset.folderPick);
        return;
      }
      const checkbox = event.target.closest('input[data-pick]');
      if (!checkbox) return;
      state.torrentTouched = true;
      const id = checkbox.dataset.pick;
      if (checkbox.checked) state.torrentSelected.add(id);
      else state.torrentSelected.delete(id);
      state.pickerSig = '';
      renderTorrentPicker();
    });

    $('#torrentSelectAll').addEventListener('click', () => {
      state.torrentTouched = true;
      const complete = moduleFiles('make').filter(file => file.complete);
      const anySelected = complete.some(file => state.torrentSelected.has(file.id));
      if (anySelected) state.torrentSelected.clear();
      else complete.forEach(file => state.torrentSelected.add(file.id));
      state.pickerSig = '';
      renderTorrentPicker();
    });

    $('#torrentRemoveBtn').addEventListener('click', async () => {
      const list = moduleFiles('make');
      if (!list.length) {
        toast('列表已经是空的', 'warn');
        return;
      }
      const ids = state.torrentSelected.size
        ? Array.from(state.torrentSelected)
        : list.map(file => file.id);
      await deleteFiles(ids);
      state.torrentTouched = false;
      state.pickerSig = '';
      renderTorrentPicker();
    });

    $('#generateTorrentBtn').addEventListener('click', generateTorrent);
    $('#fetchTrackersBtn').addEventListener('click', () => fetchPublicTrackers({ force: true }));

    $('#parseBarCopy').addEventListener('click', () => {
      const links = parseSelectedLinks();
      if (!links.length) {
        toast('请先选择要复制的链接', 'warn');
        return;
      }
      copyText(links.join('\r\n'), '已复制 ' + links.length + ' 条链接');
    });
    $('#parseBarExport').addEventListener('click', () => {
      const links = parseSelectedLinks();
      if (!links.length) return;
      downloadText(links.join('\r\n') + '\r\n', 'ed2k-from-torrent-' + stamp() + '.txt');
      toast('已导出 ' + links.length + ' 条链接', 'ok');
    });
    $('#parseBarPush115').addEventListener('click', () => {
      const available = parsePushableItems();
      const picked = available.filter(item => state.parseSelected.has(item.key));
      open115ParsePush(picked.length ? picked : available);
    });

    ['#torrentTrackers', '#torrentPiece', '#torrentPrivate', '#torrentEmbedEd2k'].forEach(selector => {
      $(selector).addEventListener('change', saveTorrentOptions);
      $(selector).addEventListener('change', scheduleEstimate);
    });
    $('#torrentTrackers').addEventListener('input', saveTorrentOptions);
    ['#torrentTrackers', '#torrentName', '#torrentComment'].forEach(selector => {
      $(selector).addEventListener('input', scheduleEstimate);
    });


    (function initPieceSelect() {
      const wrap = $('#torrentPieceMenu');
      if (!wrap) return;
      const trigger = $('#torrentPieceBtn', wrap);
      const pop = $('#torrentPiecePop', wrap);

      document.body.appendChild(pop);
      const position = () => {
        const rect = trigger.getBoundingClientRect();
        const gap = 6;
        const below = window.innerHeight - rect.bottom - gap - 12;
        const above = rect.top - gap - 12;
        const openUp = below < 160 && above > below;
        const height = Math.max(120, Math.min(264, openUp ? above : below));
        pop.style.left = Math.round(rect.left) + 'px';
        pop.style.width = Math.round(rect.width) + 'px';
        pop.style.maxHeight = Math.round(height) + 'px';
        if (openUp) {
          pop.style.top = 'auto';
          pop.style.bottom = Math.round(window.innerHeight - rect.top + gap) + 'px';
        } else {
          pop.style.bottom = 'auto';
          pop.style.top = Math.round(rect.bottom + gap) + 'px';
        }
      };
      const close = () => {
        if (pop.hidden) return;
        pop.hidden = true;
        wrap.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
      };
      const open = () => {
        position();
        pop.hidden = false;
        wrap.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
        const active = $('.select-option.is-active', pop) || $('.select-option', pop);
        if (active) active.scrollIntoView({ block: 'nearest' });
      };
      trigger.addEventListener('click', () => {
        if (pop.hidden) open();
        else close();
      });
      pop.addEventListener('click', event => {
        const option = event.target.closest('.select-option');
        if (!option) return;
        setPieceSize(Number(option.dataset.value));
        $('#torrentPiece').dispatchEvent(new Event('change', { bubbles: true }));
        close();
        trigger.focus();
      });
      document.addEventListener('click', event => {
        if (wrap.contains(event.target) || pop.contains(event.target)) return;
        close();
      });
      window.addEventListener('resize', () => { if (!pop.hidden) position(); });
      window.addEventListener('scroll', () => { if (!pop.hidden) position(); }, true);
      wrap.addEventListener('keydown', handlePieceKey);
      pop.addEventListener('keydown', handlePieceKey);
      function handlePieceKey(event) {
        if (event.key === 'Escape') {
          close();
          trigger.focus();
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        if (pop.hidden) {
          open();
          return;
        }
        const options = $$('.select-option', pop);
        const current = options.indexOf(document.activeElement);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = current < 0 ? (step > 0 ? 0 : options.length - 1) : current + step;
        if (options[next]) options[next].focus();
      }
    })();
    $('#torrentPrivate').addEventListener('change', () => {
      if (!$('#torrentPrivate').checked) maybeAutoLoadTrackers();
    });
    $('#torrentEmbedEd2k').addEventListener('change', () => {
      updateTorrentButtons();
    });

    $('#torrentImportResult').addEventListener('click', event => {
      const parseCopy = event.target.closest('[data-parse-copy]');
      if (parseCopy) {
        const item = buildParseItems().find(entry => entry.key === parseCopy.dataset.parseCopy);
        if (item && item.link) copyText(item.link);
        return;
      }
      const parseRow = event.target.closest('.picker-row[data-parse-key]');
      if (parseRow && !event.target.closest('button, label, input')) {
        const key = parseRow.dataset.parseKey;
        const item = buildParseItems().find(entry => entry.key === key);
        if (!item || !item.link) return;
        const picked = !state.parseSelected.has(key);
        if (picked) state.parseSelected.add(key);
        else state.parseSelected.delete(key);
        parseRow.classList.toggle('is-selected', picked);
        const label = parseRow.querySelector('.checkbox');
        if (label) label.classList.toggle('is-checked', picked);
        const box = parseRow.querySelector('.parse-check');
        if (box) box.checked = picked;
        updateParsePushUI();
        return;
      }
      const copyButton = event.target.closest('[data-copy-idx]');
      if (copyButton) {
        const index = Number(copyButton.dataset.copyIdx);
        const item = state.torrentImport && state.torrentImport.matched_files[index];
        if (item) {
          const link = getFileLink(item.file_id);
          if (link) copyText(link);
          else toast('该文件尚未生成链接', 'warn');
        }
        return;
      }
      const embeddedButton = event.target.closest('[data-embedded-idx]');
      if (embeddedButton) {
        const index = Number(embeddedButton.dataset.embeddedIdx);
        const items = state.torrentImport && state.torrentImport.embedded_links;
        const item = Array.isArray(items) ? items[index] : null;
        if (item && item.link) copyText(item.link);
        return;
      }
      const actionButton = event.target.closest('[data-action]');
      if (!actionButton) return;
      const action = actionButton.dataset.action;
      if (action === 'hash') {
        hashMatchedFiles();
        return;
      }
      if (action === 'push-qb') {
        const server = ((state.integrations && state.integrations.qb_servers) || [])
          .find(item => item.id === actionButton.dataset.server);
        if (!server) {
          toast('该 qBittorrent 服务器已不存在，请重新打开设置保存后再试', 'warn');
          return;
        }
        openParseQbPush(server);
        return;
      }
      if (action === 'parse-all' || action === 'parse-none') {
        state.parseSelected = action === 'parse-all'
          ? new Set(parsePushableItems().map(item => item.key))
          : new Set();
        renderTorrentImport(true);
        updateSelectionUI();
        return;
      }
      if (action === 'magnet') {
        const index = Number(actionButton.dataset.magnet || 0);
        const entry = currentImports()[index];
        if (entry) copyText(magnetForTorrent(entry.info), '已复制磁力链');
        return;
      }
    });

    $('#torrentImportResult').addEventListener('change', event => {
      const box = event.target.closest('.parse-check');
      if (!box) return;
      if (box.checked) state.parseSelected.add(box.dataset.pick);
      else state.parseSelected.delete(box.dataset.pick);
      const row = box.closest('.picker-row');
      if (row) {
        row.classList.toggle('is-selected', box.checked);
        const label = row.querySelector('.checkbox');
        if (label) label.classList.toggle('is-checked', box.checked);
      }
      updateParsePushUI();
    });

    document.addEventListener('click', event => {
      const pushButton = event.target.closest('[data-push]');
      if (pushButton) {
        const job = state.jobs.find(item => item.id === state.torrentJobId);
        if (!job) return;
        if (pushButton.dataset.push === 'qb') {
          const serverId = pushButton.dataset.server || '';
          const server = (state.integrations.qb_servers || []).find(item => item.id === serverId) || null;
          openQbPush(job, server);
        } else {
          open115Push(job);
        }
        return;
      }
      const magnetButton = event.target.closest('[data-copy-magnet]');
      if (magnetButton) {
        copyText(magnetButton.dataset.copyMagnet, '已复制磁力链');
      }
    });
  }


  function init() {
    try { $('#folderInput').webkitdirectory = true; } catch (err) { }
    applyTheme(themeMode(), false);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onSchemeChange = () => {
      if (themeMode() === 'system') applyTheme('system', false);
    };
    if (media.addEventListener) media.addEventListener('change', onSchemeChange);
    else if (media.addListener) media.addListener(onSchemeChange);
    loadTorrentOptions();
    loadPrefs();
    bindEvents();
    initMarquee();
    initKeyboard();
    renderAll();
    loadIntegrations();
    api('/api/auth').then(data => {
      if (data && data.required && data.authed) {
        const button = $('#logoutBtn');
        if (button) button.hidden = false;
      }
    }).catch(() => { });
    refresh().then(() => schedulePoll());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
