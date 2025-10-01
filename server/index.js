import express from 'express';
import cors from 'cors';
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
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());                     // safe for LAN/mobile access
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, _res, next) => { console.log(`${req.method} ${req.url}`); next(); });

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- DB bootstrap ---
const dbFile = path.join(__dirname, 'server', 'db.json');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
if (!fs.existsSync(dbFile)) {
  fs.writeFileSync(
    dbFile,
    JSON.stringify({ donors: [], meta: { nextDonorNo: 1, lastBatch: 0, batches: [] } }, null, 2)
  );
}
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { donors: [], meta: { nextDonorNo: 1, lastBatch: 0, batches: [] } });
await db.read();

// helpers
const now = () => new Date().toISOString();
const byDate = (arr, key) => arr.sort((a,b) => new Date(a[key] || 0) - new Date(b[key] || 0));
const donorsBy = (predicate) => db.data.donors.filter(predicate);

const broadcast = () => io.emit('state', { donors: db.data.donors, meta: db.data.meta });
const save = async () => { await db.write(); broadcast(); };

// socket push
io.on('connection', (socket) => {
  socket.emit('state', { donors: db.data.donors, meta: db.data.meta });
});

// --- Donation room constants ---
const MAX_BEDS = 6;      // total beds
const MAX_QUEUE = 6;     // chairs capacity
const PRE_STRICT = 4;    // strict 4+2
const WALK_STRICT = 2;

const bedsInUse = () => donorsBy(d => d.Status === 'Donation-In-Progress').length;
const bedsAvail = () => Math.max(0, MAX_BEDS - bedsInUse());
const countQueue = () => donorsBy(d => d.Status === 'Donation-Queue').length;

// --- FLOW ---

// Register -> Waiting
app.post('/api/register', async (req, res) => {
  try {
    const { FullName, Phone = '', PreRegistered = false, PhotoConsent = true, HasPhoto = false } = req.body || {};
    if (!FullName) return res.status(400).json({ error: 'Full Name required' });

    const donor = {
      id: nanoid(10),
      DonorID: String(db.data.meta.nextDonorNo++), // 1,2,3,...
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

// Waiting -> Screening
app.post('/api/action/send-to-screening', async (req, res) => {
  const d = db.data.donors.find(x => x.id === req.body.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.Status !== 'Waiting') return res.status(409).json({ error: 'Donor not in Waiting' });
  d.Status = 'Screening';
  d.ScreeningStatus = 'In-Progress';
  d.ScreeningStartAt = now();
  await save();
  res.json(d);
});

// Screening Approve -> Chairs (Donation-Queue) if space
app.post('/api/action/approve', async (req, res) => {
  if (countQueue() >= MAX_QUEUE) {
    return res.status(409).json({ error: 'Chairs full (6). Move some to beds first.' });
  }
  const d = db.data.donors.find(x => x.id === req.body.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.Status !== 'Screening') return res.status(409).json({ error: 'Not in Screening' });
  d.ScreeningStatus = 'Eligible';
  d.Status = 'Donation-Queue';
  d.ApprovedAt = now();
  await save();
  res.json(d);
});

// Screening Reject -> Rejected
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

// Manual one-by-one: Chairs -> Bed
app.post('/api/action/move-to-bed', async (req, res) => {
  const d = db.data.donors.find(x => x.id === req.body.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.Status !== 'Donation-Queue') return res.status(409).json({ error: 'Donor not in Chairs' });
  if (bedsAvail() <= 0) return res.status(409).json({ error: 'No bed available' });
  d.Status = 'Donation-In-Progress';
  d.DonationStartAt = now();
  await save();
  res.json({ ok: true, moved: 1 });
});

// Auto: FIFO fill
app.post('/api/action/fill-beds-fifo', async (_req, res) => {
  let avail = bedsAvail();
  if (avail <= 0) return res.json({ moved: 0 });
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

// Auto: 4+2 strict fill (only if available right now)
app.post('/api/action/fill-beds-4p2', async (_req, res) => {
  let avail = bedsAvail();
  if (avail <= 0) return res.json({ moved: 0, reason: 'no_bed' });

  const preQ  = byDate(donorsBy(d => d.Status === 'Donation-Queue' && d.PreRegistered), 'ApprovedAt');
  const walkQ = byDate(donorsBy(d => d.Status === 'Donation-Queue' && !d.PreRegistered), 'ApprovedAt');
  if (preQ.length < PRE_STRICT || walkQ.length < WALK_STRICT) {
    return res.status(409).json({ error: `Need at least ${PRE_STRICT} pre-reg and ${WALK_STRICT} walk-in in chairs` });
  }

  let moved = 0;
  const takeFrom = (arr) => {
    if (avail <= 0 || arr.length === 0) return false;
    const d = arr.shift();
    d.Status = 'Donation-In-Progress';
    d.DonationStartAt = now();
    avail--; moved++;
    return true;
  };
  for (let i=0; i<PRE_STRICT && avail>0; i++) takeFrom(preQ);
  for (let i=0; i<WALK_STRICT && avail>0; i++) takeFrom(walkQ);

  await save();
  res.json({ moved });
});

// Bed -> Recovery
app.post('/api/action/to-recovery', async (req, res) => {
  const d = db.data.donors.find(x => x.id === req.body.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.Status !== 'Donation-In-Progress') return res.status(409).json({ error: 'Donor not in bed' });
  d.Status = 'Recovery';
  d.RecoveryStartAt = now();
  await save();
  res.json(d);
});

// Recovery -> Recovered
app.post('/api/action/recovered', async (req, res) => {
  const d = db.data.donors.find(x => x.id === req.body.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.Status !== 'Recovery') return res.status(409).json({ error: 'Donor not in Recovery' });
  d.Status = 'Recovered';
  d.RecoveryEndAt = now();
  await save();
  res.json(d);
});

// Recovered/Recovery -> Completed & Left
app.post('/api/action/complete', async (req, res) => {
  const d = db.data.donors.find(x => x.id === req.body.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.Status !== 'Recovered' && d.Status !== 'Recovery') {
    return res.status(409).json({ error: 'Donor not ready to complete' });
  }
  d.Status = 'Completed & Left';
  d.RiceBagGiven = true;
  d.PhotoGiven = true;
  d.PhotoPrinted = true;
  d.CompletedAt = now();
  await save();
  res.json(d);
});

// Raw state for polling
app.get('/api/state', (_req, res) => {
  res.json({ donors: db.data.donors, meta: db.data.meta });
});

// CSV export
app.get('/api/export.csv', (_req, res) => {
  const cols = [
    'DonorID','FullName','Phone','PreRegistered','HasPhoto',
    'Status','ScreeningStatus','QueueBatch','BedType','BedNumber',
    'PhotoPrinted','RiceBagGiven','PhotoGiven',
    'RegisteredAt','ScreeningStartAt','ApprovedAt','DonationStartAt',
    'RecoveryStartAt','RecoveryEndAt','CompletedAt','RejectedAt','RejectionReason'
  ];
  const csv = [cols.join(',')].concat(
    db.data.donors.map(d => cols.map(c => JSON.stringify(d[c] ?? '')).join(','))
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="donors.csv"');
  res.send(csv);
});

// Reset all data
app.post('/api/reset', async (_req, res) => {
  db.data = { donors: [], meta: { nextDonorNo: 1, lastBatch: 0, batches: [] } };
  await save();
  res.json({ ok: true });
});

const port = process.env.PORT || 4000;
const host = process.env.HOST || '0.0.0.0';
httpServer.listen(port, host, () => console.log(`BloodDrive -> http://localhost:${port}`));
