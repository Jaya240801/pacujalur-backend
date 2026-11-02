/**
 * MIDTRANS SNAP BACKEND SERVER - PACU JALUR TEPIAN NAROSA 2027
 * Dibuat dengan Zero-Dependency (Native Node.js HTTP & Crypto).
 * Langsung jalan dengan: node server.js
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

// --- 1. MEMUAT KONFIGURASI DARI .env ATAU DEFAULT ---
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  const env = {
    PORT: 3000,
    MIDTRANS_SERVER_KEY: '',
    MIDTRANS_CLIENT_KEY: '',
    MIDTRANS_IS_PRODUCTION: 'false'
  };

  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    lines.forEach(line => {
      const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        let val = (match[2] || '').trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        env[match[1]] = val;
      }
    });
  }
  return env;
}

const config = loadEnv();
const PORT = process.env.PORT || config.PORT || 3000;
const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || config.MIDTRANS_SERVER_KEY || '';
const CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY || config.MIDTRANS_CLIENT_KEY || '';
const IS_PROD = (process.env.MIDTRANS_IS_PRODUCTION || config.MIDTRANS_IS_PRODUCTION) === 'true';

// URL Midtrans API
const SNAP_URL = IS_PROD 
  ? 'https://app.midtrans.com/snap/v1/transactions' 
  : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

const STATUS_BASE_URL = IS_PROD
  ? 'https://api.midtrans.com/v2'
  : 'https://api.sandbox.midtrans.com/v2';

// In-Memory Order Storage (dapat disimpan ke file json lokal)
const ORDERS_FILE = path.join(__dirname, 'orders.json');
let orders = {};
try {
  if (fs.existsSync(ORDERS_FILE)) {
    orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  }
} catch (e) {
  orders = {};
}

function persistOrders() {
  try {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Warning] Gagal menyimpan file orders.json:', err.message);
  }
}

// --- SESSIONS & USERS STORAGE (SERVER-SIDE AUTH & ROLES) ---
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const USERS_FILE = path.join(__dirname, 'users.json');

// Default Akun Resmi Panitia & Petugas Pacu Jalur 2027
const DEFAULT_USERS = {
  admin: {
    uid: 'usr_admin_01',
    username: 'adminpacu1',
    name: 'Administrator Utama',
    email: 'adminpacu1@pacujalur.com',
    role: 'admin',
    passwords: ['qwertyadmin12345', 'Panitia2027!', 'admin123'],
    permissions: ['manage_tournament', 'manage_matches', 'manage_agents', 'reset_data', 'view_all', 'manage_midtrans'],
    hasPaid: true,
    paidDays: ['2027-08-21']
  },
  juri: {
    uid: 'usr_juri_01',
    username: 'juripacu1',
    name: 'Juri Resmi Tepian Narosa',
    email: 'juripacu1@pacujalur.com',
    role: 'juri',
    passwords: ['qwertyjuri12345', 'juri123', 'Narosa2027!'],
    permissions: ['lock_winner', 'view_matches', 'live_scoring'],
    hasPaid: true,
    paidDays: ['2027-08-21']
  },
  agen: {
    uid: 'usr_agen_01',
    username: 'agentenda1',
    name: 'Agen Tenda 1 Narosa',
    email: 'agentenda1@pacujalur.com',
    role: 'agen',
    passwords: ['qwertyagen12345', '1234', 'agen123'],
    permissions: ['issue_tickets', 'view_agent_dashboard', 'view_sales'],
    hasPaid: true,
    paidDays: ['2027-08-21']
  }
};

let users = { ...DEFAULT_USERS };
if (fs.existsSync(USERS_FILE)) {
  try {
    users = { ...DEFAULT_USERS, ...JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) };
  } catch (e) {
    users = { ...DEFAULT_USERS };
  }
}

let sessions = {};
if (fs.existsSync(SESSIONS_FILE)) {
  try {
    sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (e) {
    sessions = {};
  }
}

function persistSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Warning] Gagal menyimpan sessions.json:', err.message);
  }
}

function extractToken(req, parsedUrl, body) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  if (parsedUrl.query && parsedUrl.query.token) {
    return parsedUrl.query.token;
  }
  if (body && body.token) {
    return body.token;
  }
  return null;
}

// --- 2. HELPER REQUEST BODY & CORS ---
function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// --- 3. SERVER HTTP ---
const server = http.createServer(async (req, res) => {
  setCORSHeaders(res);

  // Handle Preflight OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Endpoint 1: Healthcheck & Config Info
  if (pathname === '/api/health' || pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'Pacu Jalur 2027 Midtrans Server',
      mode: IS_PROD ? 'production' : 'sandbox',
      hasServerKey: !!SERVER_KEY && SERVER_KEY !== 'SB-Mid-server-YOUR_SERVER_KEY',
      clientKey: CLIENT_KEY || 'BELUM_DIISI',
      snapUrl: SNAP_URL,
      activeSessions: Object.keys(sessions).length
    }));
    return;
  }

  // --- ENDPOINTS AUTENTIKASI, SESI & ROLE SERVER ---

  // Endpoint Auth 1: Login Petugas (Admin, Juri, Agen)
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const data = await parseJSONBody(req);
      const role = (data.role || '').toLowerCase().trim();
      const identifier = (data.identifier || '').trim();
      const password = (data.password || data.pin || '').trim();

      if (!role || !identifier || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Role, identifier (Email/ID), dan password/PIN wajib diisi!' }));
        return;
      }

      // Validasi kredensial berdasarkan Role
      let matchedUser = null;

      if (role === 'admin') {
        const adminTpl = users.admin || DEFAULT_USERS.admin;
        const validIds = [
          (adminTpl.username || 'adminpacu1').toLowerCase(),
          adminTpl.email.toLowerCase(),
          'adminpacu1',
          'adminpacu1@pacujalur.com',
          'admin',
          'admin@pacujalur.com'
        ];
        const isIdValid = validIds.includes(identifier.toLowerCase());
        const isPassValid = adminTpl.passwords.includes(password);

        if (isIdValid && isPassValid) {
          matchedUser = {
            ...adminTpl,
            name: identifier === 'adminpacu1' ? 'Administrator Utama' : (identifier.includes('@') ? (identifier.split('@')[0]) : 'Administrator Utama'),
            email: identifier.includes('@') ? identifier : adminTpl.email
          };
        }
      } else if (role === 'juri') {
        const juriTpl = users.juri || DEFAULT_USERS.juri;
        const validIds = [
          (juriTpl.username || 'juripacu1').toLowerCase(),
          juriTpl.email.toLowerCase(),
          'juripacu1',
          'juripacu1@pacujalur.com',
          'juri',
          'juri.narosa@pacujalur.com'
        ];
        const isIdValid = validIds.includes(identifier.toLowerCase()) || identifier.length > 0;
        const isPassValid = juriTpl.passwords.includes(password);

        if (isIdValid && isPassValid) {
          matchedUser = {
            ...juriTpl,
            name: identifier === 'juripacu1' ? 'Juri Resmi Tepian Narosa' : (identifier.includes('@') ? identifier.split('@')[0] : identifier),
            email: identifier.includes('@') ? identifier : juriTpl.email
          };
        }
      } else if (role === 'agen') {
        const agenTpl = users.agen || DEFAULT_USERS.agen;
        const validIds = [
          (agenTpl.username || 'agentenda1').toLowerCase(),
          agenTpl.email.toLowerCase(),
          'agentenda1',
          'agentenda1@pacujalur.com',
          'agen',
          'agen #01 (tenda 3 narosa)'
        ];
        const isIdValid = validIds.includes(identifier.toLowerCase()) || identifier.length > 0;
        const isPassValid = agenTpl.passwords.includes(password);

        if (isIdValid && isPassValid) {
          matchedUser = {
            ...agenTpl,
            name: identifier === 'agentenda1' ? 'Agen Tenda 1 Narosa' : identifier,
            email: identifier.includes('@') ? identifier : agenTpl.email
          };
        }
      }

      if (!matchedUser) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Autentikasi gagal! Username/ID atau Password/PIN salah untuk role ini.'
        }));
        return;
      }

      // Terbitkan Session Token Aman 48-karakter hex
      const token = 'sess_' + crypto.randomBytes(24).toString('hex');
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Masa berlaku sesi 24 jam

      const sessionData = {
        token: token,
        uid: matchedUser.uid || ('usr_' + crypto.randomBytes(6).toString('hex')),
        name: matchedUser.name,
        email: matchedUser.email,
        role: matchedUser.role,
        permissions: matchedUser.permissions || [],
        hasPaid: true,
        paidDays: ['2027-08-21'],
        loginAt: now.toISOString(),
        expiresAt: expiresAt.toISOString()
      };

      sessions[token] = sessionData;
      persistSessions();

      console.log(`[Server Auth] Login Sukses: ${sessionData.name} (${sessionData.role.toUpperCase()}) | Token: ${token.substring(0, 15)}...`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        message: `Login berhasil sebagai ${sessionData.name}!`,
        token: token,
        user: sessionData
      }));
      return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gagal memproses login: ' + err.message }));
      return;
    }
  }

  // Endpoint Auth 2: Verifikasi & Ambil Data Sesi Pengguna Aktif
  if ((pathname === '/api/auth/session' || pathname === '/api/auth/verify') && (req.method === 'GET' || req.method === 'POST')) {
    let body = {};
    if (req.method === 'POST') {
      try { body = await parseJSONBody(req); } catch (e) {}
    }

    const token = extractToken(req, parsedUrl, body);

    if (!token || !sessions[token]) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: false, error: 'Sesi tidak ditemukan atau belum login.' }));
      return;
    }

    const session = sessions[token];
    const now = new Date();

    // Periksa apakah sesi telah kedaluwarsa
    if (new Date(session.expiresAt) < now) {
      delete sessions[token];
      persistSessions();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: false, error: 'Sesi telah kedaluwarsa. Silakan login kembali.' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      valid: true,
      status: 'authenticated',
      user: session
    }));
    return;
  }

  // Endpoint Auth 3: Logout & Hapus Sesi di Server
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    let body = {};
    try { body = await parseJSONBody(req); } catch (e) {}
    const token = extractToken(req, parsedUrl, body);

    if (token && sessions[token]) {
      console.log(`[Server Auth] Logout: ${sessions[token].name} (${sessions[token].role})`);
      delete sessions[token];
      persistSessions();
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', message: 'Sesi telah berhasil dihapus dari server.' }));
    return;
  }

  // Endpoint Auth 4: Daftar Akun & Sesi Aktif (Khusus Role Admin)
  if (pathname === '/api/auth/users' && req.method === 'GET') {
    const token = extractToken(req, parsedUrl, {});
    const session = token ? sessions[token] : null;

    if (!session || session.role !== 'admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Akses ditolak. Hanya Role Admin yang berhak melihat daftar akun.' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'success',
      activeSessionsCount: Object.keys(sessions).length,
      activeSessions: Object.values(sessions).map(s => ({
        name: s.name,
        role: s.role,
        email: s.email,
        loginAt: s.loginAt,
        expiresAt: s.expiresAt
      })),
      registeredRoles: ['admin', 'juri', 'agen']
    }));
    return;
  }

  // Endpoint 2: Minta Snap Token (Charge Catatan Digital Rp 5.000)
  if (pathname === '/api/midtrans/charge' && req.method === 'POST') {
    try {
      const data = await parseJSONBody(req);
      const amount = data.amount || 5000;
      const orderId = data.orderId || `PJ27-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const customerName = data.customerName || 'Penonton Narosa';
      const customerEmail = data.customerEmail || 'penonton@pacujalur.com';

      if (!SERVER_KEY || SERVER_KEY.includes('YOUR_SERVER_KEY')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'SERVER_KEY Midtrans belum dikonfigurasi di file .env!',
          solution: 'Buka midtrans-server/.env lalu tempel Server Key dari Dashboard Midtrans.'
        }));
        return;
      }

      // Buat payload transaksi untuk Midtrans Snap API
      const payload = {
        transaction_details: {
          order_id: orderId,
          gross_amount: amount
        },
        item_details: [
          {
            id: 'CATATAN-DIGITAL-5K',
            price: amount,
            quantity: 1,
            name: 'Catatan Digital Pacu Jalur 2027 (1 Hari)'
          }
        ],
        customer_details: {
          first_name: customerName,
          email: customerEmail
        },
        // Opsi metode pembayaran: QRIS (GoPay/ShopeePay/BCA/dll), Bank Transfer VA
        enabled_payments: ['qris', 'gopay', 'shopeepay', 'bca_va', 'bni_va', 'bri_va', 'permata_va']
      };

      // Panggil Snap API menggunakan fetch bawaan Node.js
      const authHeader = 'Basic ' + Buffer.from(SERVER_KEY + ':').toString('base64');
      const midtransRes = await fetch(SNAP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': authHeader
        },
        body: JSON.stringify(payload)
      });

      const result = await midtransRes.json();

      if (!midtransRes.ok) {
        console.error('[Midtrans Error]', result);
        res.writeHead(midtransRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gagal membuat Snap Token dari Midtrans', details: result }));
        return;
      }

      // Catat pesanan baru ke sistem penyimpanan lokal
      orders[orderId] = {
        orderId: orderId,
        amount: amount,
        status: 'pending',
        token: result.token,
        redirect_url: result.redirect_url,
        createdAt: new Date().toISOString(),
        customer: { name: customerName, email: customerEmail }
      };
      persistOrders();

      console.log(`[Order Created] ${orderId} | Token: ${result.token.substring(0, 15)}...`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        orderId: orderId,
        token: result.token,
        redirect_url: result.redirect_url,
        clientKey: CLIENT_KEY
      }));
    } catch (err) {
      console.error('[Charge Error]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Endpoint 3: Webhook Notification (Sinyal Otomatis Midtrans saat user berhasil scan/bayar)
  if (pathname === '/api/midtrans/notification' && req.method === 'POST') {
    try {
      const notify = await parseJSONBody(req);
      console.log(`[Webhook Diterima] Order: ${notify.order_id} | Status: ${notify.transaction_status}`);

      const orderId = notify.order_id;
      const statusCode = notify.status_code;
      const grossAmount = notify.gross_amount;
      const signatureKey = notify.signature_key;
      const transactionStatus = notify.transaction_status;
      const fraudStatus = notify.fraud_status;

      // Verifikasi Signature SHA512: SHA512(order_id + status_code + gross_amount + ServerKey)
      const inputStr = `${orderId}${statusCode}${grossAmount}${SERVER_KEY}`;
      const calculatedSignature = crypto.createHash('sha512').update(inputStr).digest('hex');

      if (signatureKey !== calculatedSignature) {
        console.warn(`[Peringatan Keamanan] Signature Key tidak valid untuk order: ${orderId}!`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid Signature Key' }));
        return;
      }

      // Perbarui status pesanan
      if (!orders[orderId]) {
        orders[orderId] = { orderId, amount: parseFloat(grossAmount), createdAt: new Date().toISOString() };
      }

      let isSuccess = false;
      if (transactionStatus === 'capture') {
        if (fraudStatus === 'accept') isSuccess = true;
      } else if (transactionStatus === 'settlement') {
        isSuccess = true;
      } else if (transactionStatus === 'cancel' || transactionStatus === 'deny' || transactionStatus === 'expire') {
        orders[orderId].status = 'failed';
      } else if (transactionStatus === 'pending') {
        orders[orderId].status = 'pending';
      }

      if (isSuccess) {
        orders[orderId].status = 'paid';
        orders[orderId].paidAt = new Date().toISOString();
        orders[orderId].paymentType = notify.payment_type;
        console.log(`✅ [SINYAL OTOMATIS SUKSES] Tiket untuk ${orderId} RESMI DIBAYAR!`);
      }

      persistOrders();

      // Wajib kirim response HTTP 200 OK ke Midtrans
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'OK' }));
    } catch (err) {
      console.error('[Webhook Error]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Endpoint 4: Cek Status Transaksi Spesifik (/api/midtrans/status/:orderId)
  if (pathname.startsWith('/api/midtrans/status/')) {
    const orderId = pathname.replace('/api/midtrans/status/', '').trim();
    if (!orderId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Order ID wajib diisi' }));
      return;
    }

    let order = orders[orderId];

    // Jika di lokal belum paid dan punya SERVER_KEY, coba tanyakan langsung ke Midtrans Status API
    if ((!order || order.status !== 'paid') && SERVER_KEY && !SERVER_KEY.includes('YOUR_SERVER_KEY')) {
      try {
        const authHeader = 'Basic ' + Buffer.from(SERVER_KEY + ':').toString('base64');
        const statusRes = await fetch(`${STATUS_BASE_URL}/${orderId}/status`, {
          headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
        });
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          if (statusData.transaction_status === 'settlement' || 
             (statusData.transaction_status === 'capture' && statusData.fraud_status === 'accept')) {
            if (!order) order = { orderId, amount: 5000 };
            order.status = 'paid';
            order.paidAt = statusData.settlement_time || new Date().toISOString();
            order.paymentType = statusData.payment_type;
            orders[orderId] = order;
            persistOrders();
          }
        }
      } catch (err) {
        console.warn(`[Status Check Warning] Gagal cek status API Midtrans untuk ${orderId}:`, err.message);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      orderId: orderId,
      status: order ? order.status : 'not_found',
      hasPaid: order ? order.status === 'paid' : false,
      details: order || null
    }));
    return;
  }

  // Endpoint 5: Halaman Beranda Dashboard Server
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const orderCount = Object.keys(orders).length;
    const paidCount = Object.values(orders).filter(o => o.status === 'paid').length;

    res.end(`
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <title>Midtrans Gateway Server - Pacu Jalur 2027</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
      </head>
      <body class="bg-slate-950 text-slate-100 min-h-screen p-6 font-sans">
        <div class="max-w-3xl mx-auto space-y-6">
          <div class="bg-slate-900 border border-emerald-500/40 rounded-2xl p-6 shadow-xl">
            <div class="flex items-center gap-3">
              <div class="w-12 h-12 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-2xl">
                <i class="fa-solid fa-server"></i>
              </div>
              <div>
                <h1 class="text-xl font-bold text-emerald-400">Midtrans Payment Gateway Server</h1>
                <p class="text-xs text-slate-400">Pacu Jalur Tepian Narosa 2027 - Backend Snap & Sinyal Otomatis (Webhook)</p>
              </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-6">
              <div class="bg-slate-950 p-4 rounded-xl border border-slate-800">
                <div class="text-[10px] text-slate-500 uppercase font-bold">Status Server</div>
                <div class="text-emerald-400 font-bold text-sm mt-1 flex items-center gap-1.5">
                  <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span> AKTIF (Port ${PORT})
                </div>
              </div>
              <div class="bg-slate-950 p-4 rounded-xl border border-slate-800">
                <div class="text-[10px] text-slate-500 uppercase font-bold">Mode Midtrans</div>
                <div class="text-amber-400 font-bold text-sm mt-1 uppercase">${IS_PROD ? 'PRODUCTION' : 'SANDBOX (Uji Coba)'}</div>
              </div>
              <div class="bg-slate-950 p-4 rounded-xl border border-slate-800">
                <div class="text-[10px] text-slate-500 uppercase font-bold">Server Key</div>
                <div class="text-xs font-mono mt-1 ${SERVER_KEY ? 'text-teal-300' : 'text-rose-400 font-bold'}">
                  ${SERVER_KEY ? (SERVER_KEY.substring(0, 10) + '...') : '⚠️ BELUM DIISI (.env)'}
                </div>
              </div>
            </div>
          </div>

          <!-- Statistik Transaksi -->
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
            <div class="flex justify-between items-center mb-4">
              <h2 class="text-sm font-bold text-slate-200"><i class="fa-solid fa-receipt text-amber-400"></i> Riwayat Transaksi Lokal</h2>
              <div class="text-xs text-slate-400">Total: <span class="font-bold text-white">${orderCount}</span> | Sukses: <span class="font-bold text-emerald-400">${paidCount}</span></div>
            </div>
            ${orderCount === 0 ? `
              <div class="text-center py-8 text-slate-500 text-xs">
                Belum ada transaksi. Buka <a href="http://localhost:3000/Pacu%20Jalur%20Live%20Tracker%202027.html" class="text-amber-400 underline">Pacu Jalur Live Tracker</a> untuk menguji pembayaran.
              </div>
            ` : `
              <div class="space-y-2 max-h-64 overflow-y-auto font-mono text-xs">
                ${Object.values(orders).reverse().map(o => `
                  <div class="p-3 bg-slate-950 rounded-xl border border-slate-800 flex justify-between items-center">
                    <div>
                      <div class="font-bold text-slate-200">${o.orderId}</div>
                      <div class="text-[10px] text-slate-500">${o.createdAt}</div>
                    </div>
                    <div class="text-right">
                      <div class="font-bold text-amber-400">Rp ${(o.amount || 5000).toLocaleString('id-ID')}</div>
                      <span class="px-2 py-0.5 rounded text-[10px] font-bold ${o.status === 'paid' ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40' : 'bg-amber-950 text-amber-300 border border-amber-500/40'}">
                        ${o.status.toUpperCase()}
                      </span>
                    </div>
                  </div>
                `).join('')}
              </div>
            `}
          </div>

          <!-- Petunjuk Konfigurasi Webhook -->
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-3 text-xs text-slate-300">
            <h3 class="font-bold text-amber-400 text-sm"><i class="fa-solid fa-bolt"></i> URL Webhook (Sinyal Otomatis Midtrans):</h3>
            <p>Untuk menerima sinyal otomatis pembayaran dari Midtrans ke komputer lokal:</p>
            <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 font-mono text-emerald-400">
              POST http://localhost:${PORT}/api/midtrans/notification
            </div>
            <p class="text-slate-400 text-[11px]">
              Gunakan <b>ngrok http ${PORT}</b> untuk mendapatkan URL publik (cth: <code class="text-amber-300">https://xxxx.ngrok-free.app/api/midtrans/notification</code>), lalu pasang di Dashboard Midtrans > Settings > Configuration.
            </p>
          </div>
        </div>
      </body>
      </html>
    `);
    return;
  }

  // Default 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint tidak ditemukan' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🚀 MIDTRANS SERVER AKTIF DI: http://0.0.0.0:${PORT}`);
  console.log(`Mode: ${IS_PROD ? 'PRODUCTION' : 'SANDBOX'}`);
  console.log(`Client Key: ${CLIENT_KEY || '(Belum diatur di .env)'}`);
  console.log(`Server Key: ${SERVER_KEY ? (SERVER_KEY.substring(0, 8) + '...') : '(Belum diatur di .env)'}`);
  console.log(`======================================================\n`);
});

