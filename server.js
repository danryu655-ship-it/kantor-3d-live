// ============================================================================
// Kantor 3D Live — server
// Node.js + Express + ws. Satu proses, tanpa database eksternal.
// State (undangan, anggota, peran, papan tugas, chat) disimpan di
// data/state.json (file lokal di server).
//
// PENTING — keterbatasan Render free tier (bukan bug):
// Render free tidak punya persistent disk. Saat service restart / tidur
// (sleep setelah 15 menit tanpa trafik) lalu bangun, isi data/state.json
// bisa hilang dan ruangan kembali kosong (owner harus claim ulang).
// Untuk pemakaian serius, pindahkan state ke database eksternal
// (mis. Supabase / Postgres gratis) atau naik ke plan berbayar.
// ============================================================================
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // undangan berlaku 24 jam saja

// ---------------------------------------------------------------------------
// Denah kantor (satuan meter, dipakai server DAN client — harus sama)
// Lantai: x -12..12, z -8..8. Ruang Kerja: x 4..12, z -8..-1.
// Dinding barat Ruang Kerja di x=4 (z -8..-1) dengan celah pintu z -5..-3.
// Dinding selatan Ruang Kerja di z=-1 (x 4..12).
// ---------------------------------------------------------------------------
const BOUNDS = { xMin: -11.4, xMax: 11.4, zMin: -7.4, zMax: 7.4 };
const WORK_ROOM = { xMin: 4, zMax: -1 }; // x > 4 dan z < -1 = dalam Ruang Kerja

function clampPosition(x, z, role, prev) {
  x = Math.max(BOUNDS.xMin, Math.min(BOUNDS.xMax, x));
  z = Math.max(BOUNDS.zMin, Math.min(BOUNDS.zMax, z));
  const px = prev ? prev.x : x;
  const pz = prev ? prev.z : z;

  // Dinding vertikal x=4 (z -8..-1), kecuali celah pintu z -5..-3.
  const inWallZ = z < -1 && z > -8;
  const inGap = z >= -5 && z <= -3;
  if (inWallZ && !inGap) {
    if (px < 4 && x >= 4) x = 3.8;
    else if (px > 4 && x <= 4) x = 4.2;
    else if (x > 3.8 && x < 4.2) x = px < 4 ? 3.8 : 4.2;
  }
  // Dinding horizontal z=-1 (x 4..12).
  if (x > 4 && pz < -1 && z >= -1) z = -1.2;
  else if (x > 4 && pz > -1 && z <= -1) z = -0.8;
  else if (x > 4 && z > -1.2 && z < -0.8) z = pz < -1 ? -1.2 : -0.8;

  // Tamu tidak boleh masuk Ruang Kerja sama sekali.
  if (role === 'tamu' && x > WORK_ROOM.xMin && z < WORK_ROOM.zMax) {
    x = 3.8;
  }
  return { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
function emptyState() {
  return { owner: null, members: [], invites: [], requests: [], board: [], chat: [] };
}
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s || !Array.isArray(s.members)) return emptyState();
    return s;
  } catch (_) {
    return emptyState();
  }
}
let state = loadState();
function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[state] gagal menyimpan:', e.message);
  }
}

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomUUID();
const now = () => Date.now();
const clean = (s, max) => String(s == null ? '' : s).trim().slice(0, max);
const inviteCode = () => crypto.randomBytes(5).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'INV' + Math.floor(Math.random() * 1e6);

// Posisi avatar: hanya di memori (bukan state file). Key: memberId.
const positions = new Map(); // memberId -> { x, z }
const sockets = new Map();   // memberId -> Set<ws>

function publicMember(m) {
  return { id: m.id, name: m.name, kind: m.kind, agentId: m.agentId || '', role: m.role, createdAt: m.createdAt };
}
function findMemberByToken(token) {
  if (!token) return null;
  const h = hashToken(token);
  return state.members.find((m) => m.tokenHash === h) || null;
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

function authMember(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  const m = findMemberByToken(token);
  if (!m) return res.status(401).json({ error: 'Token tidak valid. Masuk dulu lewat link undangan.' });
  req.member = m;
  next();
}
function requireOwner(req, res, next) {
  if (req.member.role !== 'owner') {
    return res.status(403).json({ error: 'Hanya room owner yang boleh melakukan ini.' });
  }
  next();
}

app.get('/api/status', (_req, res) => {
  res.json({
    claimed: !!state.owner,
    ownerName: state.owner ? (state.members.find((m) => m.id === state.owner.memberId) || {}).name || null : null,
    onlineCount: sockets.size,
    memberCount: state.members.length,
    pendingRequests: state.requests.filter((r) => r.status === 'pending').length,
  });
});

app.get('/api/me', authMember, (req, res) => {
  res.json({ member: publicMember(req.member) });
});

// Claim sebagai Room Owner — hanya bisa dilakukan SEKALI (first-come).
// Yang mengklaim pertama menjadi owner; token-nya disimpan di browser
// (localStorage). Kalau token hilang, kepemilikan tidak bisa dipulihkan
// dari browser lain — hapus data/state.json di server untuk reset.
app.post('/api/claim-owner', (req, res) => {
  if (state.owner) return res.status(409).json({ error: 'Ruangan ini sudah ada owner-nya.' });
  const name = clean(req.body && req.body.name, 40);
  if (!name) return res.status(400).json({ error: 'Nama wajib diisi.' });
  const token = newToken();
  const member = {
    id: newId(), name, kind: 'manusia', agentId: '',
    role: 'owner', tokenHash: hashToken(token), createdAt: now(),
  };
  state.owner = { memberId: member.id };
  state.members.push(member);
  saveState();
  res.json({ token, member: publicMember(member) });
});

// --- Undangan (owner saja) ---
app.post('/api/invites', authMember, requireOwner, (req, res) => {
  const code = inviteCode();
  const inv = { code, createdAt: now(), expiresAt: now() + INVITE_TTL_MS, createdBy: req.member.id, uses: 0 };
  state.invites.push(inv);
  saveState();
  res.json({ invite: inv, linkPath: '/?invite=' + code });
});
app.get('/api/invites', authMember, requireOwner, (_req, res) => {
  res.json({ invites: state.invites });
});
app.delete('/api/invites/:code', authMember, requireOwner, (req, res) => {
  const before = state.invites.length;
  state.invites = state.invites.filter((i) => i.code !== req.params.code);
  if (state.invites.length === before) return res.status(404).json({ error: 'Undangan tidak ditemukan.' });
  saveState();
  res.json({ ok: true });
});

// --- Permintaan masuk ---
app.post('/api/join-request', (req, res) => {
  const code = clean(req.body && req.body.inviteCode, 16);
  const name = clean(req.body && req.body.name, 40);
  const kind = req.body && req.body.kind === 'agent' ? 'agent' : 'manusia';
  const agentId = clean(req.body && req.body.agentId, 80);
  const inv = state.invites.find((i) => i.code === code);
  if (!inv) return res.status(404).json({ error: 'Kode undangan tidak ditemukan.' });
  if (inv.expiresAt < now()) return res.status(410).json({ error: 'Undangan ini sudah kedaluwarsa (berlaku 24 jam).' });
  if (!name) return res.status(400).json({ error: 'Nama wajib diisi.' });
  if (kind === 'agent' && !agentId) return res.status(400).json({ error: 'Agent wajib mengisi Agent ID.' });
  const token = newToken();
  const r = {
    id: newId(), inviteCode: code, name, kind, agentId,
    status: 'pending', role: null, tokenHash: hashToken(token), createdAt: now(),
  };
  state.requests.push(r);
  inv.uses += 1;
  saveState();
  broadcast({ type: 'request', request: { id: r.id, name, kind, agentId, status: 'pending', createdAt: r.createdAt } });
  res.json({ requestId: r.id, requestToken: token, status: 'pending' });
});
app.get('/api/join-request/:id', (req, res) => {
  const r = state.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Permintaan tidak ditemukan.' });
  if (hashToken(req.query.token || '') !== r.tokenHash) return res.status(401).json({ error: 'Token tidak valid.' });
  const out = { id: r.id, status: r.status, role: r.role };
  if (r.status === 'approved' && r.memberToken) out.memberToken = r.memberToken;
  res.json(out);
});
app.get('/api/requests', authMember, requireOwner, (_req, res) => {
  res.json({ requests: state.requests.filter((r) => r.status === 'pending') });
});
app.post('/api/requests/:id/approve', authMember, requireOwner, (req, res) => {
  const role = req.body && req.body.role === 'pegawai' ? 'pegawai' : 'tamu';
  const r = state.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Permintaan tidak ditemukan.' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'Permintaan ini sudah diproses.' });
  const token = newToken();
  const member = {
    id: newId(), name: r.name, kind: r.kind, agentId: r.agentId,
    role, tokenHash: hashToken(token), createdAt: now(),
  };
  state.members.push(member);
  r.status = 'approved';
  r.role = role;
  r.memberToken = token; // hanya dibaca SEKALI oleh pemohon lewat endpoint status
  saveState();
  broadcast({ type: 'request-decided', requestId: r.id, status: 'approved', role });
  res.json({ ok: true, member: publicMember(member) });
});
app.post('/api/requests/:id/reject', authMember, requireOwner, (req, res) => {
  const r = state.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Permintaan tidak ditemukan.' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'Permintaan ini sudah diproses.' });
  r.status = 'rejected';
  saveState();
  broadcast({ type: 'request-decided', requestId: r.id, status: 'rejected' });
  res.json({ ok: true });
});

// --- Anggota (owner saja) ---
app.get('/api/members', authMember, requireOwner, (_req, res) => {
  res.json({ members: state.members.map(publicMember) });
});
app.post('/api/members/:id/role', authMember, requireOwner, (req, res) => {
  const role = req.body && req.body.role;
  if (role !== 'tamu' && role !== 'pegawai') return res.status(400).json({ error: 'Peran harus tamu atau pegawai.' });
  const m = state.members.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Anggota tidak ditemukan.' });
  if (m.role === 'owner') return res.status(403).json({ error: 'Peran owner tidak bisa diubah.' });
  m.role = role;
  saveState();
  broadcast({ type: 'member-updated', member: publicMember(m) });
  res.json({ ok: true, member: publicMember(m) });
});
app.post('/api/members/:id/revoke', authMember, requireOwner, (req, res) => {
  const m = state.members.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Anggota tidak ditemukan.' });
  if (m.role === 'owner') return res.status(403).json({ error: 'Owner tidak bisa dikeluarkan.' });
  state.members = state.members.filter((x) => x.id !== m.id);
  saveState();
  closeSocketsFor(m.id, 'revoked');
  broadcast({ type: 'member-removed', memberId: m.id });
  res.json({ ok: true });
});

// --- Papan tugas ---
// Tamu: hanya boleh menambah. Pegawai/Owner: tambah, ambil, edit, hapus.
app.get('/api/board', authMember, (_req, res) => res.json({ board: state.board }));
app.post('/api/board', authMember, (req, res) => {
  const title = clean(req.body && req.body.title, 80);
  const text = clean(req.body && req.body.text, 500);
  if (!title) return res.status(400).json({ error: 'Judul tugas wajib diisi.' });
  const item = {
    id: newId(), title, text, author: req.member.name, authorId: req.member.id,
    status: 'baru', assignee: '', createdAt: now(),
  };
  state.board.push(item);
  if (state.board.length > 200) state.board = state.board.slice(-200);
  saveState();
  broadcast({ type: 'board', board: state.board });
  res.json({ item });
});
app.patch('/api/board/:id', authMember, (req, res) => {
  if (req.member.role === 'tamu') return res.status(403).json({ error: 'Tamu tidak boleh mengubah tugas.' });
  const item = state.board.find((x) => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
  if (req.body.title !== undefined) item.title = clean(req.body.title, 80) || item.title;
  if (req.body.text !== undefined) item.text = clean(req.body.text, 500);
  if (req.body.status === 'baru' || req.body.status === 'diambil' || req.body.status === 'selesai') {
    item.status = req.body.status;
    item.assignee = req.body.status === 'diambil' ? req.member.name : item.assignee;
    if (req.body.status === 'baru') item.assignee = '';
  }
  saveState();
  broadcast({ type: 'board', board: state.board });
  res.json({ item });
});
app.delete('/api/board/:id', authMember, (req, res) => {
  if (req.member.role === 'tamu') return res.status(403).json({ error: 'Tamu tidak boleh menghapus tugas.' });
  const before = state.board.length;
  state.board = state.board.filter((x) => x.id !== req.params.id);
  if (state.board.length === before) return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
  saveState();
  broadcast({ type: 'board', board: state.board });
  res.json({ ok: true });
});

// --- Chat ---
app.get('/api/chat', authMember, (_req, res) => res.json({ chat: state.chat }));
app.post('/api/chat', authMember, (req, res) => {
  const text = clean(req.body && req.body.text, 500);
  if (!text) return res.status(400).json({ error: 'Pesan kosong.' });
  const msg = { id: newId(), author: req.member.name, role: req.member.role, text, at: now() };
  state.chat.push(msg);
  if (state.chat.length > 100) state.chat = state.chat.slice(-100);
  saveState();
  broadcast({ type: 'chat', message: msg });
  res.json({ message: msg });
});

// ---------------------------------------------------------------------------
// WebSocket — presence LANGSUNG. Yang terlihat online hanyalah koneksi
// WebSocket yang benar-benar sedang terhubung saat itu. Tidak ada bot
// atau anggota palsu.
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

function onlineList() {
  const list = [];
  for (const [memberId, set] of sockets.entries()) {
    if (!set || set.size === 0) continue;
    const m = state.members.find((x) => x.id === memberId);
    if (!m) continue;
    const pos = positions.get(memberId) || { x: -8, z: 4 };
    list.push({ ...publicMember(m), x: pos.x, z: pos.z });
  }
  return list;
}
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const set of sockets.values()) {
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }
}
function broadcastPresence() {
  broadcast({ type: 'presence', online: onlineList() });
}
function closeSocketsFor(memberId, reason) {
  const set = sockets.get(memberId);
  if (!set) return;
  for (const ws of set) {
    try { ws.send(JSON.stringify({ type: 'kicked', reason })); ws.close(); } catch (_) {}
  }
  sockets.delete(memberId);
  positions.delete(memberId);
}

wss.on('connection', (ws, req) => {
  let token = '';
  try {
    const u = new URL(req.url, 'http://localhost');
    token = u.searchParams.get('token') || '';
  } catch (_) {}
  const member = findMemberByToken(token);
  if (!member) { try { ws.close(4401, 'token tidak valid'); } catch (_) {} return; }

  if (!sockets.has(member.id)) sockets.set(member.id, new Set());
  sockets.get(member.id).add(ws);
  if (!positions.has(member.id)) {
    positions.set(member.id, { x: -8 + Math.random() * 4, z: 3 + Math.random() * 3 });
  }
  const pos = positions.get(member.id);

  ws.send(JSON.stringify({
    type: 'hello',
    you: { ...publicMember(member), x: pos.x, z: pos.z },
    online: onlineList(),
    board: state.board,
    chat: state.chat,
  }));
  broadcastPresence();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (_) { return; }
    if (msg.type === 'move') {
      const p = clampPosition(Number(msg.x) || pos.x, Number(msg.z) || pos.z, member.role, positions.get(member.id));
      positions.set(member.id, p);
      broadcast({ type: 'pos', id: member.id, x: p.x, z: p.z });
    } else if (msg.type === 'chat') {
      const text = clean(msg.text, 500);
      if (!text) return;
      const m = { id: newId(), author: member.name, role: member.role, text, at: now() };
      state.chat.push(m);
      if (state.chat.length > 100) state.chat = state.chat.slice(-100);
      saveState();
      broadcast({ type: 'chat', message: m });
    }
  });

  ws.on('close', () => {
    const set = sockets.get(member.id);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        sockets.delete(member.id);
        positions.delete(member.id);
      }
    }
    broadcastPresence();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Kantor 3D Live jalan di port ${PORT} (owner: ${state.owner ? 'sudah diklaim' : 'belum diklaim'})`);
});
