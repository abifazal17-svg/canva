const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'canva-clone-super-secret-key-2024';

// ─── Setup Directories ───────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const FONTS_DIR = path.join(__dirname, 'public', 'fonts');
const IMAGES_DIR = path.join(__dirname, 'public', 'uploads', 'images');

[UPLOADS_DIR, FONTS_DIR, IMAGES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Database Setup ───────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'database.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'client',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS designs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image_url TEXT,
    image_width INTEGER DEFAULT 800,
    image_height INTEGER DEFAULT 600,
    texts TEXT DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS design_shares (
    id TEXT PRIMARY KEY,
    design_id TEXT NOT NULL,
    shared_with TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (design_id) REFERENCES designs(id),
    FOREIGN KEY (shared_with) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS client_designs (
    id TEXT PRIMARY KEY,
    design_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    form_values TEXT DEFAULT '{}',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (design_id) REFERENCES designs(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS fonts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    url TEXT,
    file_path TEXT,
    uploaded_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed admin user
const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
if (!adminExists) {
  const hashedPw = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (id, email, username, password, role) VALUES (?, ?, ?, ?, ?)').run(
    uuidv4(), 'admin@canva.com', 'admin', hashedPw, 'admin'
  );
  console.log('✅ Admin seeded: admin@canva.com / admin123');
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer for image uploads
const imageStorage = multer.diskStorage({
  destination: IMAGES_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `img-${uuidv4()}${ext}`);
  }
});
const uploadImage = multer({ storage: imageStorage, limits: { fileSize: 20 * 1024 * 1024 } });

// Multer for font uploads
const fontStorage = multer.diskStorage({
  destination: FONTS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, ext).replace(/\s+/g, '-');
    cb(null, `font-${baseName}-${Date.now()}${ext}`);
  }
});
const uploadFont = multer({ storage: fontStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password) return res.status(400).json({ error: 'All fields required' });

  try {
    const hashedPw = bcrypt.hashSync(password, 10);
    const id = uuidv4();
    db.prepare('INSERT INTO users (id, email, username, password, role) VALUES (?, ?, ?, ?, ?)').run(
      id, email.toLowerCase(), username, hashedPw, 'client'
    );
    const token = jwt.sign({ id, email, username, role: 'client' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id, email, username, role: 'client' } });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email atau username sudah terdaftar' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Email atau password salah' });
  }
  const token = jwt.sign({ id: user.id, email: user.email, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, username: user.username, role: user.role } });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json(req.user);
});

// ─── Design Routes (Admin) ────────────────────────────────────────────────────
app.get('/api/admin/designs', adminMiddleware, (req, res) => {
  const designs = db.prepare(`
    SELECT d.*, 
      (SELECT COUNT(*) FROM design_shares WHERE design_id = d.id) as share_count
    FROM designs d WHERE d.created_by = ? ORDER BY d.created_at DESC
  `).all(req.user.id);
  res.json(designs.map(d => ({ ...d, texts: JSON.parse(d.texts || '[]') })));
});

app.post('/api/admin/designs', adminMiddleware, (req, res) => {
  const { name, image_url, image_width, image_height, texts } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO designs (id, name, image_url, image_width, image_height, texts, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, name, image_url, image_width || 800, image_height || 600, JSON.stringify(texts || []), req.user.id
  );
  res.json({ id, name, image_url, texts: texts || [] });
});

app.get('/api/admin/designs/:id', adminMiddleware, (req, res) => {
  const design = db.prepare('SELECT * FROM designs WHERE id = ? AND created_by = ?').get(req.params.id, req.user.id);
  if (!design) return res.status(404).json({ error: 'Design not found' });
  const shares = db.prepare(`
    SELECT u.id, u.email, u.username FROM design_shares ds
    JOIN users u ON u.id = ds.shared_with WHERE ds.design_id = ?
  `).all(design.id);
  res.json({ ...design, texts: JSON.parse(design.texts || '[]'), shares });
});

app.put('/api/admin/designs/:id', adminMiddleware, (req, res) => {
  const { name, image_url, image_width, image_height, texts } = req.body;
  db.prepare(`
    UPDATE designs SET name = ?, image_url = ?, image_width = ?, image_height = ?, texts = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND created_by = ?
  `).run(name, image_url, image_width || 800, image_height || 600, JSON.stringify(texts || []), req.params.id, req.user.id);
  res.json({ success: true });
});

app.delete('/api/admin/designs/:id', adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM design_shares WHERE design_id = ?').run(req.params.id);
  db.prepare('DELETE FROM client_designs WHERE design_id = ?').run(req.params.id);
  db.prepare('DELETE FROM designs WHERE id = ? AND created_by = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

// Share design
app.post('/api/admin/designs/:id/share', adminMiddleware, (req, res) => {
  const { emailOrUsername } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(emailOrUsername?.toLowerCase(), emailOrUsername);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Tidak bisa share ke admin' });

  const existing = db.prepare('SELECT id FROM design_shares WHERE design_id = ? AND shared_with = ?').get(req.params.id, user.id);
  if (existing) return res.status(400).json({ error: 'Design sudah di-share ke user ini' });

  db.prepare('INSERT INTO design_shares (id, design_id, shared_with) VALUES (?, ?, ?)').run(uuidv4(), req.params.id, user.id);
  
  // Create client design record
  const cdExists = db.prepare('SELECT id FROM client_designs WHERE design_id = ? AND user_id = ?').get(req.params.id, user.id);
  if (!cdExists) {
    db.prepare('INSERT INTO client_designs (id, design_id, user_id, form_values) VALUES (?, ?, ?, ?)').run(uuidv4(), req.params.id, user.id, '{}');
  }
  
  res.json({ success: true, user: { id: user.id, email: user.email, username: user.username } });
});

app.delete('/api/admin/designs/:id/share/:userId', adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM design_shares WHERE design_id = ? AND shared_with = ?').run(req.params.id, req.params.userId);
  res.json({ success: true });
});

// ─── Upload Routes ────────────────────────────────────────────────────────────
app.post('/api/upload/image', adminMiddleware, uploadImage.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/images/${req.file.filename}` });
});

app.post('/api/upload/font', adminMiddleware, uploadFont.single('font'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const fontName = req.body.name || path.basename(req.file.originalname, path.extname(req.file.originalname));
  const id = uuidv4();
  db.prepare('INSERT INTO fonts (id, name, type, url, file_path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, fontName, 'upload', `/fonts/${req.file.filename}`, req.file.path, req.user.id
  );
  res.json({ id, name: fontName, url: `/fonts/${req.file.filename}`, type: 'upload' });
});

// Add Google Font
app.post('/api/fonts/google', adminMiddleware, (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });
  const id = uuidv4();
  db.prepare('INSERT INTO fonts (id, name, type, url, uploaded_by) VALUES (?, ?, ?, ?, ?)').run(
    id, name, 'google', url, req.user.id
  );
  res.json({ id, name, url, type: 'google' });
});

app.get('/api/fonts', authMiddleware, (req, res) => {
  const fonts = db.prepare('SELECT * FROM fonts ORDER BY created_at DESC').all();
  res.json(fonts);
});

app.delete('/api/fonts/:id', adminMiddleware, (req, res) => {
  const font = db.prepare('SELECT * FROM fonts WHERE id = ?').get(req.params.id);
  if (font && font.file_path) {
    try { fs.unlinkSync(font.file_path); } catch {}
  }
  db.prepare('DELETE FROM fonts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Client Routes ────────────────────────────────────────────────────────────
app.get('/api/client/designs', authMiddleware, (req, res) => {
  if (req.user.role === 'admin') return res.json([]);
  const designs = db.prepare(`
    SELECT d.*, cd.id as cd_id, cd.form_values
    FROM design_shares ds
    JOIN designs d ON d.id = ds.design_id
    JOIN client_designs cd ON cd.design_id = d.id AND cd.user_id = ds.shared_with
    WHERE ds.shared_with = ?
    ORDER BY ds.created_at DESC
  `).all(req.user.id);
  res.json(designs.map(d => ({
    ...d,
    texts: JSON.parse(d.texts || '[]'),
    form_values: JSON.parse(d.form_values || '{}')
  })));
});

app.get('/api/client/designs/:id', authMiddleware, (req, res) => {
  const share = db.prepare('SELECT * FROM design_shares WHERE design_id = ? AND shared_with = ?').get(req.params.id, req.user.id);
  if (!share && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
  
  const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(req.params.id);
  if (!design) return res.status(404).json({ error: 'Design not found' });
  
  const clientDesign = db.prepare('SELECT * FROM client_designs WHERE design_id = ? AND user_id = ?').get(req.params.id, req.user.id);
  res.json({
    ...design,
    texts: JSON.parse(design.texts || '[]'),
    form_values: JSON.parse(clientDesign?.form_values || '{}')
  });
});

app.put('/api/client/designs/:id/form', authMiddleware, (req, res) => {
  const { form_values } = req.body;
  const result = db.prepare(`
    UPDATE client_designs SET form_values = ?, updated_at = CURRENT_TIMESTAMP
    WHERE design_id = ? AND user_id = ?
  `).run(JSON.stringify(form_values), req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Client design not found' });
  res.json({ success: true });
});

// Search users (admin only)
app.get('/api/admin/users/search', adminMiddleware, (req, res) => {
  const { q } = req.query;
  const users = db.prepare(`
    SELECT id, email, username FROM users 
    WHERE role = 'client' AND (email LIKE ? OR username LIKE ?)
    LIMIT 10
  `).all(`%${q}%`, `%${q}%`);
  res.json(users);
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log(`👤 Admin: admin@canva.com / admin123`);
});
