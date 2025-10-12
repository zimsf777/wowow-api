import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({limit:'10mb'}));

app.use(cors({ origin: (o,cb)=>cb(null,true) })); // allow all for MVP

const upload = multer({ dest: path.join(__dirname, '..', 'tmp') });

function baseUrl(req){
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try{
    if (!req.file) throw new Error('no file');
    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
    const safeName = Date.now()+'-'+crypto.randomBytes(3).toString('hex')+'.'+ext;
    const dir = path.join(__dirname, '..', 'public', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(req.file.path, path.join(dir, safeName));
    const fileUrl = baseUrl(req) + '/uploads/' + safeName;
    res.json({ fileUrl });
  }catch(e){ res.status(500).json({ error: 'upload failed' }); }
});

app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads')));

const RUNWAY_BASE = process.env.RUNWAY_API_URL || 'https://api.dev.runwayml.com';
const RUNWAY_KEY = process.env.RUNWAY_API_KEY || '';

app.post('/api/jobs', async (req, res) => {
  try{
    const { inputUrl } = req.body || {};
    if(!inputUrl) return res.status(400).json({ error: 'inputUrl required' });
    if(!RUNWAY_KEY) return res.status(500).json({ error: 'RUNWAY_API_KEY not set' });

    const createResp = await fetch(`${RUNWAY_BASE}/v1/image_to_video`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RUNWAY_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model:'gen4_turbo', duration:5, ratio:'1280:720', promptImage: inputUrl })
    });
    const text = await createResp.text();
    if(!createResp.ok) return res.status(502).json({ error: 'Runway create failed', detail: text });
    const created = JSON.parse(text);
    const jobId = created.id || created.task_id || created.taskId;
    if(!jobId) return res.status(502).json({ error: 'Runway: no job id', detail: created });
    res.json({ jobId });
  }catch(e){ res.status(500).json({ error: 'create job failed' }); }
});

async function getRunwayStatus(id){
  const r = await fetch(`${RUNWAY_BASE}/v1/tasks/${id}`, { headers:{'Authorization': `Bearer ${RUNWAY_KEY}`} });
  const t = await r.text();
  if(!r.ok) throw new Error(t);
  const d = JSON.parse(t);
  return { status: d.status, progressText: d.progress || d.message || null, outputUrl: d.output?.url || d.output_url || null };
}

app.get('/api/jobs/:id', async (req, res) => {
  try{ res.json(await getRunwayStatus(req.params.id)); }
  catch(e){ res.status(500).json({ error: 'status failed' }); }
});

app.get('/api/jobs/:id/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const id = req.params.id;
  let closed = false;
  req.on('close', ()=> closed = true);
  res.write(`data: ${JSON.stringify({ status: 'running', progressText: 'Ожидание статуса…' })}

`);
  while(!closed){
    try{ res.write(`data: ${JSON.stringify(await getRunwayStatus(id))}

`); }catch(e){}
    await new Promise(r=>setTimeout(r, 2500));
  }
  res.end();
});

app.get('/healthz', (req,res)=> res.json({ ok:true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log('API on :' + PORT));
