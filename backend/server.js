const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── MIDDLEWARE ───
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// ─── DATABASE SETUP ───
const db = new Database(path.join(__dirname, 'hotel.db'));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    email TEXT,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_ref TEXT UNIQUE NOT NULL,
    user_id INTEGER,
    guest_name TEXT NOT NULL,
    guest_phone TEXT NOT NULL,
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    guests INTEGER DEFAULT 1,
    nights INTEGER NOT NULL,
    notes TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

console.log('✅ Database ready: hotel.db');

// ─── HELPERS ───
function generateRef() {
  return 'HM-' + Date.now().toString(36).toUpperCase();
}

// ─── ROUTES ───

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'La Tua Futura Camera API is running 🏨' });
});

// ── AUTH: Register ──
app.post('/api/auth/register', (req, res) => {
  const { name, phone, email, password } = req.body;

  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'Nome, telefono e password sono obbligatori.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La password deve avere almeno 6 caratteri.' });
  }

  try {
    const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
    if (existing) {
      return res.status(409).json({ error: 'Numero già registrato. Accedi con le tue credenziali.' });
    }

    const stmt = db.prepare(
      'INSERT INTO users (name, phone, email, password) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(name, phone, email || null, password);

    const user = db.prepare('SELECT id, name, phone, email, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Errore del server. Riprova più tardi.' });
  }
});

// ── AUTH: Login ──
app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: 'Inserisci telefono e password.' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Credenziali non corrette.' });
    }

    const { password: _pw, ...safeUser } = user;
    res.json({ success: true, user: safeUser });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Errore del server.' });
  }
});

// ── BOOKINGS: Create ──
app.post('/api/bookings', (req, res) => {
  const { guest_name, guest_phone, check_in, check_out, guests, notes, user_id } = req.body;

  if (!guest_name || !guest_phone || !check_in || !check_out) {
    return res.status(400).json({ error: 'Compila tutti i campi obbligatori.' });
  }

  const inDate = new Date(check_in);
  const outDate = new Date(check_out);
  if (outDate <= inDate) {
    return res.status(400).json({ error: "La data di partenza deve essere successiva all'arrivo." });
  }

  const nights = Math.ceil((outDate - inDate) / 86400000);
  const booking_ref = generateRef();

  try {
    const stmt = db.prepare(`
      INSERT INTO bookings (booking_ref, user_id, guest_name, guest_phone, check_in, check_out, guests, nights, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      booking_ref,
      user_id || null,
      guest_name,
      guest_phone,
      check_in,
      check_out,
      guests || 1,
      nights,
      notes || null
    );

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, booking });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ error: 'Errore durante il salvataggio della prenotazione.' });
  }
});

// ── BOOKINGS: Get all (Admin) ──
app.get('/api/bookings', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== (process.env.ADMIN_KEY || 'admin123')) {
    return res.status(403).json({ error: 'Accesso non autorizzato.' });
  }

  try {
    const bookings = db.prepare(`
      SELECT b.*, u.email as user_email 
      FROM bookings b 
      LEFT JOIN users u ON b.user_id = u.id 
      ORDER BY b.created_at DESC
    `).all();
    res.json({ success: true, bookings });
  } catch (err) {
    res.status(500).json({ error: 'Errore del server.' });
  }
});

// ── BOOKINGS: Get by user ──
app.get('/api/bookings/user/:userId', (req, res) => {
  try {
    const bookings = db.prepare(
      'SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.params.userId);
    res.json({ success: true, bookings });
  } catch (err) {
    res.status(500).json({ error: 'Errore del server.' });
  }
});

// ── BOOKINGS: Update status (Admin) ──
app.patch('/api/bookings/:id/status', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== (process.env.ADMIN_KEY || 'admin123')) {
    return res.status(403).json({ error: 'Accesso non autorizzato.' });
  }

  const { status } = req.body;
  const validStatuses = ['pending', 'confirmed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Stato non valido.' });
  }

  try {
    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, req.params.id);
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    res.json({ success: true, booking });
  } catch (err) {
    res.status(500).json({ error: 'Errore del server.' });
  }
});

// ── USERS: Get all (Admin) ──
app.get('/api/users', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== (process.env.ADMIN_KEY || 'admin123')) {
    return res.status(403).json({ error: 'Accesso non autorizzato.' });
  }

  try {
    const users = db.prepare(
      'SELECT id, name, phone, email, created_at FROM users ORDER BY created_at DESC'
    ).all();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ error: 'Errore del server.' });
  }
});

// ─── START ───
app.listen(PORT, () => {
  console.log(`🏨 Hotel API running on http://localhost:${PORT}`);
});