// Servora - server
// ---------------------------------------------------------
// Ce face acest fisier (pe scurt):
//  - tine minte restaurantele si comenzile intr-o baza de date (MongoDB)
//  - fiecare restaurant are un "slug" (un nume scurt pentru link), de ex.
//    "burger-bar". Codul QR al restaurantului duce la adresa /r/burger-bar
//  - clientul scaneaza QR-ul, scrie numarul de pe bon, iar serverul tine
//    minte ca acel client asteapta numarul respectiv
//  - bucataria apasa "Gata" -> clientul e anuntat (sunet + vibratie pe
//    pagina deschisa, plus notificare push acolo unde telefonul o accepta)
//
// Adresele (rutele) principale:
//   PAGINI
//     GET  /                         -> pagina de prezentare Servora
//     GET  /r/:slug                  -> pagina clientului pentru un restaurant
//     GET  /qr/:slug.png             -> imaginea codului QR a restaurantului
//     /kitchen.html, /admin.html, /print.html -> panou bucatarie, admin, card QR de printat
//   CLIENT (fara login)
//     GET  /api/r/:slug              -> numele restaurantului
//     POST /api/r/:slug/orders       -> clientul isi inregistreaza numarul de comanda
//     GET  /api/orders/:id           -> starea unei comenzi (clientul intreaba des)
//     POST /api/orders/:id/subscribe -> abonare la notificari push
//     GET  /api/vapid-public-key     -> cheia publica pentru notificari push
//   BUCATARIE (cu login)
//     POST /api/login                -> user + parola -> "bilet" (token)
//     GET  /api/orders               -> comenzile active ale restaurantului
//     POST /api/orders/ready-by-number -> marcheaza gata dupa numar (tastat)
//     POST /api/orders/:id/ready     -> marcheaza gata
//     POST /api/orders/:id/pending   -> anuleaza "gata" (apasat din greseala)
//     POST /api/orders/:id/done      -> comanda a fost ridicata
//   ADMIN (doar tu, cu ADMIN_KEY)
//     GET/POST /api/admin/restaurants
//     POST /api/admin/restaurants/:id/toggle
//     POST /api/admin/restaurants/:id/password

const express = require('express');
const webpush = require('web-push');
const crypto = require('crypto');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
// Render pune serverul "in spatele" unui proxy - fara asta, adresele
// generate (ex. in codul QR) ar incepe cu http:// in loc de https://
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------
// Setari din "Environment Variables" (Render). NU se scriu in cod.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:montterius@gmail.com';
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_KEY = process.env.ADMIN_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
// Numele bazei de date. Poti folosi ACEEASI adresa MONGODB_URI ca la
// OrderPing - datele Servora stau separat, in baza de date "servora".
const MONGODB_DB = process.env.MONGODB_DB || 'servora';
// Optional: adresa publica a site-ului (ex. https://servora.ro). Daca
// lipseste, o deducem automat din cerere.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

let pushEnabled = false;
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn('LIPSESC VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY - notificarile push sunt oprite (sunetul pe pagina merge in continuare).');
} else {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  pushEnabled = true;
}
if (!JWT_SECRET) console.error('LIPSESTE variabila de mediu JWT_SECRET.');
if (!ADMIN_KEY) console.error('LIPSESTE variabila de mediu ADMIN_KEY.');
if (!MONGODB_URI) console.error('LIPSESTE variabila de mediu MONGODB_URI.');

let ordersCollection = null;
let restaurantsCollection = null;

async function connectToDatabase() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);
  ordersCollection = db.collection('orders');
  restaurantsCollection = db.collection('restaurants');
  // "Indexuri" = cuprinsul bazei de date: cautarile devin rapide, iar
  // doua restaurante nu pot avea acelasi user sau acelasi link.
  await restaurantsCollection.createIndex({ username: 1 }, { unique: true });
  await restaurantsCollection.createIndex({ slug: 1 }, { unique: true });
  await ordersCollection.createIndex({ restaurantId: 1, number: 1, status: 1 });
  console.log('Conectat la MongoDB, baza de date "' + MONGODB_DB + '".');
}

// ---------------------------------------------------------
// Functii ajutatoare

// Numarul de pe bon: il facem MAJUSCULE si scoatem spatiile, ca "a 12"
// si "A12" sa fie acelasi lucru. Acceptam litere, cifre si cratima.
function normalizeNumber(raw) {
  if (raw === undefined || raw === null) return null;
  const n = String(raw).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9-]{1,10}$/.test(n)) return null;
  return n;
}

// Din "Burger Bar Brașov" facem "burger-bar-brasov" (fara diacritice).
function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function baseUrl(req) {
  return PUBLIC_URL || (req.protocol + '://' + req.get('host'));
}

function publicOrder(o, restaurant) {
  const out = {
    id: o._id,
    number: o.number,
    status: o.status,
    createdAt: o.createdAt,
    readyAt: o.readyAt || null,
    clientCount: o.clientCount || 0,
  };
  if (restaurant) {
    out.restaurantName = restaurant.name;
    out.restaurantSlug = restaurant.slug;
  }
  return out;
}

function publicRestaurant(r) {
  return {
    id: r._id.toString(),
    name: r.name,
    slug: r.slug,
    username: r.username,
    active: r.active !== false,
    createdAt: r.createdAt,
  };
}

// Stergem automat comenzile vechi, ca baza de date sa nu creasca la infinit.
async function pruneOldOrders() {
  const now = Date.now();
  try {
    await ordersCollection.deleteMany({
      $or: [
        { status: 'done', doneAt: { $lt: now - 60 * 60 * 1000 } }, // ridicate de > 1 ora
        { createdAt: { $lt: now - 6 * 60 * 60 * 1000 } },          // orice comanda > 6 ore
      ],
    });
  } catch (err) {
    console.error('Eroare la stergerea comenzilor vechi:', err);
  }
}

// O "frana" simpla: un singur telefon nu poate inregistra sute de comenzi
// pe minut (protectie impotriva glumelor / abuzurilor).
const hits = new Map();
function rateLimit(maxPerWindow, windowMs) {
  return function (req, res, next) {
    const key = req.ip + '|' + req.path;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    entry.count++;
    if (entry.count > maxPerWindow) {
      return res.status(429).json({ error: 'prea_multe_cereri' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now - v.start > 15 * 60 * 1000) hits.delete(k);
}, 5 * 60 * 1000).unref();

// Trimite notificarea push catre telefoanele abonate la comanda.
async function notifyOrderReady(order, restaurantName) {
  if (!pushEnabled) return;
  const payload = JSON.stringify({
    title: '🔔 Comanda #' + order.number + ' e gata!',
    body: 'Te așteaptă la ' + (restaurantName || 'tejghea') + '. Poftă bună!',
    orderId: order._id,
  });
  const stillValid = [];
  for (const sub of order.subscriptions || []) {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch (err) {
      const code = err && err.statusCode;
      if (code !== 404 && code !== 410) {
        console.error('Eroare la trimiterea notificarii push:', code, err && err.body);
        stillValid.push(sub);
      }
    }
  }
  await ordersCollection.updateOne({ _id: order._id }, { $set: { subscriptions: stillValid } });
}

// Verifica "biletul" de login al bucatariei.
async function requireRestaurant(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'neautentificat' });
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'token_invalid' });
    }
    if (!ObjectId.isValid(payload.restaurantId)) return res.status(401).json({ error: 'token_invalid' });
    const restaurant = await restaurantsCollection.findOne({ _id: new ObjectId(payload.restaurantId) });
    if (!restaurant || restaurant.active === false) {
      return res.status(401).json({ error: 'cont_inactiv' });
    }
    req.restaurant = restaurant;
    next();
  } catch (err) {
    console.error('Eroare la autentificare:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
}

function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key');
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'cheie_admin_invalida' });
  }
  next();
}

async function findActiveRestaurantBySlug(slug) {
  if (!SLUG_RE.test(slug || '')) return null;
  const r = await restaurantsCollection.findOne({ slug: slug });
  if (!r || r.active === false) return null;
  return r;
}

// ---------------------------------------------------------
// PAGINI

// Pagina clientului: aceeasi pagina pentru toate restaurantele - ea
// citeste singura din adresa la ce restaurant e clientul.
app.get('/r/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});
// Daca cineva deschide doar /r (fara restaurant), aratam lista lui de comenzi.
app.get('/r', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

// Imaginea codului QR al unui restaurant. ?size=600 pentru printare mare.
app.get('/qr/:slug.png', async (req, res) => {
  try {
    const restaurant = await findActiveRestaurantBySlug(req.params.slug);
    if (!restaurant) return res.status(404).end();
    const size = Math.min(Math.max(parseInt(req.query.size, 10) || 400, 120), 1200);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    await QRCode.toFileStream(res, baseUrl(req) + '/r/' + restaurant.slug, {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
    });
  } catch (err) {
    console.error('Eroare la generare cod QR:', err);
    res.status(500).end();
  }
});

// ---------------------------------------------------------
// API - CLIENT (fara login)

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: pushEnabled ? VAPID_PUBLIC_KEY : null });
});

app.get('/api/r/:slug', async (req, res) => {
  try {
    const restaurant = await findActiveRestaurantBySlug(req.params.slug);
    if (!restaurant) return res.status(404).json({ error: 'restaurant_negasit' });
    res.json({ id: restaurant._id.toString(), name: restaurant.name, slug: restaurant.slug });
  } catch (err) {
    console.error('Eroare la citire restaurant:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

// Clientul isi scrie numarul de pe bon. REGULA: un numar activ poate fi
// urmarit de UN SINGUR telefon. Daca alt telefon l-a scris deja (ex. cineva
// a gresit si a scris numarul altui client), refuzam - ca sa nu fie chemate
// doua persoane pentru aceeasi comanda.
// Exceptie: daca bucataria a marcat numarul "gata" inainte ca vreun client
// sa-l scrie, primul client care il scrie il "preia".
app.post('/api/r/:slug/orders', rateLimit(120, 10 * 60 * 1000), async (req, res) => {
  try {
    const restaurant = await findActiveRestaurantBySlug(req.params.slug);
    if (!restaurant) return res.status(404).json({ error: 'restaurant_negasit' });

    const number = normalizeNumber(req.body && req.body.number);
    if (!number) return res.status(400).json({ error: 'numar_invalid' });

    const restaurantId = restaurant._id.toString();
    const active = { restaurantId, number, status: { $in: ['pending', 'ready'] } };

    // 1) comanda creata de bucatarie, pe care inca nu o urmareste nimeni -> o preia acest client
    const claimed = await ordersCollection.findOneAndUpdate(
      { ...active, clientCount: { $lt: 1 } },
      { $set: { clientCount: 1 } },
      { returnDocument: 'after', sort: { createdAt: -1 } }
    );
    if (claimed) return res.json(publicOrder(claimed, restaurant));

    // 2) numarul e deja urmarit de alt telefon -> refuzam
    const taken = await ordersCollection.findOne(active);
    if (taken) return res.status(409).json({ error: 'numar_ocupat' });

    const order = {
      _id: crypto.randomUUID(),
      restaurantId,
      number,
      status: 'pending',
      createdAt: Date.now(),
      readyAt: null,
      clientCount: 1,
      subscriptions: [],
    };
    await ordersCollection.insertOne(order);
    res.status(201).json(publicOrder(order, restaurant));
  } catch (err) {
    console.error('Eroare la inregistrarea comenzii:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

// Cache mic cu numele restaurantelor, ca sa nu intrebam baza de date de
// fiecare data cand un client verifica starea comenzii (la 3 secunde).
const restaurantCache = new Map();
async function getRestaurantCached(id) {
  const hit = restaurantCache.get(id);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.r;
  if (!ObjectId.isValid(id)) return null;
  const r = await restaurantsCollection.findOne({ _id: new ObjectId(id) });
  restaurantCache.set(id, { r, at: Date.now() });
  return r;
}

app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await ordersCollection.findOne({ _id: req.params.id });
    if (!order) return res.status(404).json({ error: 'negasita' });
    const restaurant = await getRestaurantCached(order.restaurantId);
    res.set('Cache-Control', 'no-store');
    res.json(publicOrder(order, restaurant));
  } catch (err) {
    console.error('Eroare la citire comanda:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.post('/api/orders/:id/subscribe', rateLimit(30, 10 * 60 * 1000), async (req, res) => {
  try {
    const subscription = req.body && req.body.subscription;
    if (!subscription || typeof subscription.endpoint !== 'string' || !/^https:\/\//.test(subscription.endpoint)) {
      return res.status(400).json({ error: 'abonare_invalida' });
    }
    const order = await ordersCollection.findOne({ _id: req.params.id });
    if (!order) return res.status(404).json({ error: 'negasita' });
    const already = (order.subscriptions || []).some(s => s.endpoint === subscription.endpoint);
    if (!already && (order.subscriptions || []).length < 10) {
      await ordersCollection.updateOne({ _id: order._id }, { $push: { subscriptions: subscription } });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Eroare la abonare:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

// ---------------------------------------------------------
// API - BUCATARIE (cu login)

app.post('/api/login', rateLimit(15, 10 * 60 * 1000), async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'date_lipsa' });
    const restaurant = await restaurantsCollection.findOne({ username: String(username).trim().toLowerCase() });
    if (!restaurant) return res.status(401).json({ error: 'date_gresite' });
    const ok = await bcrypt.compare(String(password), restaurant.passwordHash);
    if (!ok) return res.status(401).json({ error: 'date_gresite' });
    if (restaurant.active === false) return res.status(401).json({ error: 'cont_inactiv' });
    const token = jwt.sign({ restaurantId: restaurant._id.toString() }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, name: restaurant.name, slug: restaurant.slug });
  } catch (err) {
    console.error('Eroare la login:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.get('/api/orders', requireRestaurant, async (req, res) => {
  try {
    const list = await ordersCollection
      .find({ restaurantId: req.restaurant._id.toString(), status: { $in: ['pending', 'ready'] } })
      .sort({ createdAt: 1 })
      .toArray();
    res.set('Cache-Control', 'no-store');
    res.json({
      restaurant: { name: req.restaurant.name, slug: req.restaurant.slug },
      orders: list.map(o => publicOrder(o)),
    });
  } catch (err) {
    console.error('Eroare la listare comenzi:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

async function markReady(order, restaurant) {
  const readyAt = Date.now();
  await ordersCollection.updateOne({ _id: order._id }, { $set: { status: 'ready', readyAt } });
  notifyOrderReady(order, restaurant.name).catch(err => console.error('notifyOrderReady a esuat:', err));
  return { ...order, status: 'ready', readyAt };
}

// Bucataria tasteaza numarul de pe bon. Daca un client l-a inregistrat
// deja, il anuntam. Daca nu, cream comanda direct "gata" - cand clientul
// isi va scrie numarul, va vedea imediat ca e gata.
app.post('/api/orders/ready-by-number', requireRestaurant, async (req, res) => {
  try {
    const number = normalizeNumber(req.body && req.body.number);
    if (!number) return res.status(400).json({ error: 'numar_invalid' });
    const restaurantId = req.restaurant._id.toString();
    const existing = await ordersCollection.findOne(
      { restaurantId, number, status: { $in: ['pending', 'ready'] } },
      { sort: { createdAt: -1 } }
    );
    if (existing) {
      if (existing.status === 'ready') return res.json(publicOrder(existing));
      const updated = await markReady(existing, req.restaurant);
      return res.json(publicOrder(updated));
    }
    const now = Date.now();
    const order = {
      _id: crypto.randomUUID(),
      restaurantId,
      number,
      status: 'ready',
      createdAt: now,
      readyAt: now,
      clientCount: 0,
      subscriptions: [],
    };
    await ordersCollection.insertOne(order);
    res.status(201).json(publicOrder(order));
  } catch (err) {
    console.error('Eroare la marcarea dupa numar:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.post('/api/orders/:id/ready', requireRestaurant, async (req, res) => {
  try {
    const order = await ordersCollection.findOne({ _id: req.params.id, restaurantId: req.restaurant._id.toString() });
    if (!order) return res.status(404).json({ error: 'negasita' });
    const updated = await markReady(order, req.restaurant);
    res.json(publicOrder(updated));
  } catch (err) {
    console.error('Eroare la marcarea comenzii gata:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.post('/api/orders/:id/pending', requireRestaurant, async (req, res) => {
  try {
    const result = await ordersCollection.findOneAndUpdate(
      { _id: req.params.id, restaurantId: req.restaurant._id.toString() },
      { $set: { status: 'pending', readyAt: null } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'negasita' });
    res.json(publicOrder(result));
  } catch (err) {
    console.error('Eroare la anularea "gata":', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.post('/api/orders/:id/done', requireRestaurant, async (req, res) => {
  try {
    const result = await ordersCollection.findOneAndUpdate(
      { _id: req.params.id, restaurantId: req.restaurant._id.toString() },
      { $set: { status: 'done', doneAt: Date.now() } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'negasita' });
    res.json(publicOrder(result));
  } catch (err) {
    console.error('Eroare la marcarea comenzii ridicata:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

// ---------------------------------------------------------
// API - ADMIN (doar tu)

app.post('/api/admin/restaurants', requireAdmin, async (req, res) => {
  try {
    const { name, username, password } = req.body || {};
    if (!name || !username || !password) return res.status(400).json({ error: 'date_lipsa' });
    if (String(password).length < 6) return res.status(400).json({ error: 'parola_scurta' });

    const cleanUser = String(username).trim().toLowerCase();
    if (await restaurantsCollection.findOne({ username: cleanUser })) {
      return res.status(409).json({ error: 'user_existent' });
    }

    // Link-ul restaurantului: din campul "slug" daca l-ai scris, altfel din nume.
    let base = slugify(req.body.slug || name) || 'restaurant';
    let slug = base;
    for (let i = 2; await restaurantsCollection.findOne({ slug }); i++) slug = base + '-' + i;

    const restaurant = {
      name: String(name).trim().slice(0, 60),
      slug,
      username: cleanUser,
      passwordHash: await bcrypt.hash(String(password), 10),
      active: true,
      createdAt: Date.now(),
    };
    const result = await restaurantsCollection.insertOne(restaurant);
    restaurant._id = result.insertedId;
    res.status(201).json(publicRestaurant(restaurant));
  } catch (err) {
    console.error('Eroare la creare restaurant:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.get('/api/admin/restaurants', requireAdmin, async (req, res) => {
  try {
    const list = await restaurantsCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json(list.map(publicRestaurant));
  } catch (err) {
    console.error('Eroare la listare restaurante:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.post('/api/admin/restaurants/:id/toggle', requireAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'negasit' });
    const restaurant = await restaurantsCollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!restaurant) return res.status(404).json({ error: 'negasit' });
    const newActive = restaurant.active === false;
    await restaurantsCollection.updateOne({ _id: restaurant._id }, { $set: { active: newActive } });
    restaurantCache.delete(req.params.id);
    res.json(publicRestaurant({ ...restaurant, active: newActive }));
  } catch (err) {
    console.error('Eroare la activare/dezactivare restaurant:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

app.post('/api/admin/restaurants/:id/password', requireAdmin, async (req, res) => {
  try {
    const password = req.body && req.body.password;
    if (!password || String(password).length < 6) return res.status(400).json({ error: 'parola_scurta' });
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'negasit' });
    const result = await restaurantsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { passwordHash: await bcrypt.hash(String(password), 10) } }
    );
    if (!result.matchedCount) return res.status(404).json({ error: 'negasit' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Eroare la schimbarea parolei:', err);
    res.status(500).json({ error: 'eroare_server' });
  }
});

// ---------------------------------------------------------
// Pornirea serverului

const PORT = process.env.PORT || 3000;

connectToDatabase()
  .then(() => {
    setInterval(pruneOldOrders, 10 * 60 * 1000);
    app.listen(PORT, () => console.log('Servora ruleaza pe portul ' + PORT));
  })
  .catch(err => {
    console.error('Nu m-am putut conecta la baza de date:', err);
    process.exit(1);
  });
