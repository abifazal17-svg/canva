/* ─── DesignCraft App.js ─────────────────────────────────────────────────── */
'use strict';

// ─── Global State ─────────────────────────────────────────────────────────
const App = {
  token: localStorage.getItem('dc_token'),
  user: JSON.parse(localStorage.getItem('dc_user') || 'null'),
  currentDesignId: null,
  isAdminMode: false,
  texts: [],
  selectedTextId: null,
  undoStack: [],
  imageUrl: null,
  canvasW: 800,
  canvasH: 600,
  customFonts: [],
  searchTimer: null,
  shareTarget: null,
  clientFormValues: {},
  clientDesignData: null,
  dragState: null,
  resizeState: null,
};

// ─── View State (Zoom + Pan) ──────────────────────────────────────────
const ViewState = {
  admin:  { zoom: 1, panX: 60, panY: 60 },
  client: { zoom: 1, panX: 60, panY: 60 },
  pinchDist: null,
  pinchTouchPanStart: null,   // {x,y,panX,panY}
  spacePanning: false,        // true while Space is held
};

// Keep these aliases so old callers (buttons, keyboard) still work
const ZoomState = { get admin(){ return ViewState.admin.zoom; }, get client(){ return ViewState.client.zoom; } };

/* ─ Core view appliers ─ */
function applyAdminView() {
  const { zoom, panX, panY } = ViewState.admin;
  const c = document.getElementById('canvas-container');
  if (c) c.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
  _setZoomDisplay('admin-zoom-display', zoom);
}
function applyClientView() {
  const { zoom, panX, panY } = ViewState.client;
  const c = document.getElementById('client-canvas-container');
  if (!c) return;

  if (window.innerWidth <= 768) {
    // Mobile: scale from top-center so canvas expands downward naturally.
    // No translate — page scroll handles vertical movement.
    c.style.transformOrigin = 'top center';
    c.style.transform = zoom === 1 ? 'none' : `scale(${zoom})`;
    // When zoomed, expand the wrapper so the page can still scroll to see full canvas
    const wrapper = document.getElementById('client-canvas-wrapper');
    if (wrapper) {
      if (zoom > 1) {
        const canvasEl = document.getElementById('client-canvas');
        const naturalH = canvasEl ? canvasEl.offsetHeight : 0;
        wrapper.style.paddingBottom = `${naturalH * (zoom - 1)}px`;
      } else {
        wrapper.style.paddingBottom = '';
      }
    }
  } else {
    c.style.transformOrigin = '0 0';
    c.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
  }
  _setZoomDisplay('client-zoom-display', zoom);
}
function _setZoomDisplay(id, z) {
  const el = document.getElementById(id);
  if (el) el.textContent = Math.round(z * 100) + '%';
}

/* ─ Zoom at a screen point (keeps that point fixed on the canvas) ─ */
function zoomAtPoint(dz, clientX, clientY, mode) {
  const vs  = ViewState[mode];
  const oid = mode === 'admin' ? 'canvas-outer' : 'client-canvas-outer';
  const outer = document.getElementById(oid);
  if (!outer) return;
  const rect = outer.getBoundingClientRect();
  const ox = clientX - rect.left;   // offset inside outer
  const oy = clientY - rect.top;
  // Canvas coords under cursor
  const cx = (ox - vs.panX) / vs.zoom;
  const cy = (oy - vs.panY) / vs.zoom;
  const newZ = Math.max(0.05, Math.min(8, vs.zoom + dz));
  vs.panX = ox - cx * newZ;
  vs.panY = oy - cy * newZ;
  vs.zoom = newZ;
  if (mode === 'admin') applyAdminView(); else applyClientView();
}

/* ─ Centre-zoom (for toolbar buttons) ─ */
function _zoomCenter(delta, mode) {
  const oid = mode === 'admin' ? 'canvas-outer' : 'client-canvas-outer';
  const outer = document.getElementById(oid);
  if (!outer) return;
  const r = outer.getBoundingClientRect();
  zoomAtPoint(delta, r.left + r.width / 2, r.top + r.height / 2, mode);
}
function adjustAdminZoom(d)  { _zoomCenter(d, 'admin');  }
function adjustClientZoom(d) { _zoomCenter(d, 'client'); }
function resetAdminZoom()  { _centerCanvas('admin');  }
function resetClientZoom() { _centerCanvas('client'); }

function _centerCanvas(mode) {
  // On mobile, client canvas uses natural CSS flow — no JS transform needed
  if (mode === 'client' && window.innerWidth <= 768) {
    ViewState.client.zoom = 1;
    ViewState.client.panX = 0;
    ViewState.client.panY = 0;
    applyClientView();
    return;
  }
  const outer = document.getElementById(mode === 'admin' ? 'canvas-outer' : 'client-canvas-outer');
  if (!outer) return;
  const r = outer.getBoundingClientRect();
  const cw = mode === 'admin' ? App.canvasW : (App.clientDesignData?.image_width  || 800);
  const ch = mode === 'admin' ? App.canvasH : (App.clientDesignData?.image_height || 600);
  ViewState[mode].zoom = 1;
  ViewState[mode].panX = Math.max(0, (r.width  - cw) / 2);
  ViewState[mode].panY = Math.max(0, (r.height - ch) / 2);
  if (mode === 'admin') applyAdminView(); else applyClientView();
}

/* ─ Pan helpers ─ */
function _setPanCursor(outer, state) {
  outer.classList.toggle('pan-ready',  state === 'ready');
  outer.classList.toggle('is-panning', state === 'panning');
}

function getPinchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

/* ─ Wire up wheel, middle-mouse drag, space+drag, touch pinch/pan ─ */
function _bindPanZoom(outerId, mode) {
  const outer = document.getElementById(outerId);
  if (!outer || outer._pzBound) return;
  outer._pzBound = true;

  // ─ Mouse wheel: Ctrl = zoom at cursor, plain = pan ─
  outer.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const dz = e.deltaY < 0 ? 0.12 : -0.12;
      zoomAtPoint(ViewState[mode].zoom * dz, e.clientX, e.clientY, mode);
    } else {
      const dx = e.shiftKey ? -e.deltaY : -e.deltaX;
      const dy = e.shiftKey ? 0 : -e.deltaY;
      ViewState[mode].panX += dx;
      ViewState[mode].panY += dy;
      if (mode === 'admin') applyAdminView(); else applyClientView();
    }
  }, { passive: false });

  // ─ Mouse: Space+drag OR middle-mouse drag = pan ─
  outer.addEventListener('mousedown', e => {
    const isMiddle = e.button === 1;
    const isSpace  = ViewState.spacePanning;
    if (!isMiddle && !isSpace) return;
    e.preventDefault();
    const vs = ViewState[mode];
    const sx = e.clientX, sy = e.clientY;
    const spx = vs.panX,   spy = vs.panY;
    _setPanCursor(outer, 'panning');
    const onMove = e2 => {
      vs.panX = spx + (e2.clientX - sx);
      vs.panY = spy + (e2.clientY - sy);
      if (mode === 'admin') applyAdminView(); else applyClientView();
    };
    const onUp = () => {
      _setPanCursor(outer, ViewState.spacePanning ? 'ready' : '');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // ─ Touch: 2-finger pinch = zoom, 1-finger (when zoomed) = pan ─
  let touchPanStart = null;
  outer.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      ViewState.pinchDist = getPinchDist(e.touches);
      touchPanStart = null;       // cancel single-finger pan
    } else if (e.touches.length === 1) {
      if (ViewState[mode].zoom > 1.02) {
        // Only pan if actually zoomed in
        touchPanStart = {
          x: e.touches[0].clientX, y: e.touches[0].clientY,
          panX: ViewState[mode].panX, panY: ViewState[mode].panY,
        };
      } else {
        touchPanStart = null;
      }
    }
  }, { passive: true });

  outer.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && ViewState.pinchDist !== null) {
      // ── Pinch zoom: always intercept (2-finger gesture) ──
      e.preventDefault();
      const dist = getPinchDist(e.touches);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const ratio = dist / ViewState.pinchDist;
      const dz = (ratio - 1) * ViewState[mode].zoom;
      zoomAtPoint(dz, midX, midY, mode);
      ViewState.pinchDist = dist;
    } else if (e.touches.length === 1 && touchPanStart) {
      // ── Single-finger pan (only when zoomed in) ──
      // On mobile client mode: don't preventDefault so page can still scroll.
      // On admin mode or desktop: prevent default to enable canvas pan.
      const isMobileClient = (mode === 'client' && window.innerWidth <= 768);
      if (!isMobileClient) e.preventDefault();
      const dx = e.touches[0].clientX - touchPanStart.x;
      const dy = e.touches[0].clientY - touchPanStart.y;
      if (mode === 'admin') {
        ViewState[mode].panX = touchPanStart.panX + dx;
        ViewState[mode].panY = touchPanStart.panY + dy;
        applyAdminView();
      } else {
        // Mobile client: only allow horizontal pan (vertical = page scroll)
        ViewState[mode].panX = touchPanStart.panX + dx;
        applyClientView();
      }
    }
    // Single-finger on client mobile without touchPanStart: do nothing,
    // let the browser handle page scroll naturally.
  }, { passive: false });

  outer.addEventListener('touchend', e => {
    if (e.touches.length < 2) ViewState.pinchDist = null;
    if (e.touches.length === 0) touchPanStart = null;
  });
}

function initCanvasZoom()       { _bindPanZoom('canvas-outer',        'admin');  }
function initClientCanvasZoom() { _bindPanZoom('client-canvas-outer', 'client'); }

// Expose old names that keyboard / buttons still call
function applyAdminZoom(z)  { ViewState.admin.zoom  = Math.max(0.05, Math.min(8, z)); applyAdminView();  }
function applyClientZoom(z) { ViewState.client.zoom = Math.max(0.05, Math.min(8, z)); applyClientView(); }


// ─── API Helper ────────────────────────────────────────────────────────────
async function api(method, path, body = null, isFormData = false) {
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${App.token}` }
  };
  if (body && !isFormData) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body && isFormData) {
    opts.body = body;
  }
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─── Toast ─────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ─── Page Navigation ───────────────────────────────────────────────────────
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('active');
    p.classList.add('hidden');
  });
  const page = document.getElementById(pageId);
  if (page) {
    page.classList.remove('hidden');
    page.classList.add('active');
  }
}

function togglePw(inputId, btn) {
  const input = document.getElementById(inputId);
  input.type = input.type === 'password' ? 'text' : 'password';
  btn.textContent = input.type === 'password' ? '👁' : '🙈';
}
function showRegister() { document.getElementById('login-form').classList.add('hidden'); document.getElementById('register-form').classList.remove('hidden'); }
function showLogin() { document.getElementById('register-form').classList.add('hidden'); document.getElementById('login-form').classList.remove('hidden'); }

// ─── Auth ──────────────────────────────────────────────────────────────────
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  if (!email || !password) { errEl.textContent = 'Email dan password harus diisi'; errEl.classList.remove('hidden'); return; }
  try {
    showLoader('Masuk...');
    const data = await api('POST', '/api/auth/login', { email, password });
    App.token = data.token;
    App.user = data.user;
    localStorage.setItem('dc_token', data.token);
    localStorage.setItem('dc_user', JSON.stringify(data.user));
    hideLoader();
    navigateByRole();
  } catch (err) {
    hideLoader();
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

async function doRegister() {
  const username = document.getElementById('reg-username').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const errEl = document.getElementById('reg-error');
  errEl.classList.add('hidden');
  if (!username || !email || !password) { errEl.textContent = 'Semua field harus diisi'; errEl.classList.remove('hidden'); return; }
  if (password.length < 6) { errEl.textContent = 'Password minimal 6 karakter'; errEl.classList.remove('hidden'); return; }
  try {
    showLoader('Membuat akun...');
    const data = await api('POST', '/api/auth/register', { username, email, password });
    App.token = data.token;
    App.user = data.user;
    localStorage.setItem('dc_token', data.token);
    localStorage.setItem('dc_user', JSON.stringify(data.user));
    hideLoader();
    navigateByRole();
    toast('Akun berhasil dibuat!', 'success');
  } catch (err) {
    hideLoader();
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

function doLogout() {
  App.token = null; App.user = null;
  localStorage.removeItem('dc_token'); localStorage.removeItem('dc_user');
  showPage('page-auth'); showLogin();
}

function navigateByRole() {
  if (App.user?.role === 'admin') {
    document.getElementById('sidebar-username').textContent = App.user.username;
    document.getElementById('sidebar-avatar').textContent = App.user.username[0].toUpperCase();
    showPage('page-admin-dashboard');
    adminShowDesigns();
  } else {
    document.getElementById('client-sidebar-username').textContent = App.user?.username || 'Client';
    document.getElementById('client-sidebar-avatar').textContent = (App.user?.username || 'C')[0].toUpperCase();
    showPage('page-client-dashboard');
    loadClientDesigns();
  }
}

// ─── Loader ────────────────────────────────────────────────────────────────
function showLoader(text = 'Memuat...') {
  document.getElementById('loader-text').textContent = text;
  document.getElementById('page-loader').classList.remove('hidden');
}
function hideLoader() { document.getElementById('page-loader').classList.add('hidden'); }

// ─── Admin Dashboard ───────────────────────────────────────────────────────
function adminShowDesigns() {
  document.getElementById('admin-designs-section').classList.remove('hidden');
  document.getElementById('admin-fonts-section').classList.add('hidden');
  document.getElementById('admin-database-section')?.classList.add('hidden');
  setActiveNav('nav-designs');
  loadAdminDesigns();
}

function adminShowFonts() {
  document.getElementById('admin-designs-section').classList.add('hidden');
  document.getElementById('admin-fonts-section').classList.remove('hidden');
  document.getElementById('admin-database-section')?.classList.add('hidden');
  setActiveNav('nav-fonts');
  loadFonts();
}

function adminShowDatabase() {
  document.getElementById('admin-designs-section').classList.add('hidden');
  document.getElementById('admin-fonts-section').classList.add('hidden');
  document.getElementById('admin-database-section')?.classList.remove('hidden');
  setActiveNav('nav-database');
  loadDatabaseStats();
}

// ─── Database Backup, Export & Restore (Admin) ─────────────────────────────
async function loadDatabaseStats() {
  const infoEl = document.getElementById('db-server-info');
  try {
    const data = await api('GET', '/api/admin/db/stats');
    const c = data.counts || {};
    document.getElementById('db-stat-designs').textContent        = c.designs ?? 0;
    document.getElementById('db-stat-users').textContent          = c.users ?? 0;
    document.getElementById('db-stat-shares').textContent         = c.design_shares ?? 0;
    document.getElementById('db-stat-client-designs').textContent = c.client_designs ?? 0;
    document.getElementById('db-stat-fonts').textContent          = c.fonts ?? 0;
    if (infoEl) {
      infoEl.innerHTML = `Terhubung ke Database Server: <strong>${escHtml(data.host || '-')}</strong> &bull; Nama DB: <strong>${escHtml(data.database || '-')}</strong>`;
    }
  } catch (err) {
    if (infoEl) infoEl.textContent = 'Gagal memuat status database: ' + err.message;
  }
}

async function downloadDatabaseBackup(format = 'json') {
  const isSql = format === 'sql';
  const endpoint = isSql ? '/api/admin/db/export-sql' : '/api/admin/db/export-json';
  showLoader(isSql ? 'Menyiapkan ekspor SQL database...' : 'Menyiapkan full backup database...');
  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${App.token}` }
    });
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try { const j = await res.json(); errMsg = j.error || errMsg; } catch (_) {}
      throw new Error(errMsg);
    }
    const blob = await res.blob();
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = isSql
      ? `designcraft-database-${dateStr}.sql`
      : `designcraft-backup-${dateStr}.json`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    hideLoader();
    toast(`File ${filename} berhasil diunduh!`, 'success');
  } catch (err) {
    hideLoader();
    toast('Gagal mengunduh database: ' + err.message, 'error');
  }
}

let selectedRestoreFile = null;
function handleRestoreFileSelect(event) {
  const file = event.target.files?.[0] || null;
  selectedRestoreFile = file;
  const infoEl = document.getElementById('db-restore-file-info');
  if (!infoEl) return;
  if (!file) {
    infoEl.classList.add('hidden');
    infoEl.textContent = '';
    return;
  }
  const sizeKB = (file.size / 1024).toFixed(1);
  const sizeStr = file.size > 1024 * 1024
    ? `${(file.size / (1024 * 1024)).toFixed(2)} MB`
    : `${sizeKB} KB`;
  infoEl.textContent = `File siap di-restore: ${file.name} (${sizeStr})`;
  infoEl.classList.remove('hidden');
}

async function restoreDatabaseFromFile() {
  const fileInput = document.getElementById('db-restore-file');
  const file = selectedRestoreFile || fileInput?.files?.[0];
  if (!file) {
    toast('Pilih file backup (.json atau .sql) terlebih dahulu', 'error');
    return;
  }

  const mode = document.getElementById('db-restore-mode')?.value || 'merge';
  const confirmMsg = mode === 'replace'
    ? `PERINGATAN: Mode "Ganti Seluruh Database" akan menghapus data yang ada di server ini dan menggantinya dengan isi file "${file.name}". Lanjutkan?`
    : `Pulihkan dan gabungkan data dari "${file.name}" ke database server ini?`;

  if (!confirm(confirmMsg)) return;

  showLoader('Memulihkan database ke server...');
  try {
    const rawText = await file.text();
    const isSql = file.name.toLowerCase().endsWith('.sql') || rawText.trim().startsWith('--') || rawText.trim().toUpperCase().startsWith('SET ');

    let payload;
    if (isSql) {
      payload = { mode, sql: rawText };
    } else {
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new Error('File JSON tidak valid atau rusak');
      }
      payload = { mode, backup: parsed };
    }

    const result = await api('POST', '/api/admin/db/import', payload);

    // Update token & user if server refreshed admin credentials from backup
    if (result.token && result.user) {
      App.token = result.token;
      App.user  = result.user;
      localStorage.setItem('dc_token', result.token);
      localStorage.setItem('dc_user', JSON.stringify(result.user));
    }

    hideLoader();
    toast(result.message || 'Database berhasil dipulihkan!', 'success');

    // Reset file input & refresh stats
    selectedRestoreFile = null;
    if (fileInput) fileInput.value = '';
    const infoEl = document.getElementById('db-restore-file-info');
    if (infoEl) infoEl.classList.add('hidden');

    await loadDatabaseStats();
    await loadAllFonts();
  } catch (err) {
    hideLoader();
    toast('Gagal restore database: ' + err.message, 'error');
  }
}

function setActiveNav(activeId) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const el = document.getElementById(activeId);
  if (el) el.classList.add('active');
}

async function loadAdminDesigns() {
  const grid = document.getElementById('admin-designs-grid');
  grid.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Memuat design...</span></div>';
  try {
    const designs = await api('GET', '/api/admin/designs');
    renderDesignGrid(grid, designs, true);
  } catch (err) {
    grid.innerHTML = `<div class="empty-state"><p>Gagal memuat: ${err.message}</p></div>`;
  }
}

function renderDesignGrid(grid, designs, isAdmin) {
  if (!designs.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        <h3>${isAdmin ? 'Belum ada design' : 'Belum ada design yang di-share'}</h3>
        <p>${isAdmin ? 'Klik "Buat Design Baru" untuk mulai' : 'Admin belum membagikan design kepada Anda'}</p>
      </div>`;
    return;
  }
  grid.innerHTML = designs.map(d => buildDesignCard(d, isAdmin)).join('');
}

function buildDesignCard(d, isAdmin) {
  const thumb = d.image_url
    ? `<img src="${d.image_url}" alt="${d.name}" loading="lazy" crossorigin="anonymous">`
    : `<div class="thumb-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><span style="font-size:12px;color:var(--text-muted)">Tanpa gambar</span></div>`;
  const date = new Date(d.created_at || d.updated_at).toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' });
  const formFields = (d.texts || []).filter(t => t.formName).length;

  if (isAdmin) {
    return `<div class="design-card">
      <div class="design-card-thumb">${thumb}</div>
      <div class="design-card-body">
        <div class="design-card-name">${escHtml(d.name)}</div>
        <div class="design-card-meta">
          <span>${date}</span>
          ${formFields > 0 ? `<span class="design-card-badge">${formFields} field form</span>` : ''}
          ${d.share_count > 0 ? `<span class="design-card-badge" style="background:rgba(6,182,212,0.15);color:var(--accent)">${d.share_count} user</span>` : ''}
        </div>
      </div>
      <div class="design-card-actions">
        <button class="btn-icon" onclick="openEditor('${d.id}')" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="btn-icon" onclick="openShareModalFor('${d.id}')" title="Share"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button>
        <button class="btn-icon btn-danger" onclick="deleteDesign('${d.id}')" title="Hapus"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
      </div>
    </div>`;
  } else {
    return `<div class="design-card" onclick="openClientEditor('${d.id}')">
      <div class="design-card-thumb">${thumb}</div>
      <div class="design-card-body">
        <div class="design-card-name">${escHtml(d.name)}</div>
        <div class="design-card-meta">
          <span>${date}</span>
          ${formFields > 0 ? `<span class="design-card-badge">${formFields} field untuk diisi</span>` : ''}
        </div>
      </div>
      <div class="design-card-actions">
        <button class="btn-primary btn-sm" onclick="openClientEditor('${d.id}');event.stopPropagation()">Edit Form</button>
      </div>
    </div>`;
  }
}

async function deleteDesign(id) {
  if (!confirm('Hapus design ini? Semua share akan dihapus juga.')) return;
  try {
    await api('DELETE', `/api/admin/designs/${id}`);
    toast('Design dihapus', 'success');
    loadAdminDesigns();
  } catch (err) { toast(err.message, 'error'); }
}

// ─── Create Design Modal ──────────────────────────────────────────────────
let modalImageFile = null;
function openCreateDesignModal() {
  modalImageFile = null;
  document.getElementById('new-design-name').value = '';
  document.getElementById('new-canvas-width').value = '800';
  document.getElementById('new-canvas-height').value = '600';
  document.getElementById('modal-image-preview').innerHTML = '';
  document.getElementById('modal-image-preview').classList.add('hidden');
  openModal('modal-create-design');
}

function previewModalImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  modalImageFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      document.getElementById('new-canvas-width').value = img.naturalWidth;
      document.getElementById('new-canvas-height').value = img.naturalHeight;
    };
    img.src = e.target.result;
    document.getElementById('modal-image-preview').innerHTML = `<img src="${e.target.result}">`;
    document.getElementById('modal-image-preview').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

async function createNewDesign() {
  const name = document.getElementById('new-design-name').value.trim();
  if (!name) { toast('Masukkan nama design', 'error'); return; }
  const w = parseInt(document.getElementById('new-canvas-width').value) || 800;
  const h = parseInt(document.getElementById('new-canvas-height').value) || 600;

  showLoader('Membuat design...');
  let imageUrl = null;

  try {
    if (modalImageFile) {
      const fd = new FormData();
      fd.append('image', modalImageFile);
      const upRes = await api('POST', '/api/upload/image', fd, true);
      imageUrl = upRes.url;
    }
    const design = await api('POST', '/api/admin/designs', { name, image_url: imageUrl, image_width: w, image_height: h, texts: [] });
    closeModal('modal-create-design');
    hideLoader();
    openEditor(design.id);
  } catch (err) {
    hideLoader();
    toast(err.message, 'error');
  }
}

// ─── Admin Editor ──────────────────────────────────────────────────────────
async function openEditor(designId) {
  showLoader('Memuat editor...');
  try {
    const design = await api('GET', `/api/admin/designs/${designId}`);
    App.currentDesignId = designId;
    App.isAdminMode = true;
    App.texts = design.texts || [];
    App.imageUrl = design.image_url;
    App.canvasW = design.image_width || 800;
    App.canvasH = design.image_height || 600;
    App.undoStack = [];

    document.getElementById('editor-design-name').value = design.name;
    document.getElementById('canvas-width-input').value = App.canvasW;
    document.getElementById('canvas-height-input').value = App.canvasH;
    document.getElementById('btn-share-design').classList.remove('hidden');
    document.getElementById('admin-text-tools').classList.remove('hidden');

    showPage('page-editor');
    hideLoader();

    await loadAllFontsIntoSelect();
    initCanvas();
    renderCanvas();
    renderTextOverlay();
  } catch (err) {
    hideLoader();
    toast(err.message, 'error');
    goBackFromEditor();
  }
}

function goBackFromEditor() {
  clearTextOverlay();
  if (App.user?.role === 'admin') {
    showPage('page-admin-dashboard');
    adminShowDesigns();
  } else {
    showPage('page-client-dashboard');
  }
}

// ─── Client Dashboard & Editor ─────────────────────────────────────────────
async function loadClientDesigns() {
  const grid = document.getElementById('client-designs-grid');
  grid.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Memuat design...</span></div>';
  try {
    const designs = await api('GET', '/api/client/designs');
    renderDesignGrid(grid, designs, false);
  } catch (err) {
    grid.innerHTML = `<div class="empty-state"><p>Gagal memuat: ${err.message}</p></div>`;
  }
}

async function openClientEditor(designId) {
  showLoader('Memuat design...');
  try {
    const design = await api('GET', `/api/client/designs/${designId}`);
    App.currentDesignId = designId;
    App.clientDesignData = design;
    App.clientFormValues = design.form_values || {};

    document.getElementById('client-design-name').textContent = design.name;
    document.getElementById('client-info-name').textContent = design.name;

    const formFields = (design.texts || []).filter(t => t.formName);
    document.getElementById('client-info-fields').textContent = formFields.length || '—';

    showPage('page-client-editor');
    hideLoader();

    initClientCanvas();
    renderClientCanvas();
    renderClientFormFields(design);
  } catch (err) {
    hideLoader();
    toast(err.message, 'error');
  }
}

function goBackFromClientEditor() {
  showPage('page-client-dashboard');
  loadClientDesigns();
}

function renderClientFormFields(design) {
  const container = document.getElementById('client-form-fields');
  const formTexts = (design.texts || []).filter(t => t.formName);

  if (!formTexts.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">Design ini tidak memiliki field form yang bisa diisi.</p>';
    return;
  }

  container.innerHTML = formTexts.map(t => `
    <div class="client-field-group">
      <label class="client-field-label">${escHtml(t.formName)}</label>
      <input type="text" class="client-field-input"
        id="cf-${t.id}"
        value="${escHtml(App.clientFormValues[t.formName] || t.content || '')}"
        placeholder="${escHtml(t.content || '')}"
        oninput="updateClientField('${t.formName}', '${t.id}', this.value)">
    </div>
  `).join('');
}

function updateClientField(formName, textId, value) {
  App.clientFormValues[formName] = value;
  renderClientCanvas();
}

async function saveClientForm() {
  try {
    await api('PUT', `/api/client/designs/${App.currentDesignId}/form`, { form_values: App.clientFormValues });
    toast('Perubahan tersimpan!', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// ─── Canvas Init ───────────────────────────────────────────────────────────
function initCanvas() {
  const canvas = document.getElementById('main-canvas');
  canvas.width  = App.canvasW;
  canvas.height = App.canvasH;
  initCanvasZoom();
  _centerCanvas('admin');
  renderCanvas();
}


function initClientCanvas() {
  const canvas = document.getElementById('client-canvas');
  const d = App.clientDesignData;
  canvas.width  = d.image_width  || 800;
  canvas.height = d.image_height || 600;
  initClientCanvasZoom();
  _centerCanvas('client');

  // Click-to-jump and hover cursor
  canvas.removeEventListener('click',     handleClientCanvasClick);
  canvas.removeEventListener('mousemove', handleClientCanvasHover);
  canvas.addEventListener('click',     handleClientCanvasClick);
  canvas.addEventListener('mousemove', handleClientCanvasHover);
  canvas.style.cursor = 'default';
}


function applyCanvasSize() {
  const w = parseInt(document.getElementById('canvas-width-input').value) || 800;
  const h = parseInt(document.getElementById('canvas-height-input').value) || 600;
  App.canvasW = w; App.canvasH = h;
  const canvas = document.getElementById('main-canvas');
  canvas.width = w; canvas.height = h;
  renderCanvas();
}

// ─── Canvas Rendering ──────────────────────────────────────────────────────
function renderCanvas() {
  const canvas = document.getElementById('main-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background
  if (App.imageUrl) {
    const img = getCachedImage(App.imageUrl, () => renderCanvas());
    if (img) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    else {
      ctx.fillStyle = '#1a1a24';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  } else {
    ctx.fillStyle = '#1a1a24';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawGrid(ctx, canvas.width, canvas.height);
  }
}

function renderClientCanvas(skipIndicators) {
  const canvas = document.getElementById('client-canvas');
  if (!canvas || !App.clientDesignData) return;
  const d = App.clientDesignData;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background
  if (d.image_url) {
    const img = getCachedImage(d.image_url, () => renderClientCanvas(skipIndicators));
    if (img) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    else { ctx.fillStyle = '#1a1a24'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  } else {
    ctx.fillStyle = '#1a1a24'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawGrid(ctx, canvas.width, canvas.height);
  }

  // Draw texts with client form values
  (d.texts || []).forEach(t => {
    let content = t.content || '';
    let charStyles = t.charStyles;
    if (t.formName && App.clientFormValues[t.formName] !== undefined) {
      const newVal = App.clientFormValues[t.formName];
      if (newVal !== content && Array.isArray(t.charStyles) && t.charStyles.length) {
        const tempT = { ...t, charStyles: t.charStyles.map(s => ({ ...s })) };
        syncCharStylesOnEdit(tempT, content, newVal);
        charStyles = tempT.charStyles;
      }
      content = newVal;
    }
    drawTextOnCanvas(ctx, { ...t, content, charStyles });

    // Draw clickable dashed indicator for form-field texts (skip when downloading)
    if (t.formName && !skipIndicators) {
      ctx.save();
      // Measure actual rendered text height
      const fStr = `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : '400 '}${t.fontSize || 24}px "${t.fontFamily || 'Inter'}", sans-serif`;
      ctx.font = fStr;
      const measured = wrapText(ctx, content || ' ', t.width || 200);
      const lineH   = (t.fontSize || 24) * 1.3;
      const textH   = (t.fontSize || 24) + Math.max(0, measured.length - 1) * lineH;

      const bx = (t.x || 0) - 4;
      const by = (t.y || 0) - 4;
      const bw = (t.width || 200) + 8;
      const bh = textH + 10;

      // Dashed border
      ctx.strokeStyle = 'rgba(99,102,241,0.6)';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(bx, by, bw, bh);

      // Small field-name tag above the border
      ctx.setLineDash([]);
      const labelFontSize = Math.max(9, Math.min(13, (t.fontSize || 24) * 0.45));
      ctx.font        = `600 ${labelFontSize}px "Inter", sans-serif`;
      ctx.textAlign   = 'left';
      ctx.fillStyle   = 'rgba(99,102,241,0.85)';
      ctx.fillText('✎ ' + t.formName, bx + 2, by - 2);

      ctx.restore();
    }
  });
}

// ─── Client Canvas Interaction ─────────────────────────────────────────────
/**
 * Returns the form-field text object located under the mouse pointer,
 * accounting for CSS scaling of the canvas element.
 */
function getFormTextAtPoint(e) {
  const canvas = document.getElementById('client-canvas');
  if (!canvas || !App.clientDesignData) return null;
  const rect   = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top)  * scaleY;

  const formTexts = (App.clientDesignData.texts || []).filter(t => t.formName);
  const ctx = canvas.getContext('2d');

  // Iterate in reverse so topmost-rendered text is tested first
  for (let i = formTexts.length - 1; i >= 0; i--) {
    const t = formTexts[i];
    const tx = (t.x || 0) - 4;
    const ty = (t.y || 0) - 4;
    const tw = (t.width || 200) + 8;

    const content = (t.formName && App.clientFormValues[t.formName] !== undefined)
      ? App.clientFormValues[t.formName]
      : (t.content || ' ');

    const fStr = `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : '400 '}${t.fontSize || 24}px "${t.fontFamily || 'Inter'}", sans-serif`;
    ctx.font = fStr;
    const lines  = wrapText(ctx, content, t.width || 200);
    const lineH  = (t.fontSize || 24) * 1.3;
    const textH  = (t.fontSize || 24) + Math.max(0, lines.length - 1) * lineH;
    const th = textH + 10;

    if (px >= tx && px <= tx + tw && py >= ty && py <= ty + th) return t;
  }
  return null;
}

function handleClientCanvasHover(e) {
  const t = getFormTextAtPoint(e);
  e.currentTarget.style.cursor = t ? 'pointer' : 'default';
}

function handleClientCanvasClick(e) {
  const t = getFormTextAtPoint(e);
  if (!t) return;

  const input = document.getElementById(`cf-${t.id}`);
  if (!input) return;

  // On mobile the page itself scrolls; on desktop the sidebar scrolls
  const isMobile = window.innerWidth <= 768;
  if (isMobile) {
    // Scroll entire page so the form panel comes into view first,
    // then scroll the input into view smoothly
    const panel = document.getElementById('client-form-panel');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => {
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => focusHighlight(input), 200);
    }, 300);
  } else {
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => focusHighlight(input), 200);
  }
}

function focusHighlight(input) {
  input.focus();
  input.select();
  input.classList.remove('field-highlight'); // reset to re-trigger animation
  void input.offsetWidth;                    // force reflow
  input.classList.add('field-highlight');
  setTimeout(() => input.classList.remove('field-highlight'), 1800);
}

const imageCache = {};

/**
 * Load an image URL into a canvas-safe HTMLImageElement.
 *
 * Handles two cases:
 *  1. data: URLs (base64)  — loaded directly, no network request needed.
 *  2. http/https/relative  — fetched with cache:'reload' to bypass any non-CORS
 *     browser cache entry (the classic cache-poisoning problem where an <img>
 *     tag loads the URL without crossOrigin, caches it, then canvas reuse fails).
 *
 * @param {string}   url    - data URL, relative path, or absolute URL
 * @param {Function} onLoad - called once the image is ready to draw
 * @returns {HTMLImageElement|null} cached element, or null while loading
 */
function getCachedImage(url, onLoad) {
  if (!url) return null;

  // ── data: URL — load directly, no fetch needed ──────────────────────────
  if (url.startsWith('data:')) {
    if (imageCache[url]) return imageCache[url];
    if (imageCache['__loading__' + url]) return null;
    imageCache['__loading__' + url] = true;
    const img = new Image();
    img.onload = () => {
      imageCache[url] = img;
      delete imageCache['__loading__' + url];
      onLoad && onLoad();
    };
    img.onerror = () => {
      delete imageCache['__loading__' + url];
      console.warn('[DesignCraft] Failed to load data URL image');
    };
    img.src = url;
    return null;
  }

  // ── Regular URL — fetch with cache-busting to guarantee CORS headers ────
  // Normalise to absolute URL so cache key is consistent across devices
  const absUrl = url.startsWith('/') ? (window.location.origin + url) : url;

  if (imageCache[absUrl]) return imageCache[absUrl];
  if (imageCache['__loading__' + absUrl]) return null;   // fetch already in flight
  imageCache['__loading__' + absUrl] = true;

  fetch(absUrl, { cache: 'reload' })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    })
    .then(blob => {
      const blobUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        imageCache[absUrl] = img;
        imageCache[url]    = img;
        delete imageCache['__loading__' + absUrl];
        URL.revokeObjectURL(blobUrl);
        onLoad && onLoad();
      };
      img.onerror = () => {
        delete imageCache[absUrl];
        delete imageCache['__loading__' + absUrl];
        console.warn('[DesignCraft] Failed to create image from blob:', absUrl);
      };
      img.src = blobUrl;
    })
    .catch(err => {
      delete imageCache[absUrl];
      delete imageCache['__loading__' + absUrl];
      console.warn('[DesignCraft] fetch failed, will retry on next render:', absUrl, err.message);
    });

  return null;
}

function drawGrid(ctx, w, h) {
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  const step = 40;
  for (let x = 0; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
}

// ─── Per-Character Style Helpers (Partial Bold / Italic / Underline) ─────
App.textSelection = null; // { id, start, end, source: 'textarea'|'canvas' }

function ensureCharStyles(t) {
  const len = (t.content || '').length;
  if (!Array.isArray(t.charStyles)) {
    t.charStyles = [];
  }
  while (t.charStyles.length < len) {
    t.charStyles.push({ b: !!t.bold, i: !!t.italic, u: !!t.underline });
  }
  if (t.charStyles.length > len) {
    t.charStyles.length = len;
  }
  return t.charStyles;
}

function syncCharStylesOnEdit(t, oldStr, newStr) {
  oldStr = String(oldStr || '');
  newStr = String(newStr || '');
  if (!Array.isArray(t.charStyles) || !t.charStyles.length) {
    t.content = newStr;
    ensureCharStyles(t);
    return;
  }
  const oldStyles = t.charStyles;
  let prefix = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (prefix < minLen && oldStr[prefix] === newStr[prefix]) {
    prefix++;
  }
  let oldSuffix = oldStr.length;
  let newSuffix = newStr.length;
  while (oldSuffix > prefix && newSuffix > prefix && oldStr[oldSuffix - 1] === newStr[newSuffix - 1]) {
    oldSuffix--;
    newSuffix--;
  }
  const inheritStyle = prefix > 0
    ? { ...oldStyles[prefix - 1] }
    : (oldSuffix < oldStyles.length ? { ...oldStyles[oldSuffix] } : { b: !!t.bold, i: !!t.italic, u: !!t.underline });

  const newStyles = [];
  for (let i = 0; i < prefix; i++) newStyles.push({ ...oldStyles[i] });
  for (let i = prefix; i < newSuffix; i++) newStyles.push({ ...inheritStyle });
  for (let i = oldSuffix; i < oldStyles.length; i++) newStyles.push({ ...oldStyles[i] });

  t.content = newStr;
  t.charStyles = newStyles;
}

function renderStyledTextHTML(t) {
  const text = t.content || '';
  if (!text) return '';
  if (!Array.isArray(t.charStyles) || !t.charStyles.length) {
    const css = [
      `font-weight:${t.bold ? '700' : '400'}`,
      `font-style:${t.italic ? 'italic' : 'normal'}`,
      `text-decoration:${t.underline ? 'underline' : 'none'}`
    ].join(';');
    return `<span data-start="0" data-end="${text.length}" style="${css}">${escHtml(text)}</span>`;
  }
  const styles = ensureCharStyles(t);
  let html = '';
  let i = 0;
  while (i < text.length) {
    const st = styles[i] || { b: !!t.bold, i: !!t.italic, u: !!t.underline };
    let j = i + 1;
    while (
      j < text.length &&
      !!styles[j]?.b === !!st.b &&
      !!styles[j]?.i === !!st.i &&
      !!styles[j]?.u === !!st.u
    ) {
      j++;
    }
    const chunk = escHtml(text.slice(i, j));
    const css = [
      `font-weight:${st.b ? '700' : '400'}`,
      `font-style:${st.i ? 'italic' : 'normal'}`,
      `text-decoration:${st.u ? 'underline' : 'none'}`
    ].join(';');
    html += `<span data-start="${i}" data-end="${j}" style="${css}">${chunk}</span>`;
    i = j;
  }
  return html;
}

function getStyledCharFont(t, b, i) {
  return [
    i ? 'italic' : '',
    b ? '700' : '400',
    `${t.fontSize || 24}px`,
    `"${t.fontFamily || 'Inter'}", sans-serif`
  ].filter(Boolean).join(' ');
}

function measureStyledSegment(ctx, t, chars) {
  if (!chars || !chars.length) return 0;
  let totalW = 0;
  let idx = 0;
  while (idx < chars.length) {
    const cur = chars[idx];
    let end = idx + 1;
    let str = cur.ch;
    while (end < chars.length && chars[end].b === cur.b && chars[end].i === cur.i) {
      str += chars[end].ch;
      end++;
    }
    ctx.font = getStyledCharFont(t, cur.b, cur.i);
    totalW += ctx.measureText(str).width;
    idx = end;
  }
  return totalW;
}

function wrapStyledText(ctx, t) {
  const text = t.content || '';
  const maxW = t.width || 300;
  const hasCustomStyles = Array.isArray(t.charStyles) && t.charStyles.length > 0;

  const chars = [];
  for (let idx = 0; idx < text.length; idx++) {
    const st = hasCustomStyles && t.charStyles[idx]
      ? t.charStyles[idx]
      : { b: !!t.bold, i: !!t.italic, u: !!t.underline };
    chars.push({ ch: text[idx], b: !!st.b, i: !!st.i, u: !!st.u });
  }

  const paragraphs = [];
  let curPara = [];
  chars.forEach(c => {
    if (c.ch === '\n') {
      paragraphs.push(curPara);
      curPara = [];
    } else {
      curPara.push(c);
    }
  });
  paragraphs.push(curPara);

  const resultLines = [];
  paragraphs.forEach(para => {
    if (!para.length) {
      resultLines.push([]);
      return;
    }
    const words = [];
    let curWord = [];
    para.forEach(c => {
      if (c.ch === ' ') {
        words.push({ chars: curWord, space: c });
        curWord = [];
      } else {
        curWord.push(c);
      }
    });
    words.push({ chars: curWord, space: null });

    let currentLine = [];
    words.forEach((wObj, wIdx) => {
      const prefixSpace = (currentLine.length > 0 && wIdx > 0 && words[wIdx - 1].space)
        ? [words[wIdx - 1].space]
        : [];
      const testLine = currentLine.concat(prefixSpace, wObj.chars);
      if (measureStyledSegment(ctx, t, testLine) > maxW && currentLine.length > 0) {
        resultLines.push(currentLine);
        currentLine = [...wObj.chars];
      } else {
        currentLine = testLine;
      }
    });
    if (currentLine.length > 0) resultLines.push(currentLine);
  });

  return resultLines;
}

function drawTextOnCanvas(ctx, t) {
  if (!t || !t.content) return;
  ctx.save();
  ctx.globalAlpha = t.opacity !== undefined ? t.opacity / 100 : 1;
  ctx.fillStyle = t.color || '#ffffff';
  ctx.textAlign = 'left';

  if (t.shadow) {
    ctx.shadowColor = t.shadowColor || '#000000';
    ctx.shadowBlur = t.shadowBlur || 4;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
  }

  const x = t.x || 0;
  const y = t.y || 0;
  const maxW = t.width || 300;
  const lineH = (t.fontSize || 24) * 1.3;

  const styledLines = wrapStyledText(ctx, t);
  styledLines.forEach((lineChars, lineIdx) => {
    if (!lineChars.length) return;
    const lineW = measureStyledSegment(ctx, t, lineChars);
    let curX = x;
    if (t.align === 'center') curX = x + (maxW - lineW) / 2;
    else if (t.align === 'right') curX = x + maxW - lineW;

    const drawY = y + (t.fontSize || 24) + lineIdx * lineH;

    let idx = 0;
    while (idx < lineChars.length) {
      const cur = lineChars[idx];
      let end = idx + 1;
      let str = cur.ch;
      while (
        end < lineChars.length &&
        lineChars[end].b === cur.b &&
        lineChars[end].i === cur.i &&
        lineChars[end].u === cur.u
      ) {
        str += lineChars[end].ch;
        end++;
      }
      ctx.font = getStyledCharFont(t, cur.b, cur.i);
      ctx.fillText(str, curX, drawY);
      const segW = ctx.measureText(str).width;

      if (cur.u) {
        const uy = drawY + 2;
        ctx.strokeStyle = t.color || '#fff';
        ctx.lineWidth = Math.max(1, (t.fontSize || 24) / 16);
        ctx.beginPath();
        ctx.moveTo(curX, uy);
        ctx.lineTo(curX + segW, uy);
        ctx.stroke();
      }

      curX += segW;
      idx = end;
    }
  });

  ctx.restore();
}

function wrapText(ctx, text, maxW) {
  const lines = text.split('\n');
  const result = [];
  lines.forEach(line => {
    if (!line) { result.push(''); return; }
    const words = line.split(' ');
    let current = '';
    words.forEach(word => {
      const test = current ? current + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && current) {
        result.push(current);
        current = word;
      } else { current = test; }
    });
    if (current) result.push(current);
  });
  return result;
}

// ─── Text Overlay (Admin) ──────────────────────────────────────────────────
function renderTextOverlay() {
  const overlay = document.getElementById('text-overlay');
  overlay.innerHTML = '';
  App.texts.forEach(t => {
    const el = createTextElement(t);
    overlay.appendChild(el);
  });
}

function clearTextOverlay() {
  const overlay = document.getElementById('text-overlay');
  if (overlay) overlay.innerHTML = '';
}

function getSelectionOffsetsInElement(containerEl) {
  if (!containerEl) return null;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!containerEl.contains(range.startContainer) || !containerEl.contains(range.endContainer)) {
    return null;
  }
  const preStart = document.createRange();
  preStart.selectNodeContents(containerEl);
  preStart.setEnd(range.startContainer, range.startOffset);
  const start = preStart.toString().length;

  const preEnd = document.createRange();
  preEnd.selectNodeContents(containerEl);
  preEnd.setEnd(range.endContainer, range.endOffset);
  const end = preEnd.toString().length;

  return {
    start: Math.min(start, end),
    end: Math.max(start, end)
  };
}

function setSelectionOffsetsInElement(containerEl, start, end) {
  if (!containerEl) return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let charIdx = 0;
  let startNode = null, startOffset = 0;
  let endNode = null, endOffset = 0;

  function traverse(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const nextIdx = charIdx + node.length;
      if (!startNode && start >= charIdx && start <= nextIdx) {
        startNode = node;
        startOffset = start - charIdx;
      }
      if (!endNode && end >= charIdx && end <= nextIdx) {
        endNode = node;
        endOffset = end - charIdx;
      }
      charIdx = nextIdx;
    } else if (node.nodeName === 'BR') {
      charIdx += 1;
    } else {
      for (let i = 0; i < node.childNodes.length; i++) {
        traverse(node.childNodes[i]);
        if (startNode && endNode) return;
      }
    }
  }

  traverse(containerEl);
  if (!startNode) {
    startNode = containerEl;
    startOffset = containerEl.childNodes.length;
  }
  if (!endNode) {
    endNode = startNode;
    endOffset = startOffset;
  }
  try {
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (_) {}
}

function selectWordAtPoint(contentEl, clientX, clientY) {
  let caretRange = null;
  if (document.caretRangeFromPoint) {
    caretRange = document.caretRangeFromPoint(clientX, clientY);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(clientX, clientY);
    if (pos) {
      caretRange = document.createRange();
      caretRange.setStart(pos.offsetNode, pos.offset);
      caretRange.collapse(true);
    }
  }
  if (!caretRange || !contentEl.contains(caretRange.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(contentEl);
  pre.setEnd(caretRange.startContainer, caretRange.startOffset);
  const clickIdx = pre.toString().length;
  const fullText = contentEl.textContent || '';
  if (!fullText.length) return null;

  let wStart = Math.min(clickIdx, fullText.length - 1);
  let wEnd   = wStart;
  if (/\S/.test(fullText[wStart])) {
    while (wStart > 0 && /\S/.test(fullText[wStart - 1])) wStart--;
    while (wEnd < fullText.length && /\S/.test(fullText[wEnd])) wEnd++;
    setSelectionOffsetsInElement(contentEl, wStart, wEnd);
    return { start: wStart, end: wEnd };
  } else {
    setSelectionOffsetsInElement(contentEl, clickIdx, clickIdx);
    return { start: clickIdx, end: clickIdx };
  }
}

function attachResizeHandlesToElement(el, textId) {
  el.querySelectorAll('.resize-handle').forEach(h => h.remove());
  ['nw','n','ne','e','se','s','sw','w'].forEach(dir => {
    const handle = document.createElement('div');
    handle.className = `resize-handle resize-handle-${dir}`;
    el.appendChild(handle);
    handle.addEventListener('mousedown', e => startResizeHandle(e, textId, dir));
  });
}

let _lastCanvasClickTime = 0;
let _lastCanvasClickId   = null;

function enterCanvasTextSelectMode(el, content, t, e) {
  el.classList.add('selecting-text');
  content.contentEditable = 'true';
  content.spellcheck = false;
  content.focus();
  if (e && typeof e.clientX === 'number') {
    const wordOffsets = selectWordAtPoint(content, e.clientX, e.clientY);
    if (wordOffsets && wordOffsets.start < wordOffsets.end) {
      App.textSelection = { id: t.id, start: wordOffsets.start, end: wordOffsets.end, source: 'canvas' };
      updateStyleButtonsForSelection(t);
    }
  }
}

function createTextElement(t) {
  const el = document.createElement('div');
  el.className = 'text-element' + (t.id === App.selectedTextId ? ' selected' : '');
  el.id = `te-${t.id}`;
  el.style.cssText = `
    left: ${t.x}px; top: ${t.y}px;
    width: ${t.width || 200}px;
    min-height: ${t.fontSize || 24}px;
  `;

  const content = document.createElement('div');
  content.className = 'text-content';
  content.style.cssText = buildTextStyle(t);
  content.innerHTML = renderStyledTextHTML(t);
  content.addEventListener('input', () => handleRichContentInput(content, 'canvas'));
  el.appendChild(content);

  if (t.id === App.selectedTextId) {
    attachResizeHandlesToElement(el, t.id);
  }

  // Double-click on canvas text → enable direct text highlighting & word selection on canvas
  el.addEventListener('dblclick', e => {
    if (e.target.classList.contains('resize-handle')) return;
    e.stopPropagation();
    enterCanvasTextSelectMode(el, content, t, e);
  });

  el.addEventListener('mouseup', () => {
    if (el.classList.contains('selecting-text')) {
      const offsets = getSelectionOffsetsInElement(content);
      if (offsets && offsets.start < offsets.end) {
        App.textSelection = { id: t.id, start: offsets.start, end: offsets.end, source: 'canvas' };
        updateStyleButtonsForSelection(t);
      }
    }
  });

  el.addEventListener('mousedown', e => {
    if (e.target.classList.contains('resize-handle')) return;
    // If already in canvas text-selection mode, allow user to drag-select text inside
    if (el.classList.contains('selecting-text')) {
      return;
    }
    if (e.altKey) {
      // Alt + drag → duplicate then drag the copy
      e.preventDefault(); e.stopPropagation();
      altDuplicateDrag(e, t);
      return;
    }

    const now = Date.now();
    const isDoubleClick = (e.detail >= 2) || (_lastCanvasClickId === t.id && (now - _lastCanvasClickTime) < 380);
    _lastCanvasClickTime = now;
    _lastCanvasClickId   = t.id;

    selectText(t.id);

    if (isDoubleClick) {
      e.stopPropagation();
      enterCanvasTextSelectMode(el, content, t, e);
      return;
    }

    startDrag(e, t.id);
  });

  return el;
}


function buildTextStyle(t) {
  const hasCharStyles = Array.isArray(t.charStyles) && t.charStyles.length > 0;
  return `
    font-family: "${t.fontFamily || 'Inter'}", sans-serif;
    font-size: ${t.fontSize || 24}px;
    font-weight: ${t.bold ? '700' : '400'};
    font-style: ${t.italic ? 'italic' : 'normal'};
    text-decoration: ${hasCharStyles ? 'none' : (t.underline ? 'underline' : 'none')};
    color: ${t.color || '#ffffff'};
    text-align: ${t.align || 'left'};
    opacity: ${(t.opacity !== undefined ? t.opacity : 100) / 100};
    text-shadow: ${t.shadow ? `1px 1px ${t.shadowBlur || 4}px ${t.shadowColor || '#000'}` : 'none'};
    white-space: pre-wrap;
    word-break: break-word;
    width: 100%;
    line-height: 1.3;
    pointer-events: none;
  `;
}

// ─── Clipboard (Ctrl+C / Ctrl+V / Alt+drag) ────────────────────────────────
App.clipboard = null;

function copySelectedText() {
  const t = App.texts.find(x => x.id === App.selectedTextId);
  if (!t) { toast('Pilih teks dulu untuk disalin', 'info'); return; }
  App.clipboard = JSON.parse(JSON.stringify(t));
  toast(`Disalin: "${(t.content || '').slice(0, 22)}"`, 'success');
}

function pasteText() {
  if (!App.clipboard) { toast('Clipboard kosong — salin teks dulu (Ctrl+C)', 'info'); return; }
  pushUndo();
  const id = 'txt-' + Date.now();
  const newT = {
    ...JSON.parse(JSON.stringify(App.clipboard)),
    id,
    x: (App.clipboard.x || 0) + 20,
    y: (App.clipboard.y || 0) + 20,
    formName: '',   // reset form binding on paste
  };
  App.texts.push(newT);
  renderTextOverlay();
  selectText(id);
  renderCanvas();
  toast('Ditempel (Ctrl+V)', 'success');
}

/** Alt + drag → duplicate original in-place, then drag the copy */
function altDuplicateDrag(e, original) {
  pushUndo();
  const id = 'txt-' + Date.now();
  const copy = { ...JSON.parse(JSON.stringify(original)), id, formName: '' };
  App.texts.push(copy);
  renderTextOverlay();
  selectText(id);
  renderCanvas();
  startDrag(e, id);   // immediately drag the copy
}

// ─── Text CRUD ─────────────────────────────────────────────────────────────
function addText() {
  pushUndo();
  const id = 'txt-' + Date.now();
  const newText = {
    id, content: 'Teks Baru', x: 50, y: 50,
    width: 200, fontFamily: 'Inter', fontSize: 24,
    color: '#ffffff', align: 'left', bold: false,
    italic: false, underline: false, opacity: 100,
    shadow: false, shadowBlur: 4, shadowColor: '#000000',
    formName: ''
  };
  App.texts.push(newText);
  renderTextOverlay();
  selectText(id);
  toast('Teks ditambahkan', 'success');
}

function selectText(id) {
  const prevId = App.selectedTextId;
  if (prevId !== id) {
    App.textSelection = null;
    // Exit selecting-text mode on previously selected element without destroying DOM
    if (prevId) {
      const prevEl = document.getElementById(`te-${prevId}`);
      if (prevEl) {
        prevEl.classList.remove('selected', 'selecting-text');
        prevEl.querySelectorAll('.resize-handle').forEach(h => h.remove());
        const prevContent = prevEl.querySelector('.text-content');
        if (prevContent) prevContent.contentEditable = 'false';
      }
    }
  }
  App.selectedTextId = id;
  const curEl = document.getElementById(`te-${id}`);
  if (curEl) {
    curEl.classList.add('selected');
    if (!curEl.querySelector('.resize-handle')) {
      attachResizeHandlesToElement(curEl, id);
    }
  } else {
    renderTextOverlay();
  }
  const t = App.texts.find(x => x.id === id);
  if (!t) { hideTextProperties(); return; }
  if (prevId !== id) {
    showTextProperties(t);
  }
}

function deselectText() {
  App.selectedTextId = null;
  App.textSelection = null;
  renderTextOverlay();
  hideTextProperties();
}

function deleteSelectedText() {
  if (!App.selectedTextId) return;
  pushUndo();
  App.texts = App.texts.filter(t => t.id !== App.selectedTextId);
  App.selectedTextId = null;
  App.textSelection = null;
  renderTextOverlay();
  hideTextProperties();
  toast('Teks dihapus', 'info');
}

// Track text selection in #prop-content or canvas .text-content automatically
document.addEventListener('selectionchange', () => {
  if (!App.selectedTextId) return;
  const t = App.texts.find(x => x.id === App.selectedTextId);
  if (!t) return;

  const propEl   = document.getElementById('prop-content');
  const canvasEl = document.querySelector(`#te-${t.id} .text-content`);

  if (propEl) {
    const off = getSelectionOffsetsInElement(propEl);
    if (off) {
      if (off.start < off.end) {
        App.textSelection = { id: t.id, start: off.start, end: off.end, source: 'prop' };
        updateStyleButtonsForSelection(t);
        return;
      } else if (document.activeElement === propEl) {
        App.textSelection = null;
        updateStyleButtonsForSelection(t);
        return;
      }
    }
  }
  if (canvasEl) {
    const off = getSelectionOffsetsInElement(canvasEl);
    if (off) {
      if (off.start < off.end) {
        App.textSelection = { id: t.id, start: off.start, end: off.end, source: 'canvas' };
        updateStyleButtonsForSelection(t);
        return;
      } else if (document.activeElement === canvasEl) {
        App.textSelection = null;
        updateStyleButtonsForSelection(t);
        return;
      }
    }
  }
});

function handleRichContentInput(el, source) {
  if (!App.selectedTextId || !el) return;
  const t = App.texts.find(x => x.id === App.selectedTextId);
  if (!t) return;

  const newPlain = (el.innerText || '').replace(/\r\n/g, '\n');
  syncCharStylesOnEdit(t, t.content || '', newPlain);

  if (source === 'prop') {
    const canvasContent = document.querySelector(`#te-${t.id} .text-content`);
    if (canvasContent) {
      canvasContent.style.cssText = buildTextStyle(t);
      canvasContent.innerHTML = renderStyledTextHTML(t);
    }
  } else if (source === 'canvas') {
    const propEl = document.getElementById('prop-content');
    if (propEl) {
      propEl.innerHTML = renderStyledTextHTML(t);
    }
  }
  renderCanvas();
}

function updateStyleButtonsForSelection(t) {
  if (!t) return;
  const styles = ensureCharStyles(t);
  let selStart = 0, selEnd = 0;

  const propEl   = document.getElementById('prop-content');
  const canvasEl = document.querySelector(`#te-${t.id} .text-content`);
  const propOff   = propEl   ? getSelectionOffsetsInElement(propEl)   : null;
  const canvasOff = canvasEl ? getSelectionOffsetsInElement(canvasEl) : null;

  if (propOff && propOff.start < propOff.end) {
    selStart = propOff.start;
    selEnd   = propOff.end;
  } else if (canvasOff && canvasOff.start < canvasOff.end) {
    selStart = canvasOff.start;
    selEnd   = canvasOff.end;
  } else if (App.textSelection && App.textSelection.id === t.id && App.textSelection.start < App.textSelection.end) {
    selStart = App.textSelection.start;
    selEnd   = App.textSelection.end;
  }

  const map = { bold: 'b', italic: 'i', underline: 'u' };
  ['bold', 'italic', 'underline'].forEach(s => {
    const key = map[s];
    let isActive = false;
    if (selStart < selEnd && styles.length > 0) {
      const s0 = Math.max(0, Math.min(styles.length, selStart));
      const s1 = Math.max(0, Math.min(styles.length, selEnd));
      isActive = s1 > s0 && styles.slice(s0, s1).every(ch => !!ch[key]);
    } else if (styles.length > 0) {
      isActive = styles.every(ch => !!ch[key]);
    } else {
      isActive = !!t[s];
    }
    document.getElementById(`btn-${s}`)?.classList.toggle('active', isActive);
  });
}

function showTextProperties(t) {
  document.getElementById('no-selection-msg').classList.add('hidden');
  document.getElementById('text-properties').classList.remove('hidden');
  document.getElementById('btn-delete-text').classList.remove('hidden');

  const fs = Number(Number(t.fontSize || 24).toFixed(2));
  const propContentEl = document.getElementById('prop-content');
  if (propContentEl) {
    propContentEl.innerHTML = renderStyledTextHTML(t);
  }
  document.getElementById('prop-form-name').value = t.formName || '';
  document.getElementById('prop-font').value = t.fontFamily || 'Inter';
  document.getElementById('prop-font-size').value = fs;
  const fsNumEl = document.getElementById('prop-font-size-num');
  if (fsNumEl) fsNumEl.value = fs;
  document.getElementById('font-size-val').textContent = fs;
  document.getElementById('prop-color').value = t.color || '#ffffff';
  document.getElementById('prop-color-hex').value = t.color || '#ffffff';
  document.getElementById('prop-x').value = Number(Number(t.x || 0).toFixed(2));
  document.getElementById('prop-y').value = Number(Number(t.y || 0).toFixed(2));
  document.getElementById('prop-opacity').value = t.opacity !== undefined ? t.opacity : 100;
  document.getElementById('opacity-val').textContent = t.opacity !== undefined ? t.opacity : 100;
  document.getElementById('prop-shadow').checked = !!t.shadow;
  document.getElementById('prop-shadow-blur').value = t.shadowBlur || 4;
  document.getElementById('prop-shadow-color').value = t.shadowColor || '#000000';
  document.getElementById('shadow-detail').style.display = t.shadow ? 'flex' : 'none';
  document.getElementById('shadow-detail').style.flexDirection = 'column';

  // Style buttons (reflects current selection or whole text)
  updateStyleButtonsForSelection(t);

  // Align buttons
  ['left','center','right'].forEach(a => {
    document.getElementById(`btn-align-${a}`).classList.toggle('active', (t.align || 'left') === a);
  });

  // Font preview
  updateFontPreview(t.fontFamily || 'Inter');
}

function hideTextProperties() {
  document.getElementById('no-selection-msg').classList.remove('hidden');
  document.getElementById('text-properties').classList.add('hidden');
  document.getElementById('btn-delete-text').classList.add('hidden');
}

function updateSelectedText(prop, value) {
  if (!App.selectedTextId) return;
  const t = App.texts.find(x => x.id === App.selectedTextId);
  if (!t) return;

  if (prop === 'content') {
    syncCharStylesOnEdit(t, t.content || '', value);
  } else {
    t[prop] = value;
  }

  const el = document.getElementById(`te-${t.id}`);
  if (el) {
    const content = el.querySelector('.text-content');
    if (prop === 'content') {
      content.style.cssText = buildTextStyle(t);
      content.innerHTML = renderStyledTextHTML(t);
    } else if (prop === 'x') el.style.left = value + 'px';
    else if (prop === 'y') el.style.top = value + 'px';
    else {
      if (prop === 'fontSize') el.style.minHeight = value + 'px';
      content.style.cssText = buildTextStyle(t);
      content.innerHTML = renderStyledTextHTML(t);
    }
  }

  if (prop === 'shadow') {
    document.getElementById('shadow-detail').style.display = value ? 'flex' : 'none';
    document.getElementById('shadow-detail').style.flexDirection = 'column';
  }
  if (prop === 'align') {
    ['left','center','right'].forEach(a => document.getElementById(`btn-align-${a}`).classList.toggle('active', a === value));
  }
  if (prop === 'fontFamily') updateFontPreview(value);

  renderCanvas();
}

function updateFontSize(val) {
  const num = parseFloat(val);
  if (isNaN(num) || num <= 0) return;
  const precise = Number(num.toFixed(2));
  document.getElementById('font-size-val').textContent = precise;
  const rangeEl = document.getElementById('prop-font-size');
  const numEl   = document.getElementById('prop-font-size-num');
  if (rangeEl && document.activeElement !== rangeEl) rangeEl.value = precise;
  if (numEl   && document.activeElement !== numEl)   numEl.value   = precise;
  updateSelectedText('fontSize', precise);
}

function updateOpacity(val) {
  document.getElementById('opacity-val').textContent = val;
  updateSelectedText('opacity', parseInt(val));
}

function syncColorFromHex(val) {
  if (/^#[0-9a-f]{6}$/i.test(val)) {
    document.getElementById('prop-color').value = val;
    updateSelectedText('color', val);
  }
}

function toggleStyle(style) {
  const t = App.texts.find(x => x.id === App.selectedTextId);
  if (!t) return;
  pushUndo();

  const key = style === 'bold' ? 'b' : (style === 'italic' ? 'i' : 'u');
  const styles = ensureCharStyles(t);

  const propEl   = document.getElementById('prop-content');
  const canvasEl = document.querySelector(`#te-${t.id} .text-content`);

  let selStart = 0, selEnd = 0, source = 'prop';
  const propOff   = propEl   ? getSelectionOffsetsInElement(propEl)   : null;
  const canvasOff = canvasEl ? getSelectionOffsetsInElement(canvasEl) : null;

  if (propOff && propOff.start < propOff.end) {
    selStart = propOff.start;
    selEnd   = propOff.end;
    source   = 'prop';
  } else if (canvasOff && canvasOff.start < canvasOff.end) {
    selStart = canvasOff.start;
    selEnd   = canvasOff.end;
    source   = 'canvas';
  } else if (App.textSelection && App.textSelection.id === t.id && App.textSelection.start < App.textSelection.end) {
    selStart = App.textSelection.start;
    selEnd   = App.textSelection.end;
    source   = App.textSelection.source || 'prop';
  }

  selStart = Math.max(0, Math.min(styles.length, selStart));
  selEnd   = Math.max(0, Math.min(styles.length, selEnd));

  if (selStart < selEnd) {
    // Partial selection formatting: only toggle the highlighted characters!
    const allActive = styles.slice(selStart, selEnd).every(ch => !!ch[key]);
    const newVal = !allActive;
    for (let i = selStart; i < selEnd; i++) {
      styles[i][key] = newVal;
    }
    t[style] = styles.length > 0 && styles.every(ch => !!ch[key]);
  } else {
    // Whole text formatting: toggle all characters
    const allActive = styles.length > 0 ? styles.every(ch => !!ch[key]) : !!t[style];
    const newVal = !allActive;
    t[style] = newVal;
    styles.forEach(ch => { ch[key] = newVal; });
  }

  // Update both Canvas DOM and Konten Teks box so both show the bolded word immediately
  if (canvasEl) {
    const wasEditable = canvasEl.contentEditable === 'true';
    canvasEl.style.cssText = buildTextStyle(t);
    if (wasEditable) canvasEl.contentEditable = 'true';
    canvasEl.innerHTML = renderStyledTextHTML(t);
  }
  if (propEl) {
    propEl.innerHTML = renderStyledTextHTML(t);
  }

  // Restore highlight range so selection stays active
  if (selStart < selEnd) {
    const targetEl = (source === 'canvas' && canvasEl) ? canvasEl : propEl;
    if (targetEl) {
      targetEl.focus();
      setSelectionOffsetsInElement(targetEl, selStart, selEnd);
    }
    App.textSelection = { id: t.id, start: selStart, end: selEnd, source };
  }

  updateStyleButtonsForSelection(t);
  renderCanvas();
}

function updateFontPreview(fontFamily) {
  const preview = document.getElementById('font-preview');
  preview.style.fontFamily = `"${fontFamily}", sans-serif`;
}

// ─── Drag & Drop (zoom + pan aware) ─────────────────────────────────────────────
function startDrag(e, id) {
  // If space-pan is active, don't start a text drag
  if (ViewState.spacePanning) return;
  e.preventDefault();
  const t = App.texts.find(x => x.id === id);
  if (!t) return;

  const startX = e.clientX, startY = e.clientY;
  const origX = Number(t.x) || 0, origY = Number(t.y) || 0;
  let moved = false;

  function onMove(e2) {
    moved = true;
    const z  = ViewState.admin.zoom;    // divide by zoom so drag speed matches visual
    const dx = (e2.clientX - startX) / z;
    const dy = (e2.clientY - startY) / z;
    t.x = Number(Math.max(0, origX + dx).toFixed(2));
    t.y = Number(Math.max(0, origY + dy).toFixed(2));
    const el = document.getElementById(`te-${id}`);
    if (el) { el.style.left = t.x + 'px'; el.style.top = t.y + 'px'; }
    const px = document.getElementById('prop-x');
    const py = document.getElementById('prop-y');
    if (px) px.value = t.x;
    if (py) py.value = t.y;
    renderCanvas();
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    if (moved) pushUndo();
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

// ─── Resize Handle (8-directional, zoom-aware, 0.01px precision) ─────────
/**
 * dir: 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'
 *
 * Corner handles ('ne', 'se', 'nw', 'sw') → uniform scale (fontSize & width)
 * with the opposite corner of the text locked as fixed anchor point:
 *   - 'ne' (top-right)    → bottom-left text anchor fixed
 *   - 'se' (bottom-right) → top-left text anchor fixed
 *   - 'nw' (top-left)     → bottom-right text anchor fixed
 *   - 'sw' (bottom-left)  → top-right text anchor fixed
 *
 * Horizontal edge handles ('e', 'w') → resize textbox width only
 * Vertical edge handles ('n', 's')   → scale fontSize with opposite vertical edge fixed
 */
function startResizeHandle(e, id, dir) {
  e.preventDefault();
  e.stopPropagation();
  const t = App.texts.find(x => x.id === id);
  if (!t) return;
  pushUndo();

  const startX = e.clientX;
  const startY = e.clientY;
  const origX  = Number(t.x) || 0;
  const origY  = Number(t.y) || 0;
  const origW  = Number(t.width) || 200;
  const origFS = Number(t.fontSize) || 24;

  const el    = document.getElementById(`te-${id}`);
  const initZ = ZoomState.admin || 1;
  const origH = el ? (el.getBoundingClientRect().height / initZ) : (origFS * 1.3);

  // Measure actual rendered text width inside the box so the text's own corner stays fixed
  let origTextW = origW;
  const contentEl = el ? el.querySelector('.text-content') : null;
  if (contentEl && contentEl.firstChild) {
    try {
      const range = document.createRange();
      range.selectNodeContents(contentEl);
      const rRect = range.getBoundingClientRect();
      if (rRect.width > 0) {
        origTextW = Math.min(origW, rRect.width / initZ);
      }
    } catch (_) {}
  }

  const align = t.align || 'left';
  let relTextLeft  = 0;
  let relTextRight = origTextW;
  if (align === 'center') {
    relTextLeft  = (origW - origTextW) / 2;
    relTextRight = (origW + origTextW) / 2;
  } else if (align === 'right') {
    relTextLeft  = origW - origTextW;
    relTextRight = origW;
  }

  const isCorner = (dir === 'nw' || dir === 'ne' || dir === 'se' || dir === 'sw');

  function onMove(e2) {
    const z  = ZoomState.admin || 1;
    const dx = (e2.clientX - startX) / z;
    const dy = (e2.clientY - startY) / z;

    if (isCorner) {
      // Direction signs pointing outward from the fixed anchor corner
      const sx = dir.includes('e') ? 1 : -1;
      const sy = dir.includes('s') ? 1 : -1;

      // Project cursor movement along outward axes for smooth 0.01px scaling
      const deltaOut = (sx * dx) + (sy * dy);
      const baseDim  = Math.max(30, origTextW + origH);
      const rawScale = Math.max(1 / origFS, 1 + deltaOut / baseDim);

      const newFS       = Math.max(1, Number((origFS * rawScale).toFixed(2)));
      const actualScale = newFS / origFS;
      let   newW        = Math.max(20, Number((origW * actualScale).toFixed(2)));
      const newH        = origH * actualScale;

      t.fontSize = newFS;
      t.width    = newW;

      // Lock the opposite text corner as fixed anchor
      if (dir === 'ne') {
        // Drag top-right → bottom-left text anchor stays fixed
        t.x = Number((origX + relTextLeft * (1 - actualScale)).toFixed(2));
        t.y = Number((origY + origH - newH).toFixed(2));
      } else if (dir === 'se') {
        // Drag bottom-right → top-left text anchor stays fixed
        t.x = Number((origX + relTextLeft * (1 - actualScale)).toFixed(2));
        t.y = Number(origY.toFixed(2));
      } else if (dir === 'nw') {
        // Drag top-left → bottom-right text anchor stays fixed
        t.x = Number((origX + relTextRight * (1 - actualScale)).toFixed(2));
        t.y = Number((origY + origH - newH).toFixed(2));
      } else if (dir === 'sw') {
        // Drag bottom-left → top-right text anchor stays fixed
        t.x = Number((origX + relTextRight * (1 - actualScale)).toFixed(2));
        t.y = Number(origY.toFixed(2));
      }
    } else if (dir === 'e') {
      // Right edge → adjust box width only, left stays fixed
      t.width = Math.max(20, Number((origW + dx).toFixed(2)));
    } else if (dir === 'w') {
      // Left edge → adjust box width only, right edge stays fixed
      const newW = Math.max(20, Number((origW - dx).toFixed(2)));
      t.x     = Number((origX + (origW - newW)).toFixed(2));
      t.width = newW;
    } else if (dir === 'n') {
      // Top edge → scale fontSize with bottom anchor fixed
      const rawScale    = Math.max(1 / origFS, 1 - dy / Math.max(20, origH));
      const newFS       = Math.max(1, Number((origFS * rawScale).toFixed(2)));
      const actualScale = newFS / origFS;
      const newH        = origH * actualScale;
      t.fontSize = newFS;
      t.width    = Math.max(20, Number((origW * actualScale).toFixed(2)));
      t.x        = Number((origX + relTextLeft * (1 - actualScale)).toFixed(2));
      t.y        = Number((origY + origH - newH).toFixed(2));
    } else if (dir === 's') {
      // Bottom edge → scale fontSize with top anchor fixed
      const rawScale    = Math.max(1 / origFS, 1 + dy / Math.max(20, origH));
      const newFS       = Math.max(1, Number((origFS * rawScale).toFixed(2)));
      const actualScale = newFS / origFS;
      t.fontSize = newFS;
      t.width    = Math.max(20, Number((origW * actualScale).toFixed(2)));
      t.x        = Number((origX + relTextLeft * (1 - actualScale)).toFixed(2));
      t.y        = Number(origY.toFixed(2));
    }

    const curEl = document.getElementById(`te-${id}`);
    if (curEl) {
      curEl.style.width     = t.width + 'px';
      curEl.style.left      = t.x + 'px';
      curEl.style.top       = t.y + 'px';
      curEl.style.minHeight = t.fontSize + 'px';
      const cnt = curEl.querySelector('.text-content');
      if (cnt) cnt.style.cssText = buildTextStyle(t);

      // Guard against accidental line-wrap caused by sub-pixel font hinting during uniform scale
      if (isCorner || dir === 'n' || dir === 's') {
        const actualScale = t.fontSize / origFS;
        const expectedH   = origH * actualScale;
        const renderedH   = curEl.getBoundingClientRect().height / z;
        if (renderedH > expectedH * 1.25) {
          t.width = Number((t.width + Math.max(4, t.fontSize * 0.25)).toFixed(2));
          curEl.style.width = t.width + 'px';
        }
      }
    }

    // Sync property panel with 0.01px precision
    const fsEl    = document.getElementById('prop-font-size');
    const fsNumEl = document.getElementById('prop-font-size-num');
    const fsVal   = document.getElementById('font-size-val');
    const pxEl    = document.getElementById('prop-x');
    const pyEl    = document.getElementById('prop-y');
    if (fsEl)    fsEl.value        = t.fontSize;
    if (fsNumEl) fsNumEl.value     = t.fontSize;
    if (fsVal)   fsVal.textContent = t.fontSize;
    if (pxEl)    pxEl.value        = t.x;
    if (pyEl)    pyEl.value        = t.y;

    renderCanvas();
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

// ─── Undo ──────────────────────────────────────────────────────────────────
function pushUndo() {
  App.undoStack.push(JSON.stringify(App.texts));
  if (App.undoStack.length > 30) App.undoStack.shift();
}

function editorUndo() {
  if (!App.undoStack.length) { toast('Tidak ada yang bisa di-undo', 'info'); return; }
  App.texts = JSON.parse(App.undoStack.pop());
  App.selectedTextId = null;
  renderTextOverlay();
  renderCanvas();
  hideTextProperties();
  toast('Undo berhasil', 'info');
}

// ─── Save Design ──────────────────────────────────────────────────────────
async function saveDesign() {
  const name = document.getElementById('editor-design-name').value.trim();
  if (!name) { toast('Masukkan nama design', 'error'); return; }

  showLoader('Menyimpan...');
  try {
    await api('PUT', `/api/admin/designs/${App.currentDesignId}`, {
      name,
      image_url: App.imageUrl,
      image_width: App.canvasW,
      image_height: App.canvasH,
      texts: App.texts
    });
    hideLoader();
    toast('Design berhasil disimpan!', 'success');
  } catch (err) {
    hideLoader();
    toast(err.message, 'error');
  }
}

// ─── Image Upload in Editor ───────────────────────────────────────────────
function triggerImageUpload() { document.getElementById('image-upload-input').click(); }

async function handleImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  showLoader('Upload gambar...');
  try {
    const fd = new FormData();
    fd.append('image', file);
    const res = await api('POST', '/api/upload/image', fd, true);
    // res.url is now a base64 data URL — store as App.imageUrl directly
    App.imageUrl = res.url;

    // Load from original file blob to get dimensions (fast, no network round-trip)
    const blobUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      App.canvasW = img.naturalWidth;
      App.canvasH = img.naturalHeight;
      document.getElementById('canvas-width-input').value = App.canvasW;
      document.getElementById('canvas-height-input').value = App.canvasH;
      const canvas = document.getElementById('main-canvas');
      canvas.width  = App.canvasW;
      canvas.height = App.canvasH;
      // Cache under the data URL key so getCachedImage finds it immediately
      imageCache[res.url] = img;
      URL.revokeObjectURL(blobUrl);
      renderCanvas();
    };
    img.src = blobUrl;
    hideLoader();
    toast('Gambar berhasil diupload!', 'success');
  } catch (err) {
    hideLoader();
    toast(err.message, 'error');
  }
  event.target.value = '';
}

// ─── Share Modal ──────────────────────────────────────────────────────────
let shareDesignId = null;

async function openShareModal() {
  shareDesignId = App.currentDesignId;
  document.getElementById('share-search').value = '';
  document.getElementById('user-search-results').classList.add('hidden');
  await loadSharedUsers();
  openModal('modal-share');
}

async function openShareModalFor(designId) {
  shareDesignId = designId;
  document.getElementById('share-search').value = '';
  document.getElementById('user-search-results').classList.add('hidden');
  await loadSharedUsers();
  openModal('modal-share');
}

async function loadSharedUsers() {
  const list = document.getElementById('shared-users-list');
  list.innerHTML = '<div class="loading-state" style="padding:12px"><div class="spinner"></div></div>';
  try {
    const design = await api('GET', `/api/admin/designs/${shareDesignId}`);
    const shares = design.shares || [];
    if (!shares.length) {
      list.innerHTML = '<div class="empty-state-sm">Belum ada user yang di-share</div>';
    } else {
      list.innerHTML = shares.map(u => `
        <div class="shared-user-item">
          <div class="user-avatar user-avatar-client">${u.username[0].toUpperCase()}</div>
          <div><div style="font-weight:600">${escHtml(u.username)}</div><div style="font-size:11px;color:var(--text-muted)">${escHtml(u.email)}</div></div>
          <button class="remove-share" onclick="removeShare('${u.id}')" title="Hapus akses">✕</button>
        </div>
      `).join('');
    }
  } catch {}
}

let selectedShareUser = null;
function searchUsers(q) {
  clearTimeout(App.searchTimer);
  if (!q || q.length < 2) { document.getElementById('user-search-results').classList.add('hidden'); return; }
  App.searchTimer = setTimeout(async () => {
    try {
      const users = await api('GET', `/api/admin/users/search?q=${encodeURIComponent(q)}`);
      const results = document.getElementById('user-search-results');
      if (!users.length) { results.innerHTML = '<div class="search-result-item" style="color:var(--text-muted)">User tidak ditemukan</div>'; }
      else {
        results.innerHTML = users.map(u => `
          <div class="search-result-item" onclick="selectShareUser('${u.email}', this)">
            <div class="user-avatar user-avatar-client" style="width:24px;height:24px;font-size:11px">${u.username[0].toUpperCase()}</div>
            <div><div style="font-weight:600;font-size:13px">${escHtml(u.username)}</div><div style="font-size:11px;color:var(--text-muted)">${escHtml(u.email)}</div></div>
          </div>`).join('');
      }
      results.classList.remove('hidden');
    } catch {}
  }, 300);
}

function selectShareUser(email, el) {
  document.getElementById('share-search').value = email;
  document.getElementById('user-search-results').classList.add('hidden');
}

async function shareDesign() {
  const emailOrUsername = document.getElementById('share-search').value.trim();
  if (!emailOrUsername) { toast('Masukkan email atau username', 'error'); return; }
  try {
    await api('POST', `/api/admin/designs/${shareDesignId}/share`, { emailOrUsername });
    toast('Design berhasil di-share!', 'success');
    document.getElementById('share-search').value = '';
    await loadSharedUsers();
  } catch (err) { toast(err.message, 'error'); }
}

async function removeShare(userId) {
  try {
    await api('DELETE', `/api/admin/designs/${shareDesignId}/share/${userId}`);
    toast('Akses dihapus', 'info');
    await loadSharedUsers();
  } catch (err) { toast(err.message, 'error'); }
}

// ─── Font Management ───────────────────────────────────────────────────────
async function loadAllFontsIntoSelect() {
  try {
    const fonts = await api('GET', '/api/fonts');
    App.customFonts = fonts;

    const gGroup = document.getElementById('google-fonts-group');
    const cGroup = document.getElementById('custom-fonts-group');
    if (gGroup) gGroup.innerHTML = '';
    if (cGroup) cGroup.innerHTML = '';

    fonts.forEach(f => {
      if (f.type === 'google') {
        injectGoogleFont(f.url, f.name);
        if (gGroup) { const opt = document.createElement('option'); opt.value = f.name; opt.textContent = f.name; gGroup.appendChild(opt); }
      } else if (f.type === 'upload') {
        injectUploadFont(f.url, f.name);
        if (cGroup) { const opt = document.createElement('option'); opt.value = f.name; opt.textContent = f.name; cGroup.appendChild(opt); }
      }
    });
  } catch {}
}

function injectGoogleFont(url, name) {
  if (document.querySelector(`link[data-font="${name}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = url;
  link.setAttribute('data-font', name);
  document.head.appendChild(link);
}

function injectUploadFont(url, name) {
  if (document.querySelector(`style[data-font="${name}"]`)) return;
  const style = document.createElement('style');
  style.setAttribute('data-font', name);
  style.textContent = `@font-face { font-family: "${name}"; src: url("${url}"); }`;
  document.head.appendChild(style);
}

async function loadFonts() {
  const grid = document.getElementById('fonts-grid');
  grid.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Memuat font...</span></div>';
  try {
    const fonts = await api('GET', '/api/fonts');
    if (!fonts.length) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><h3>Belum ada font kustom</h3><p>Tambah font dari Google Fonts atau upload file font</p></div>';
      return;
    }
    grid.innerHTML = fonts.map(f => {
      if (f.type === 'google') injectGoogleFont(f.url, f.name);
      else if (f.type === 'upload') injectUploadFont(f.url, f.name);
      return `
        <div class="font-card">
          <div class="font-card-name">${escHtml(f.name)}</div>
          <div class="font-card-preview" style="font-family:'${escHtml(f.name)}',sans-serif">Aa Bb 123</div>
          <div class="font-card-type">
            <span class="tag ${f.type === 'google' ? 'tag-google' : 'tag-upload'}">${f.type === 'google' ? 'Google Font' : 'Upload'}</span>
          </div>
          <div class="font-card-actions">
            <button class="btn-icon btn-sm btn-danger" onclick="deleteFont('${f.id}')" title="Hapus">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    grid.innerHTML = `<div class="empty-state"><p>Gagal memuat: ${err.message}</p></div>`;
  }
}

async function deleteFont(id) {
  if (!confirm('Hapus font ini?')) return;
  try {
    await api('DELETE', `/api/fonts/${id}`);
    toast('Font dihapus', 'success');
    loadFonts();
  } catch (err) { toast(err.message, 'error'); }
}

let fontFileSelected = null;
function openAddFontModal() {
  fontFileSelected = null;
  document.getElementById('gf-name').value = '';
  document.getElementById('gf-url').value = '';
  document.getElementById('uf-name').value = '';
  document.getElementById('font-upload-label').textContent = 'Klik untuk upload file font';
  document.getElementById('gf-preview').classList.add('hidden');
  openModal('modal-add-font');
}

function switchFontTab(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('font-tab-google').classList.toggle('hidden', tab !== 'google');
  document.getElementById('font-tab-upload').classList.toggle('hidden', tab !== 'upload');
}

function handleFontFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  fontFileSelected = file;
  document.getElementById('font-upload-label').textContent = `✓ ${file.name}`;
  if (!document.getElementById('uf-name').value) {
    document.getElementById('uf-name').value = file.name.replace(/\.[^.]+$/, '');
  }
}

async function previewGoogleFont() {
  const name = document.getElementById('gf-name').value.trim();
  const url = document.getElementById('gf-url').value.trim();
  if (!name || !url) { toast('Masukkan nama dan URL font', 'error'); return; }
  injectGoogleFont(url, name);
  const preview = document.getElementById('gf-preview');
  preview.style.fontFamily = `"${name}", sans-serif`;
  preview.textContent = `${name}: Aa Bb Cc 123`;
  preview.classList.remove('hidden');
}

async function addFont() {
  const activeTab = document.querySelector('.tab-btn.active').textContent.includes('Google') ? 'google' : 'upload';

  if (activeTab === 'google') {
    const name = document.getElementById('gf-name').value.trim();
    const url = document.getElementById('gf-url').value.trim();
    if (!name || !url) { toast('Nama dan URL harus diisi', 'error'); return; }
    try {
      showLoader('Menambah font...');
      await api('POST', '/api/fonts/google', { name, url });
      hideLoader(); closeModal('modal-add-font');
      toast(`Font "${name}" berhasil ditambahkan!`, 'success');
      loadFonts();
    } catch (err) { hideLoader(); toast(err.message, 'error'); }
  } else {
    if (!fontFileSelected) { toast('Pilih file font terlebih dahulu', 'error'); return; }
    const name = document.getElementById('uf-name').value.trim() || fontFileSelected.name.replace(/\.[^.]+$/, '');
    const fd = new FormData();
    fd.append('font', fontFileSelected);
    fd.append('name', name);
    try {
      showLoader('Upload font...');
      await api('POST', '/api/upload/font', fd, true);
      hideLoader(); closeModal('modal-add-font');
      toast(`Font "${name}" berhasil diupload!`, 'success');
      loadFonts();
    } catch (err) { hideLoader(); toast(err.message, 'error'); }
  }
}

// ─── Download Client Design (JPG, no text boxes) ───────────────────────────
async function downloadClientDesign() {
  const canvas = document.getElementById('client-canvas');
  if (!canvas || !App.clientDesignData) return;

  showLoader('Menyiapkan download...');

  try {
    // 1. Ensure the background image is fully loaded into cache first
    const d = App.clientDesignData;
    if (d.image_url) {
      await new Promise((resolve) => {
        const absUrl = d.image_url.startsWith('/') ? (window.location.origin + d.image_url) : d.image_url;
        // Already cached?
        if (imageCache[absUrl] || imageCache[d.image_url]) return resolve();
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          imageCache[absUrl] = img;
          imageCache[d.image_url] = img;
          resolve();
        };
        img.onerror = () => resolve(); // resolve anyway so download still proceeds
        img.src = absUrl;
      });
    }

    // 2. Render canvas cleanly WITHOUT dashed indicators and WITHOUT selection
    const prevSelected = App.selectedTextId;
    App.selectedTextId = null;
    renderClientCanvas(true); // true = skipIndicators

    // 3. Wait a paint tick for canvas to flush
    await new Promise(r => setTimeout(r, 80));

    const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
    const link = document.createElement('a');
    link.download = `${App.clientDesignData.name || 'design'}.jpg`;
    link.href = dataUrl;
    link.click();

    hideLoader();
    toast('Design berhasil didownload (.jpg)!', 'success');

    // 4. Restore canvas with indicators
    App.selectedTextId = prevSelected;
    renderClientCanvas();

  } catch (err) {
    hideLoader();
    toast('Gagal download: ' + err.message, 'error');
    renderClientCanvas();
  }
}

// ─── Modal Helpers ─────────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });
});

// ─── Escape HTML ──────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const onEditor       = document.getElementById('page-editor').classList.contains('active');
  const onClientEditor = document.getElementById('page-client-editor').classList.contains('active');
  const onAny = onEditor || onClientEditor;
  const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;

  // Space → pan mode (grab cursor)
  if (e.code === 'Space' && onAny && !isInput) {
    e.preventDefault();
    if (!ViewState.spacePanning) {
      ViewState.spacePanning = true;
      const oid = onEditor ? 'canvas-outer' : 'client-canvas-outer';
      _setPanCursor(document.getElementById(oid), 'ready');
    }
    return;
  }

  // Delete / Backspace → delete selected text
  if (!isInput && (e.key === 'Delete' || e.key === 'Backspace')) {
    if (onEditor && App.selectedTextId) deleteSelectedText();
  }

  // Ctrl+Z → undo
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    if (onEditor) { e.preventDefault(); editorUndo(); }
  }

  // Ctrl+B / Ctrl+I / Ctrl+U → toggle Bold / Italic / Underline (for selection or whole text)
  if ((e.ctrlKey || e.metaKey) && onEditor && App.selectedTextId) {
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); toggleStyle('bold'); return; }
    if (k === 'i') { e.preventDefault(); toggleStyle('italic'); return; }
    if (k === 'u') { e.preventDefault(); toggleStyle('underline'); return; }
  }

  // Ctrl+C → copy selected text element (only when not inside input/textarea)
  if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !isInput) {
    if (onEditor && App.selectedTextId && !window.getSelection()?.toString()) {
      e.preventDefault();
      copySelectedText();
    }
  }

  // Ctrl+V → paste copied text element (only when not inside input/textarea)
  if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !isInput) {
    if (onEditor && App.clipboard) {
      e.preventDefault();
      pasteText();
    }
  }

  // Escape → deselect text / release pan
  if (!isInput && e.key === 'Escape') {
    if (onEditor) deselectText();
  }

  // ─── Zoom shortcuts ───────────────────────────────────────────────────────
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
    if (onAny) { e.preventDefault(); if (onEditor) adjustAdminZoom(0.2); else adjustClientZoom(0.2); }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === '-') {
    if (onAny) { e.preventDefault(); if (onEditor) adjustAdminZoom(-0.2); else adjustClientZoom(-0.2); }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === '0') {
    if (onAny) { e.preventDefault(); if (onEditor) resetAdminZoom(); else resetClientZoom(); }
  }
});

document.addEventListener('keyup', e => {
  if (e.code === 'Space' && ViewState.spacePanning) {
    ViewState.spacePanning = false;
    ['canvas-outer', 'client-canvas-outer'].forEach(id => {
      const el = document.getElementById(id);
      if (el) _setPanCursor(el, '');
    });
  }
});

// Click outside text to deselect
document.getElementById('main-canvas')?.addEventListener('click', deselectText);

// ─── On resize/orientation change: fix client canvas transform on mobile ───
window.addEventListener('resize', () => {
  const onClientEditor = document.getElementById('page-client-editor')?.classList.contains('active');
  if (onClientEditor) {
    // Re-apply view so mobile gets transform:none and desktop gets correct pan
    applyClientView();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────
(function init() {
  if (App.token && App.user) {
    navigateByRole();
  } else {
    showPage('page-auth');
  }
})();
