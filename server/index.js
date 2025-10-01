import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { nanoid } from 'nanoid';
import path from 'path';
import fs from 'fs';

const __dirname = path.resolve();
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingInterval: 20000,
  pingTimeout: 20000
});

app.use(cors());
app.use(compression());
app.use(express.json());

// Static files: cache assets, never cache HTML (so updates take effect)
const ONE_WEEK = 1000 * 60 * 60 * 24 * 7;
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: ONE_WEEK,
  etag: true,
  lastModified: true,
  setHeaders: (res, fp) => {
    if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => { console.log(`${req.method} ${req.url}`); next(); });
}

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- DB bootstrap (Railway/Render friendly) ---
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'server');
fs.mkdirSync(DATA_DIR, { recursive: true });
const dbFile = path.join(DATA_DIR, 'db.json');
if (!fs.existsSync(dbFile)) {
  fs.writeFileSync(dbFile, JSON.stringify({ donors: [], meta: { nextDonorNo: 1, lastBatch: 0, batches: [] } }, null, 2));
}
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { donors: [], meta: { nextDonorNo: 1, lastBatch: 0, batches: [] } });
await db.read();

// ---- broadcast/write coalescing (reduce chatter & disk I/O) ----
let _broadcastTimer = null;
function lightDonor(d){
  const { id, DonorID, FullName, PreRegistered, Status, ScreeningStatus, RegisteredAt, ApprovedAt, DonationStartAt } = d;
  return { id, DonorID, FullName, PreRegistered, Status, ScreeningStatus, RegisteredAt, ApprovedAt, DonationStartAt };
}
function lightState(){
  return { donors: db.data.donors.map(lightDonor), meta: db.data.meta };
}
function broadcastCoalesced() {
  if (_broadcastTimer) return;
  _broadcastTimer = setTimeout(() => {
    _broadcastTimer = null;
    io.emit('state', lightState());
  }, 80);
}
let _writeTimer = null;
async function writeCoalesced() {
  if (_writeTimer) return;
  _writeTimer = setTimeout(async () => {
    _writeTimer = null;
    await db.write();
  }, 80);
}
const save = async () => { await writeCoalesced(); broadcastCoalesced(); };

io.on('connection', (socket) => {
  socket.emit('state', lightState());
});

// --- constants ---
const MAX_BEDS = 6;
const MAX_QUEUE = 6;
const PRE_STRICT = 4;
const WALK_STRICT = 2;

const donorsBy = (pred) => db.data.donors.filter(pred);
const byDate = (arr, key) => arr.sort((a,b)=> new Date(a[key]||0) - new Date(b[key]||0));
const bedsInUse = () => donorsBy(d => d.Status === 'Donation-In-Progress').length;
const bedsAvail = () => Math.max(0, MAX_BEDS - bedsInUse());
const countQueue = () => donorsBy(d => d.Status === 'Donation-Queue').length;
const now = () => new Date().toISOString();

// --- FLOW ---
app.post('/api/register', async (req, res) => {
  try {
    const { FullName, Phone = '', PreRegistered = false, PhotoConsent = true, HasPhoto = false } = req.body || {};
    if (!FullName) return res.status(400).json({ error: 'Full Name required' });
    const donor = {
      id: nanoid(10),
      DonorID: String(db.data.meta.nextDonorNo++),
      FullName, Phone, PreRegistered, PhotoConsent, HasPhoto,
      Status: 'Waiting',
      ScreeningStatus: 'Not-Started',
      QueueBatch: null,
      BedType: PreRegistered ? 'Pre-Registered' : 'Walk-In',
      BedNumber: null,
      PhotoPrinted: false,
      RiceBagGiven: false,
      PhotoGiven: false,
      RegisteredAt: now()
    };
    db.data.donors.push(donor);
    await save();
    res.json(donor);
  } catch (e) {
    console.error('register error', e);
    res.status(500).json({ error: 'Register failed' });
  }
});

app.post('/api/action/send-to-screening', async (req, res) => {
  const d = db.data.donors.find(x => x.id === req.body.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.Status !== 'Waiting') return res.status(409).json({ error: 'Not in Waiting' });
  d.Status = 'Screening';
  d.ScreeningStatus = 'In-Progress';
  d.ScreeningStartAt = now();
  await save();
  res.json(d);
});

app.post('/api/action/approve', async (req, res) => {
  if (countQueue() >= MAX_QUEUE) return res.status(409).json({ error: 'Chairs full (6). Move some to beds first.' });
  const d = db.data.donors.find(x => x.id === req.body.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.Status !== 'Screening') return res.status(409).json({ error: 'Not in Screening' });
  d.ScreeningStatus = 'Eligible';
  d.Status = 'Donation-Queue';
  d.ApprovedAt = now();
  await save();
  res.json(d);
});

app.post('/api/action/reject', async (req, res) => {
  const d = db.data.donors.find(x => x.id === req.body.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.Status !== 'Screening') return res.status(409).json({ error: 'Not in Screening' });
  d.ScreeningStatus = 'Rejected';
  d.Status = 'Rejected';
  d.RejectionReason = req.body.reason || '';
  d.RejectedAt = now();
  d.PhotoPrinted = false;
  await save();
  res.json(d);
});

// Manual: chairs -> bed
app.post('/api/action/move-to-bed', async (req, res) => {
  const d = db.data.donors.find(x => x.id === req.body.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.Status !== 'Donation-Queue') return res.status(409).json({ error: 'Not in Chairs' });
  if (bedsAvail() <= 0) return res.status(409).json({ error: 'No bed available' });
  d.Status = 'Donation-In-Progress';
  d.DonationStartAt = now();
  await save();
  res.json({ ok: true, moved: 1 });
});

// Auto: FIFO
app.post('/api/action/fill-beds-fifo', async (_req, res) => {
  let avail = bedsAvail(); if (avail <= 0) return res.json({ moved: 0 });
  const anyQ = byDate(donorsBy(d => d.Status === 'Donation-Queue'), 'ApprovedAt');
  let moved = 0;
  while (avail > 0 && anyQ.length) {
    const d = anyQ.shift();
    d.Status = 'Donation-In-Progress';
    d.DonationStartAt = now();
    avail--; moved++;
  }
  await save();
  res.json({ moved });
});

// Auto: 4+2
app.post('/api/action/fill-beds-4p2', async (_req, res) => {
  let avail = bedsAvail(); if (avail <= 0) return res.json({ moved: 0, reason: 'no_bed' });
  const preQ  = byDate(donorsBy(d => d.Status === 'Donation-Queue' && d.PreRegistered), 'ApprovedAt');
  const walkQ = byDate(donorsBy(d => d.Status === 'Donation-Queue' && !d.PreRegistered), 'ApprovedAt');
  if (preQ.length < PRE_STRICT || walkQ.length < WALK_STRICT) {
    return res.status(409).json({ error: `Need at least ${PRE_STRICT} pre-reg and ${WALK_STRICT} walk-in in chairs` });
  }
  let moved = 0;
  const take = (arr)=> {
    if (avail<=0 || !arr.length) return;
    const d = arr.shift(); d.Status='Donation-In-Progress'; d.DonationStartAt=now(); avail--; moved++;
  };
  for (let i=0;i<PRE_STRICT && avail>0;i++) take(preQ);
  for (let i=0;i<WALK_STRICT && avail>0;i++) take(walkQ);
  await save();
  res.json({ moved });
});

// Bed -> Recovery
app.post('/api/action/to-recovery', async (req, res) => {
  const d = db.data.donors.find(x => x.id === req.body.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.Status !== 'Donation-In-Progress') return res.status(409).json({ error: 'Not in bed' });
  d.Status = 'Recovery';
  d.RecoveryStartAt = now();
  await save();
  res.json(d);
});

// Recovery -> Recovered
app.post('/api/action/recovered', async (req, res) => {
  const d = db.data.donors.find(x => x.id === req.body.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.Status !== 'Recovery') return res.status(409).json({ error: 'Not in Recovery' });
  d.Status = 'Recovered';
  d.RecoveryEndAt = now();
  await save();
  res.json(d);
});

// Complete
app.post('/api/action/complete', async (req, res) => {
  const d = db.data.donors.find(x => x.id === req.body.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.Status !== 'Recovered' && d.Status !== 'Recovery') return res.status(409).json({ error: 'Not ready' });
  d.Status = 'Completed & Left';
  d.RiceBagGiven = true;
  d.PhotoGiven = true;
  d.PhotoPrinted = true;
  d.CompletedAt = now();
  await save();
  res.json(d);
});

// Raw state & export
app.get('/api/state', (_req, res) => res.json(lightState()));
app.get('/api/export.csv', (_req, res) => {
  const cols = [
    'DonorID','FullName','Phone','PreRegistered','HasPhoto','Status','ScreeningStatus',
    'QueueBatch','BedType','BedNumber','PhotoPrinted','RiceBagGiven','PhotoGiven',
    'RegisteredAt','ScreeningStartAt','ApprovedAt','DonationStartAt','RecoveryStartAt',
    'RecoveryEndAt','CompletedAt','RejectedAt','RejectionReason'
  ];
  const csv = [cols.join(',')].concat(
    db.data.donors.map(d => cols.map(c => JSON.stringify(d[c] ?? '')).join(','))
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="donors.csv"');
  res.send(csv);
});

// Reset
app.post('/api/reset', async (_req, res) => {
  db.data = { donors: [], meta: { nextDonorNo: 1, lastBatch: 0, batches: [] } };
  await save();
  res.json({ ok: true });
});

const port = process.env.PORT || 4000;
const host = process.env.HOST || '0.0.0.0';
httpServer.listen(port, host, () => console.log(`BloodDrive -> http://localhost:${port}`));
