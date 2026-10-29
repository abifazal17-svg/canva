const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'canva-clone-super-secret-key-2024';

// ─── Setup Directories ───────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const FONTS_DIR = path.join(__dirname, 'public', 'fonts');
const IMAGES_DIR = path.join(__dirname, 'public', 'uploads', 'images');

[UPLOADS_DIR, FONTS_DIR, IMAGES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Database Setup (MySQL / phpMyAdmin) ──────────────────────────────────────
const db = mysql.createPool({
  host: process.env.DB_HOST || 'db.fr-roub1.bengt.wasmernet.com',
  user: process.env.DB_USER || 'user_a7d99fd8',
  password: process.env.DB_PASSWORD || 'pw_5fZnvLKFBu19OGf6G6nhM6qzyDKk01T6',
  database: process.env.DB_NAME || 'db_39444a4c',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Seed Admin User & Check DB Connection
async function initDB() {
  try {
    const [rows] = await db.execute('SELECT id FROM users WHERE role = ?', ['admin']);
    if (rows.length === 0) {
      const hashedPw = bcrypt.hashSync('admin123', 10);
      await db.execute(
        'INSERT INTO users (id, email, username, password, role) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), 'admin@canva.com', 'admin', hashedPw, 'admin']
      );
      console.log('✅ Admin seeded: admin@canva.com / admin123');
    } else {
      console.log('✅ Database connected & initialized successfully.');
    }
  } catch (err) {
    console.error('❌ Error initializing DB:', err.message);
  }
}
initDB();

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
app.post('/api/auth/register', async (req, res) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password) return res.status(400).json({ error: 'All fields required' });

  try {
    const hashedPw = bcrypt.hashSync(password, 10);
    const id = uuidv4();
    await db.execute(
      'INSERT INTO users (id, email, username, password, role) VALUES (?, ?, ?, ?, ?)',
      [id, email.toLowerCase(), username, hashedPw, 'client']
    );
    const token = jwt.sign({ id, email, username, role: 'client' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id, email, username, role: 'client' } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Email atau username sudah terdaftar' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email?.toLowerCase()]);
    const user = users[0];

    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Email atau password salah' });
    }
    const token = jwt.sign({ id: user.id, email: user.email, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json(req.user);
});

// ─── Design Routes (Admin) ────────────────────────────────────────────────────
app.get('/api/admin/designs', adminMiddleware, async (req, res) => {
  try {
    const [designs] = await db.execute(`
      SELECT d.*, 
        (SELECT COUNT(*) FROM design_shares WHERE design_id = d.id) as share_count
      FROM designs d WHERE d.created_by = ? ORDER BY d.created_at DESC
    `, [req.user.id]);
    res.json(designs.map(d => ({ ...d, texts: JSON.parse(d.texts || '[]') })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/designs', adminMiddleware, async (req, res) => {
  const { name, image_url, image_width, image_height, texts } = req.body;
  const id = uuidv4();
  try {
    await db.execute(
      'INSERT INTO designs (id, name, image_url, image_width, image_height, texts, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, image_url, image_width || 800, image_height || 600, JSON.stringify(texts || []), req.user.id]
    );
    res.json({ id, name, image_url, texts: texts || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/designs/:id', adminMiddleware, async (req, res) => {
  try {
    const [designs] = await db.execute('SELECT * FROM designs WHERE id = ? AND created_by = ?', [req.params.id, req.user.id]);
    const design = designs[0];
    if (!design) return res.status(404).json({ error: 'Design not found' });

    const [shares] = await db.execute(`
      SELECT u.id, u.email, u.username FROM design_shares ds
      JOIN users u ON u.id = ds.shared_with WHERE ds.design_id = ?
    `, [design.id]);

    res.json({ ...design, texts: JSON.parse(design.texts || '[]'), shares });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/designs/:id', adminMiddleware, async (req, res) => {
  const { name, image_url, image_width, image_height, texts } = req.body;
  try {
    await db.execute(`
      UPDATE designs SET name = ?, image_url = ?, image_width = ?, image_height = ?, texts = ?
      WHERE id = ? AND created_by = ?
    `, [name, image_url, image_width || 800, image_height || 600, JSON.stringify(texts || []), req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/designs/:id', adminMiddleware, async (req, res) => {
  try {
    await db.execute('DELETE FROM design_shares WHERE design_id = ?', [req.params.id]);
    await db.execute('DELETE FROM client_designs WHERE design_id = ?', [req.params.id]);
    await db.execute('DELETE FROM designs WHERE id = ? AND created_by = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Share design
app.post('/api/admin/designs/:id/share', adminMiddleware, async (req, res) => {
  const { emailOrUsername } = req.body;
  try {
    const [users] = await db.execute('SELECT * FROM users WHERE email = ? OR username = ?', [emailOrUsername?.toLowerCase(), emailOrUsername]);
    const user = users[0];
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Tidak bisa share ke admin' });

    const [existing] = await db.execute('SELECT id FROM design_shares WHERE design_id = ? AND shared_with = ?', [req.params.id, user.id]);
    if (existing.length > 0) return res.status(400).json({ error: 'Design sudah di-share ke user ini' });

    await db.execute('INSERT INTO design_shares (id, design_id, shared_with) VALUES (?, ?, ?)', [uuidv4(), req.params.id, user.id]);

    // Create client design record
    const [cdExists] = await db.execute('SELECT id FROM client_designs WHERE design_id = ? AND user_id = ?', [req.params.id, user.id]);
    if (cdExists.length === 0) {
      await db.execute('INSERT INTO client_designs (id, design_id, user_id, form_values) VALUES (?, ?, ?, ?)', [uuidv4(), req.params.id, user.id, '{}']);
    }

    res.json({ success: true, user: { id: user.id, email: user.email, username: user.username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/designs/:id/share/:userId', adminMiddleware, async (req, res) => {
  try {
    await db.execute('DELETE FROM design_shares WHERE design_id = ? AND shared_with = ?', [req.params.id, req.params.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Upload Routes ────────────────────────────────────────────────────────────
app.post('/api/upload/image', adminMiddleware, uploadImage.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/images/${req.file.filename}` });
});

app.post('/api/upload/font', adminMiddleware, uploadFont.single('font'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const fontName = req.body.name || path.basename(req.file.originalname, path.extname(req.file.originalname));
  const id = uuidv4();
  try {
    await db.execute('INSERT INTO fonts (id, name, type, url, file_path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)', [
      id, fontName, 'upload', `/fonts/${req.file.filename}`, req.file.path, req.user.id
    ]);
    res.json({ id, name: fontName, url: `/fonts/${req.file.filename}`, type: 'upload' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add Google Font
app.post('/api/fonts/google', adminMiddleware, async (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });
  const id = uuidv4();
  try {
    await db.execute('INSERT INTO fonts (id, name, type, url, uploaded_by) VALUES (?, ?, ?, ?, ?)', [
      id, name, 'google', url, req.user.id
    ]);
    res.json({ id, name, url, type: 'google' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fonts', authMiddleware, async (req, res) => {
  try {
    const [fonts] = await db.execute('SELECT * FROM fonts ORDER BY created_at DESC');
    res.json(fonts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/fonts/:id', adminMiddleware, async (req, res) => {
  try {
    const [fonts] = await db.execute('SELECT * FROM fonts WHERE id = ?', [req.params.id]);
    const font = fonts[0];
    if (font && font.file_path) {
      try { fs.unlinkSync(font.file_path); } catch { }
    }
    await db.execute('DELETE FROM fonts WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Client Routes ────────────────────────────────────────────────────────────
app.get('/api/client/designs', authMiddleware, async (req, res) => {
  if (req.user.role === 'admin') return res.json([]);
  try {
    const [designs] = await db.execute(`
      SELECT d.*, cd.id as cd_id, cd.form_values
      FROM design_shares ds
      JOIN designs d ON d.id = ds.design_id
      JOIN client_designs cd ON cd.design_id = d.id AND cd.user_id = ds.shared_with
      WHERE ds.shared_with = ?
      ORDER BY ds.created_at DESC
    `, [req.user.id]);
    res.json(designs.map(d => ({
      ...d,
      texts: JSON.parse(d.texts || '[]'),
      form_values: JSON.parse(d.form_values || '{}')
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/client/designs/:id', authMiddleware, async (req, res) => {
  try {
    const [shares] = await db.execute('SELECT * FROM design_shares WHERE design_id = ? AND shared_with = ?', [req.params.id, req.user.id]);
    if (shares.length === 0 && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });

    const [designs] = await db.execute('SELECT * FROM designs WHERE id = ?', [req.params.id]);
    const design = designs[0];
    if (!design) return res.status(404).json({ error: 'Design not found' });

    const [clientDesigns] = await db.execute('SELECT * FROM client_designs WHERE design_id = ? AND user_id = ?', [req.params.id, req.user.id]);
    const clientDesign = clientDesigns[0];

    res.json({
      ...design,
      texts: JSON.parse(design.texts || '[]'),
      form_values: JSON.parse(clientDesign?.form_values || '{}')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/client/designs/:id/form', authMiddleware, async (req, res) => {
  const { form_values } = req.body;
  try {
    const [result] = await db.execute(`
      UPDATE client_designs SET form_values = ?
      WHERE design_id = ? AND user_id = ?
    `, [JSON.stringify(form_values), req.params.id, req.user.id]);

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Client design not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search users (admin only)
app.get('/api/admin/users/search', adminMiddleware, async (req, res) => {
  const { q } = req.query;
  try {
    const searchVal = `%${q}%`;
    const [users] = await db.execute(`
      SELECT id, email, username FROM users 
      WHERE role = 'client' AND (email LIKE ? OR username LIKE ?)
      LIMIT 10
    `, [searchVal, searchVal]);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SPA Fallback (Sintaks kompatibel Express 5) ─────────────────────────────
// ─── SPA Fallback (Kompatibel Penuh Express 5) ─────────────────────────────────
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log(`👤 Admin: admin@canva.com / admin123`);
});