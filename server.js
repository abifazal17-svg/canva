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

// â”€â”€â”€ Setup Directories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const FONTS_DIR = path.join(__dirname, 'public', 'fonts');
const IMAGES_DIR = path.join(__dirname, 'public', 'uploads', 'images');

[UPLOADS_DIR, FONTS_DIR, IMAGES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// â”€â”€â”€ Database Setup (MySQL / phpMyAdmin) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const db = mysql.createPool({
  host: process.env.DB_HOST || 'db.fr-roub1.bengt.wasmernet.com',
  port: Number(process.env.DB_PORT) || 3306, // Pastikan port sesuai dashboard Wasmer
  user: process.env.DB_USER || 'user_a7d99fd8',
  password: process.env.DB_PASSWORD || 'pw_5fZnvLKFBu19OGf6G6nhM6qzyDKk01T6',
  database: process.env.DB_NAME || 'db_39444a4c',
  ssl: { rejectUnauthorized: false }, // Menangani handshake SSL untuk cloud DB
  connectTimeout: 30000,              // Perpanjang timeout menjadi 30 detik
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Ensure all required tables exist (auto-setup when moving to a new server)
async function ensureTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      username VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(32) DEFAULT 'client',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS designs (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      image_url LONGTEXT,
      image_width INT DEFAULT 800,
      image_height INT DEFAULT 600,
      texts LONGTEXT,
      created_by VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS design_shares (
      id VARCHAR(64) PRIMARY KEY,
      design_id VARCHAR(64) NOT NULL,
      shared_with VARCHAR(64) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS client_designs (
      id VARCHAR(64) PRIMARY KEY,
      design_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      form_values LONGTEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS fonts (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(32) DEFAULT 'upload',
      url LONGTEXT,
      file_path TEXT,
      uploaded_by VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // Ensure image_url and texts columns are LONGTEXT so base64 data URLs fit
  try { await db.execute(`ALTER TABLE designs MODIFY COLUMN image_url LONGTEXT`); } catch (_) {}
  try { await db.execute(`ALTER TABLE designs MODIFY COLUMN texts LONGTEXT`); } catch (_) {}
}

// Seed Admin User & Check DB Connection
async function initDB() {
  try {
    await ensureTables();

    const [rows] = await db.execute('SELECT id FROM users WHERE role = ?', ['admin']);
    if (rows.length === 0) {
      const hashedPw = bcrypt.hashSync('admin123', 10);
      await db.execute(
        'INSERT INTO users (id, email, username, password, role) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), 'admin@canva.com', 'admin', hashedPw, 'admin']
      );
      console.log('âœ… Admin seeded: admin@canva.com / admin123');
    } else {
      console.log('âœ… Database connected & initialized successfully.');
    }
  } catch (err) {
    console.error('âŒ Error initializing DB:', err.message);
  }
}
initDB();

// â”€â”€â”€ Middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// CORS â€” allow requests from any origin (needed for canvas.toDataURL on other devices)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve static files with permissive CORS so canvas.crossOrigin works
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

// Multer — memory storage for images (base64 stored in DB, no disk dependency)
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// Multer for font uploads (fonts still go to disk — they are loaded via CSS @font-face URL)
const fontStorage = multer.diskStorage({
  destination: FONTS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, ext).replace(/\s+/g, '-');
    cb(null, `font-${baseName}-${Date.now()}${ext}`);
  }
});
const uploadFont = multer({ storage: fontStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// â”€â”€â”€ Auth Middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Auth Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Design Routes (Admin) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/admin/designs', adminMiddleware, async (req, res) => {
  try {
    const [designs] = await db.execute(`
      SELECT d.*, 
        (SELECT COUNT(*) FROM design_shares WHERE design_id = d.id) as share_count
      FROM designs d ORDER BY d.created_at DESC
    `);
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
    const [designs] = await db.execute('SELECT * FROM designs WHERE id = ?', [req.params.id]);
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
      WHERE id = ?
    `, [name, image_url, image_width || 800, image_height || 600, JSON.stringify(texts || []), req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/designs/:id', adminMiddleware, async (req, res) => {
  try {
    await db.execute('DELETE FROM design_shares WHERE design_id = ?', [req.params.id]);
    await db.execute('DELETE FROM client_designs WHERE design_id = ?', [req.params.id]);
    await db.execute('DELETE FROM designs WHERE id = ?', [req.params.id]);
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

// â”€â”€â”€ Upload Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/upload/image', adminMiddleware, uploadImage.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Convert to base64 data URL — stored directly in MySQL image_url field.
  // This makes images survive server restarts / ephemeral Wasmer filesystem resets.
  const mime    = req.file.mimetype || 'image/jpeg';
  const b64     = req.file.buffer.toString('base64');
  const dataUrl = `data:${mime};base64,${b64}`;
  res.json({ url: dataUrl });
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

// â”€â”€â”€ Client Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// ─── Database Backup / Export / Import Routes (Admin Only) ──────────────────
app.get('/api/admin/db/stats', adminMiddleware, async (req, res) => {
  try {
    await ensureTables();
    const [[uCount]]  = await db.execute('SELECT COUNT(*) as total FROM users');
    const [[dCount]]  = await db.execute('SELECT COUNT(*) as total FROM designs');
    const [[dsCount]] = await db.execute('SELECT COUNT(*) as total FROM design_shares');
    const [[cdCount]] = await db.execute('SELECT COUNT(*) as total FROM client_designs');
    const [[fCount]]  = await db.execute('SELECT COUNT(*) as total FROM fonts');

    res.json({
      host: process.env.DB_HOST || 'db.fr-roub1.bengt.wasmernet.com',
      database: process.env.DB_NAME || 'db_39444a4c',
      counts: {
        users: uCount.total || 0,
        designs: dCount.total || 0,
        design_shares: dsCount.total || 0,
        client_designs: cdCount.total || 0,
        fonts: fCount.total || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper to gather all DB data (including embedding disk images/fonts as base64 if present)
async function collectFullDatabaseSnapshot() {
  await ensureTables();
  const [users]          = await db.execute('SELECT * FROM users');
  const [designs]        = await db.execute('SELECT * FROM designs');
  const [design_shares]  = await db.execute('SELECT * FROM design_shares');
  const [client_designs] = await db.execute('SELECT * FROM client_designs');
  const [fonts]          = await db.execute('SELECT * FROM fonts');

  // Convert any legacy local disk image URLs (/uploads/images/...) to base64 if the file exists locally
  const enrichedDesigns = designs.map(d => {
    const copy = { ...d };
    if (copy.image_url && copy.image_url.startsWith('/uploads/')) {
      const localPath = path.join(__dirname, 'public', copy.image_url);
      if (fs.existsSync(localPath)) {
        try {
          const ext = path.extname(localPath).toLowerCase();
          const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
          const b64 = fs.readFileSync(localPath).toString('base64');
          copy.image_url = `data:${mime};base64,${b64}`;
        } catch (_) {}
      }
    }
    return copy;
  });

  // Embed uploaded font binary files as base64 so custom fonts also survive server migration
  const enrichedFonts = fonts.map(f => {
    const copy = { ...f };
    if (copy.type === 'upload' && copy.url && copy.url.startsWith('/fonts/')) {
      const filename = path.basename(copy.url);
      const localPath = path.join(FONTS_DIR, filename);
      if (fs.existsSync(localPath)) {
        try {
          copy.filename = filename;
          copy.file_base64 = fs.readFileSync(localPath).toString('base64');
        } catch (_) {}
      }
    }
    return copy;
  });

  return {
    app: 'DesignCraft',
    version: '1.0',
    exported_at: new Date().toISOString(),
    tables: {
      users,
      designs: enrichedDesigns,
      design_shares,
      client_designs,
      fonts: enrichedFonts
    }
  };
}

// Download JSON Backup (.json)
app.get('/api/admin/db/export-json', adminMiddleware, async (req, res) => {
  try {
    const snapshot = await collectFullDatabaseSnapshot();
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `designcraft-backup-${dateStr}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(snapshot, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper to format Date or primitive values for SQL dump
function sqlVal(val) {
  if (val === null || val === undefined) return 'NULL';
  if (val instanceof Date) {
    return mysql.escape(val.toISOString().slice(0, 19).replace('T', ' '));
  }
  return mysql.escape(val);
}

// Download SQL Dump (.sql) for phpMyAdmin / MySQL CLI
app.get('/api/admin/db/export-sql', adminMiddleware, async (req, res) => {
  try {
    const snapshot = await collectFullDatabaseSnapshot();
    const { users, designs, design_shares, client_designs, fonts } = snapshot.tables;
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `designcraft-database-${dateStr}.sql`;

    const lines = [];
    lines.push('-- ==========================================================');
    lines.push('-- DesignCraft Full Database Backup (MySQL / MariaDB / phpMyAdmin)');
    lines.push(`-- Exported at: ${snapshot.exported_at}`);
    lines.push('-- ==========================================================');
    lines.push('SET NAMES utf8mb4;');
    lines.push('SET FOREIGN_KEY_CHECKS = 0;');
    lines.push('');

    // 1. Table structures
    lines.push('-- ─── Struktur Tabel: users ──────────────────────────────────');
    lines.push(`CREATE TABLE IF NOT EXISTS \`users\` (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`email\` VARCHAR(255) UNIQUE NOT NULL,
  \`username\` VARCHAR(255) UNIQUE NOT NULL,
  \`password\` VARCHAR(255) NOT NULL,
  \`role\` VARCHAR(32) DEFAULT 'client',
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
    lines.push('');

    lines.push('-- ─── Struktur Tabel: designs ────────────────────────────────');
    lines.push(`CREATE TABLE IF NOT EXISTS \`designs\` (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`name\` VARCHAR(255) NOT NULL,
  \`image_url\` LONGTEXT,
  \`image_width\` INT DEFAULT 800,
  \`image_height\` INT DEFAULT 600,
  \`texts\` LONGTEXT,
  \`created_by\` VARCHAR(64),
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
    lines.push('');

    lines.push('-- ─── Struktur Tabel: design_shares ──────────────────────────');
    lines.push(`CREATE TABLE IF NOT EXISTS \`design_shares\` (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`design_id\` VARCHAR(64) NOT NULL,
  \`shared_with\` VARCHAR(64) NOT NULL,
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
    lines.push('');

    lines.push('-- ─── Struktur Tabel: client_designs ─────────────────────────');
    lines.push(`CREATE TABLE IF NOT EXISTS \`client_designs\` (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`design_id\` VARCHAR(64) NOT NULL,
  \`user_id\` VARCHAR(64) NOT NULL,
  \`form_values\` LONGTEXT,
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
    lines.push('');

    lines.push('-- ─── Struktur Tabel: fonts ──────────────────────────────────');
    lines.push(`CREATE TABLE IF NOT EXISTS \`fonts\` (
  \`id\` VARCHAR(64) PRIMARY KEY,
  \`name\` VARCHAR(255) NOT NULL,
  \`type\` VARCHAR(32) DEFAULT 'upload',
  \`url\` LONGTEXT,
  \`file_path\` TEXT,
  \`uploaded_by\` VARCHAR(64),
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
    lines.push('');

    // 2. Data inserts (with ON DUPLICATE KEY UPDATE so importing into non-empty DB won't error)
    if (users.length) {
      lines.push('-- ─── Data Tabel: users ──────────────────────────────────────');
      for (const u of users) {
        lines.push(`INSERT INTO \`users\` (\`id\`, \`email\`, \`username\`, \`password\`, \`role\`, \`created_at\`) VALUES (${sqlVal(u.id)}, ${sqlVal(u.email)}, ${sqlVal(u.username)}, ${sqlVal(u.password)}, ${sqlVal(u.role || 'client')}, ${sqlVal(u.created_at || new Date())}) ON DUPLICATE KEY UPDATE \`email\`=VALUES(\`email\`), \`username\`=VALUES(\`username\`), \`password\`=VALUES(\`password\`), \`role\`=VALUES(\`role\`);`);
      }
      lines.push('');
    }

    if (designs.length) {
      lines.push('-- ─── Data Tabel: designs ────────────────────────────────────');
      for (const d of designs) {
        const textsStr = typeof d.texts === 'string' ? d.texts : JSON.stringify(d.texts || []);
        lines.push(`INSERT INTO \`designs\` (\`id\`, \`name\`, \`image_url\`, \`image_width\`, \`image_height\`, \`texts\`, \`created_by\`, \`created_at\`) VALUES (${sqlVal(d.id)}, ${sqlVal(d.name)}, ${sqlVal(d.image_url)}, ${sqlVal(d.image_width || 800)}, ${sqlVal(d.image_height || 600)}, ${sqlVal(textsStr)}, ${sqlVal(d.created_by)}, ${sqlVal(d.created_at || new Date())}) ON DUPLICATE KEY UPDATE \`name\`=VALUES(\`name\`), \`image_url\`=VALUES(\`image_url\`), \`image_width\`=VALUES(\`image_width\`), \`image_height\`=VALUES(\`image_height\`), \`texts\`=VALUES(\`texts\`), \`created_by\`=VALUES(\`created_by\`);`);
      }
      lines.push('');
    }

    if (design_shares.length) {
      lines.push('-- ─── Data Tabel: design_shares ──────────────────────────────');
      for (const ds of design_shares) {
        lines.push(`INSERT INTO \`design_shares\` (\`id\`, \`design_id\`, \`shared_with\`, \`created_at\`) VALUES (${sqlVal(ds.id)}, ${sqlVal(ds.design_id)}, ${sqlVal(ds.shared_with)}, ${sqlVal(ds.created_at || new Date())}) ON DUPLICATE KEY UPDATE \`design_id\`=VALUES(\`design_id\`), \`shared_with\`=VALUES(\`shared_with\`);`);
      }
      lines.push('');
    }

    if (client_designs.length) {
      lines.push('-- ─── Data Tabel: client_designs ─────────────────────────────');
      for (const cd of client_designs) {
        const fvStr = typeof cd.form_values === 'string' ? cd.form_values : JSON.stringify(cd.form_values || {});
        lines.push(`INSERT INTO \`client_designs\` (\`id\`, \`design_id\`, \`user_id\`, \`form_values\`, \`created_at\`) VALUES (${sqlVal(cd.id)}, ${sqlVal(cd.design_id)}, ${sqlVal(cd.user_id)}, ${sqlVal(fvStr)}, ${sqlVal(cd.created_at || new Date())}) ON DUPLICATE KEY UPDATE \`design_id\`=VALUES(\`design_id\`), \`user_id\`=VALUES(\`user_id\`), \`form_values\`=VALUES(\`form_values\`);`);
      }
      lines.push('');
    }

    if (fonts.length) {
      lines.push('-- ─── Data Tabel: fonts ──────────────────────────────────────');
      for (const f of fonts) {
        lines.push(`INSERT INTO \`fonts\` (\`id\`, \`name\`, \`type\`, \`url\`, \`file_path\`, \`uploaded_by\`, \`created_at\`) VALUES (${sqlVal(f.id)}, ${sqlVal(f.name)}, ${sqlVal(f.type || 'upload')}, ${sqlVal(f.url)}, ${sqlVal(f.file_path || null)}, ${sqlVal(f.uploaded_by || null)}, ${sqlVal(f.created_at || new Date())}) ON DUPLICATE KEY UPDATE \`name\`=VALUES(\`name\`), \`type\`=VALUES(\`type\`), \`url\`=VALUES(\`url\`), \`file_path\`=VALUES(\`file_path\`);`);
      }
      lines.push('');
    }

    lines.push('SET FOREIGN_KEY_CHECKS = 1;');

    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import / Restore Database Backup (.json or .sql)
app.post('/api/admin/db/import', adminMiddleware, async (req, res) => {
  const { mode = 'merge', backup, sql } = req.body;
  try {
    await ensureTables();

    // Case A: Raw SQL file import
    if (typeof sql === 'string' && sql.trim().length > 0) {
      if (mode === 'replace') {
        await db.execute('DELETE FROM design_shares');
        await db.execute('DELETE FROM client_designs');
        await db.execute('DELETE FROM designs');
        await db.execute('DELETE FROM fonts');
      }
      // Split SQL statements by semicolon at end of line
      const statements = sql
        .split(/;\s*(?:\r?\n|$)/)
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--') && !s.startsWith('/*'));

      let executed = 0;
      for (const stmt of statements) {
        // Strip leading comment lines inside a block
        const cleanStmt = stmt
          .split(/\r?\n/)
          .filter(line => !line.trim().startsWith('--'))
          .join('\n')
          .trim();
        if (!cleanStmt) continue;
        await db.query(cleanStmt);
        executed++;
      }
      return res.json({
        success: true,
        message: `Berhasil mengeksekusi ${executed} perintah SQL ke database.`
      });
    }

    // Case B: JSON Backup import
    const tables = backup?.tables || backup;
    if (!tables || typeof tables !== 'object') {
      return res.status(400).json({ error: 'Format file backup tidak valid' });
    }

    const users          = Array.isArray(tables.users)          ? tables.users          : [];
    const designs        = Array.isArray(tables.designs)        ? tables.designs        : [];
    const design_shares  = Array.isArray(tables.design_shares)  ? tables.design_shares  : [];
    const client_designs = Array.isArray(tables.client_designs) ? tables.client_designs : [];
    const fonts          = Array.isArray(tables.fonts)          ? tables.fonts          : [];

    if (mode === 'replace') {
      await db.execute('DELETE FROM design_shares');
      await db.execute('DELETE FROM client_designs');
      await db.execute('DELETE FROM designs');
      await db.execute('DELETE FROM fonts');
      if (users.length > 0) {
        await db.execute('DELETE FROM users');
      }
    }

    // 1. Restore users (handle email/username uniqueness gracefully so IDs match the backup)
    let restoredUsers = 0;
    for (const u of users) {
      if (!u.id || !u.email || !u.username) continue;
      // If another row has the same email or username with a different ID, update its ID to match backup
      await db.execute(
        'DELETE FROM users WHERE (email = ? OR username = ?) AND id != ?',
        [u.email, u.username, u.id]
      );
      await db.execute(
        `INSERT INTO users (id, email, username, password, role)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE email = VALUES(email), username = VALUES(username), password = VALUES(password), role = VALUES(role)`,
        [u.id, u.email, u.username, u.password, u.role || 'client']
      );
      restoredUsers++;
    }

    // Ensure at least one admin account always exists even if backup had no users
    const [admins] = await db.execute('SELECT * FROM users WHERE role = ?', ['admin']);
    let activeAdmin = admins[0];
    if (!activeAdmin) {
      const hashedPw = bcrypt.hashSync('admin123', 10);
      const adminId = req.user.id || uuidv4();
      await db.execute(
        'INSERT INTO users (id, email, username, password, role) VALUES (?, ?, ?, ?, ?)',
        [adminId, 'admin@canva.com', 'admin', hashedPw, 'admin']
      );
      activeAdmin = { id: adminId, email: 'admin@canva.com', username: 'admin', role: 'admin' };
    }

    // 2. Restore designs
    let restoredDesigns = 0;
    for (const d of designs) {
      if (!d.id || !d.name) continue;
      const textsStr = typeof d.texts === 'string' ? d.texts : JSON.stringify(d.texts || []);
      await db.execute(
        `INSERT INTO designs (id, name, image_url, image_width, image_height, texts, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           image_url = VALUES(image_url),
           image_width = VALUES(image_width),
           image_height = VALUES(image_height),
           texts = VALUES(texts),
           created_by = VALUES(created_by)`,
        [d.id, d.name, d.image_url || null, d.image_width || 800, d.image_height || 600, textsStr, d.created_by || activeAdmin.id]
      );
      restoredDesigns++;
    }

    // 3. Restore design_shares
    let restoredShares = 0;
    for (const ds of design_shares) {
      if (!ds.id || !ds.design_id || !ds.shared_with) continue;
      await db.execute(
        `INSERT INTO design_shares (id, design_id, shared_with)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE design_id = VALUES(design_id), shared_with = VALUES(shared_with)`,
        [ds.id, ds.design_id, ds.shared_with]
      );
      restoredShares++;
    }

    // 4. Restore client_designs
    let restoredClientDesigns = 0;
    for (const cd of client_designs) {
      if (!cd.id || !cd.design_id || !cd.user_id) continue;
      const fvStr = typeof cd.form_values === 'string' ? cd.form_values : JSON.stringify(cd.form_values || {});
      await db.execute(
        `INSERT INTO client_designs (id, design_id, user_id, form_values)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE design_id = VALUES(design_id), user_id = VALUES(user_id), form_values = VALUES(form_values)`,
        [cd.id, cd.design_id, cd.user_id, fvStr]
      );
      restoredClientDesigns++;
    }

    // 5. Restore fonts (and recreate uploaded font files on disk if file_base64 is included)
    let restoredFonts = 0;
    for (const f of fonts) {
      if (!f.id || !f.name) continue;
      let localFilePath = f.file_path || null;
      if (f.type === 'upload' && f.file_base64) {
        const fname = f.filename || (f.url ? path.basename(f.url) : `font-${f.id}.ttf`);
        localFilePath = path.join(FONTS_DIR, fname);
        try {
          fs.writeFileSync(localFilePath, Buffer.from(f.file_base64, 'base64'));
        } catch (_) {}
      }
      await db.execute(
        `INSERT INTO fonts (id, name, type, url, file_path, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), type = VALUES(type), url = VALUES(url), file_path = VALUES(file_path)`,
        [f.id, f.name, f.type || 'upload', f.url || '', localFilePath, f.uploaded_by || activeAdmin.id]
      );
      restoredFonts++;
    }

    // Issue refreshed JWT token in case the admin user's ID was synced with the backup
    const newToken = jwt.sign(
      { id: activeAdmin.id, email: activeAdmin.email, username: activeAdmin.username, role: 'admin' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token: newToken,
      user: { id: activeAdmin.id, email: activeAdmin.email, username: activeAdmin.username, role: 'admin' },
      restored: {
        users: restoredUsers,
        designs: restoredDesigns,
        design_shares: restoredShares,
        client_designs: restoredClientDesigns,
        fonts: restoredFonts
      },
      message: `Database berhasil dipulihkan (${restoredDesigns} design, ${restoredUsers} user, ${restoredShares} share, ${restoredFonts} font).`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// â”€â”€â”€ SPA Fallback (Sintaks kompatibel Express 5) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€â”€ SPA Fallback (Kompatibel Penuh Express 5) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const localIp = Object.values(nets).flat().find(n => n.family === 'IPv4' && !n.internal)?.address || 'localhost';
  console.log('\
\ud83d\ude80 Server running at:');
  console.log('   Local:   http://localhost:' + PORT);
  console.log('   Network: http://' + localIp + ':' + PORT);
  console.log('\ud83d\udc64 Admin: admin@canva.com / admin123');
});
