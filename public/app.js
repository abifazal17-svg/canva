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
  // On mobile the container is position:relative and fills width naturally;
  // skip the JS transform so the canvas doesn't get clipped or offset.
  if (c && window.innerWidth > 768) {
    c.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
  } else if (c) {
    c.style.transform = 'none';
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
    e.preventDefault();
    if (e.touches.length === 2 && ViewState.pinchDist !== null) {
      const dist = getPinchDist(e.touches);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const ratio = dist / ViewState.pinchDist;
      const dz = (ratio - 1) * ViewState[mode].zoom;
      zoomAtPoint(dz, midX, midY, mode);
      ViewState.pinchDist = dist;
    } else if (e.touches.length === 1 && touchPanStart) {
      const dx = e.touches[0].clientX - touchPanStart.x;
      const dy = e.touches[0].clientY - touchPanStart.y;
      ViewState[mode].panX = touchPanStart.panX + dx;
      ViewState[mode].panY = touchPanStart.panY + dy;
      if (mode === 'admin') applyAdminView(); else applyClientView();
    }
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
  setActiveNav('nav-designs');
  loadAdminDesigns();
}

function adminShowFonts() {
  document.getElementById('admin-designs-section').classList.add('hidden');
  document.getElementById('admin-fonts-section').classList.remove('hidden');
  setActiveNav('nav-fonts');
  loadFonts();
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
    ? `<img src="${d.image_url}" alt="${d.name}" loading="lazy">`
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
    if (t.formName && App.clientFormValues[t.formName] !== undefined) {
      content = App.clientFormValues[t.formName];
    }
    drawTextOnCanvas(ctx, { ...t, content });

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
function getCachedImage(url, onLoad) {
  // Make relative paths absolute so they load on any device/IP
  const absUrl = url && url.startsWith('/') ? (window.location.origin + url) : url;
  if (!absUrl) return null;
  // Check both absolute and relative key (for backwards-compat with handleImageUpload cache)
  if (imageCache[absUrl]) return imageCache[absUrl];
  if (imageCache[url]) return imageCache[url];
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload  = () => { imageCache[absUrl] = img; imageCache[url] = img; onLoad && onLoad(); };
  img.onerror = () => { console.warn('[DesignCraft] Failed to load image:', absUrl); };
  img.src = absUrl;
  return null;
}

function drawGrid(ctx, w, h) {
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  const step = 40;
  for (let x = 0; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
}

function drawTextOnCanvas(ctx, t) {
  if (!t || !t.content) return;
  ctx.save();
  ctx.globalAlpha = t.opacity !== undefined ? t.opacity / 100 : 1;

  const fontStyle = [
    t.italic ? 'italic' : '',
    t.bold ? 'bold' : '400',
    `${t.fontSize || 24}px`,
    `"${t.fontFamily || 'Inter'}", sans-serif`
  ].filter(Boolean).join(' ');

  ctx.font = fontStyle;
  ctx.fillStyle = t.color || '#ffffff';
  ctx.textAlign = t.align || 'left';

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

  const lines = wrapText(ctx, t.content, maxW);
  lines.forEach((line, i) => {
    let drawX = x;
    if (t.align === 'center') drawX = x + maxW / 2;
    else if (t.align === 'right') drawX = x + maxW;
    ctx.fillText(line, drawX, y + (t.fontSize || 24) + i * lineH);

    if (t.underline) {
      const lw = ctx.measureText(line).width;
      const uy = y + (t.fontSize || 24) + i * lineH + 2;
      let ux = x;
      if (t.align === 'center') ux = x + maxW / 2 - lw / 2;
      else if (t.align === 'right') ux = x + maxW - lw;
      ctx.strokeStyle = t.color || '#fff';
      ctx.lineWidth = Math.max(1, (t.fontSize || 24) / 16);
      ctx.beginPath(); ctx.moveTo(ux, uy); ctx.lineTo(ux + lw, uy); ctx.stroke();
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
  content.textContent = t.content || 'Teks Baru';
  el.appendChild(content);

  if (t.id === App.selectedTextId) {
    ['nw','n','ne','e','se','s','sw','w'].forEach(dir => {
      const handle = document.createElement('div');
      handle.className = `resize-handle resize-handle-${dir}`;
      el.appendChild(handle);
      handle.addEventListener('mousedown', e => startResizeHandle(e, t.id, dir));
    });
  }

  el.addEventListener('mousedown', e => {
    if (e.target.classList.contains('resize-handle')) return;
    if (e.altKey) {
      // Alt + drag → duplicate then drag the copy
      e.preventDefault(); e.stopPropagation();
      altDuplicateDrag(e, t);
      return;
    }
    selectText(t.id);
    startDrag(e, t.id);
  });

  return el;
}


function buildTextStyle(t) {
  return `
    font-family: "${t.fontFamily || 'Inter'}", sans-serif;
    font-size: ${t.fontSize || 24}px;
    font-weight: ${t.bold ? 'bold' : '400'};
    font-style: ${t.italic ? 'italic' : 'normal'};
    text-decoration: ${t.underline ? 'underline' : 'none'};
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
  App.selectedTextId = id;
  renderTextOverlay();
  const t = App.texts.find(x => x.id === id);
  if (!t) { hideTextProperties(); return; }
  showTextProperties(t);
}

function deselectText() {
  App.selectedTextId = null;
  renderTextOverlay();
  hideTextProperties();
}

function deleteSelectedText() {
  if (!App.selectedTextId) return;
  pushUndo();
  App.texts = App.texts.filter(t => t.id !== App.selectedTextId);
  App.selectedTextId = null;
  renderTextOverlay();
  hideTextProperties();
  toast('Teks dihapus', 'info');
}

function showTextProperties(t) {
  document.getElementById('no-selection-msg').classList.add('hidden');
  document.getElementById('text-properties').classList.remove('hidden');
  document.getElementById('btn-delete-text').classList.remove('hidden');

  document.getElementById('prop-content').value = t.content || '';
  document.getElementById('prop-form-name').value = t.formName || '';
  document.getElementById('prop-font').value = t.fontFamily || 'Inter';
  document.getElementById('prop-font-size').value = t.fontSize || 24;
  document.getElementById('font-size-val').textContent = t.fontSize || 24;
  document.getElementById('prop-color').value = t.color || '#ffffff';
  document.getElementById('prop-color-hex').value = t.color || '#ffffff';
  document.getElementById('prop-x').value = Math.round(t.x || 0);
  document.getElementById('prop-y').value = Math.round(t.y || 0);
  document.getElementById('prop-opacity').value = t.opacity !== undefined ? t.opacity : 100;
  document.getElementById('opacity-val').textContent = t.opacity !== undefined ? t.opacity : 100;
  document.getElementById('prop-shadow').checked = !!t.shadow;
  document.getElementById('prop-shadow-blur').value = t.shadowBlur || 4;
  document.getElementById('prop-shadow-color').value = t.shadowColor || '#000000';
  document.getElementById('shadow-detail').style.display = t.shadow ? 'flex' : 'none';
  document.getElementById('shadow-detail').style.flexDirection = 'column';

  // Style buttons
  ['bold','italic','underline'].forEach(s => {
    document.getElementById(`btn-${s}`).classList.toggle('active', !!t[s]);
  });

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
  t[prop] = value;

  const el = document.getElementById(`te-${t.id}`);
  if (el) {
    const content = el.querySelector('.text-content');
    if (prop === 'content') content.textContent = value;
    else if (prop === 'x') el.style.left = value + 'px';
    else if (prop === 'y') el.style.top = value + 'px';
    else content.style.cssText = buildTextStyle(t);
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
  document.getElementById('font-size-val').textContent = val;
  updateSelectedText('fontSize', parseInt(val));
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
  t[style] = !t[style];
  document.getElementById(`btn-${style}`).classList.toggle('active', t[style]);
  const el = document.getElementById(`te-${t.id}`);
  if (el) el.querySelector('.text-content').style.cssText = buildTextStyle(t);
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
  const origX = t.x, origY = t.y;
  let moved = false;

  function onMove(e2) {
    moved = true;
    const z  = ViewState.admin.zoom;    // divide by zoom so drag speed matches visual
    const dx = (e2.clientX - startX) / z;
    const dy = (e2.clientY - startY) / z;
    t.x = Math.max(0, origX + dx);
    t.y = Math.max(0, origY + dy);
    const el = document.getElementById(`te-${id}`);
    if (el) { el.style.left = t.x + 'px'; el.style.top = t.y + 'px'; }
    const px = document.getElementById('prop-x');
    const py = document.getElementById('prop-y');
    if (px) px.value = Math.round(t.x);
    if (py) py.value = Math.round(t.y);
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

// ─── Resize Handle (8-directional, zoom-aware) ───────────────────────────
/**
 * dir: 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'
 *
 * Horizontal handles (e/w/ne/nw/se/sw) → resize width (and x for west side)
 * Vertical  handles (n/s)              → resize fontSize (text height is font-driven)
 */
function startResizeHandle(e, id, dir) {
  e.preventDefault();
  e.stopPropagation();
  const t = App.texts.find(x => x.id === id);
  if (!t) return;
  pushUndo();

  const startX   = e.clientX;
  const startY   = e.clientY;
  const origX    = t.x;
  const origW    = t.width    || 200;
  const origFS   = t.fontSize || 24;

  function onMove(e2) {
    const z  = ZoomState.admin;
    const dx = (e2.clientX - startX) / z;
    const dy = (e2.clientY - startY) / z;

    // ─ Horizontal (width) ─
    if (dir.includes('e')) {
      t.width = Math.max(40, origW + dx);
    } else if (dir.includes('w')) {
      const newW = Math.max(40, origW - dx);
      t.x    = origX + (origW - newW);   // keep right edge fixed
      t.width = newW;
    }

    // ─ Vertical (font size) ─
    if (dir === 'n' || dir === 'nw' || dir === 'ne') {
      t.fontSize = Math.max(6, Math.round(origFS - dy * 0.7));
    } else if (dir === 's' || dir === 'sw' || dir === 'se') {
      t.fontSize = Math.max(6, Math.round(origFS + dy * 0.7));
    }

    const el = document.getElementById(`te-${id}`);
    if (el) {
      el.style.width    = (t.width || origW) + 'px';
      el.style.left     = t.x + 'px';
      el.style.minHeight = (t.fontSize || origFS) + 'px';
      const cnt = el.querySelector('.text-content');
      if (cnt) cnt.style.cssText = buildTextStyle(t);
    }

    // Sync property panel
    const fsEl = document.getElementById('prop-font-size');
    const fsVal = document.getElementById('font-size-val');
    const pxEl  = document.getElementById('prop-x');
    if (fsEl)  fsEl.value = t.fontSize || origFS;
    if (fsVal) fsVal.textContent = t.fontSize || origFS;
    if (pxEl)  pxEl.value = Math.round(t.x);

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
    App.imageUrl = res.url;
    // Update canvas size based on image
    const img = new Image();
    img.onload = () => {
      App.canvasW = img.naturalWidth;
      App.canvasH = img.naturalHeight;
      document.getElementById('canvas-width-input').value = App.canvasW;
      document.getElementById('canvas-height-input').value = App.canvasH;
      const canvas = document.getElementById('main-canvas');
      canvas.width = App.canvasW;
      canvas.height = App.canvasH;
      // Store with both relative and absolute URL keys so getCachedImage finds it
      const absUrl = res.url.startsWith('/') ? (window.location.origin + res.url) : res.url;
      imageCache[res.url] = img;
      imageCache[absUrl] = img;
      renderCanvas();
    };
    img.src = res.url;
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
  const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

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

  // Ctrl+C → copy selected text element
  if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
    if (onEditor && App.selectedTextId) {
      // Only intercept if a text element is selected; else let OS copy work normally
      e.preventDefault();
      copySelectedText();
    }
  }

  // Ctrl+V → paste copied text element
  if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
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
