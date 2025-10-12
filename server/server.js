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
app.use(cors({ origin: true }));

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: path.join(__dirname, '..', 'tmp') });

function absoluteBase(req){
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}

app.get('/healthz', (req,res)=> res.json({ ok: true }));
app.get('/', (req,res)=> res.type('text/plain').send('OK'));

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try{
    if (!req.file) throw new Error('no file');
    const ext = (req.file.originalname?.split('.').pop() || 'jpg').toLowerCase();
    const safeName = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    const target = path.join(UPLOAD_DIR, safeName);
    fs.renameSync(req.file.path, target);
    const fileUrl = absoluteBase(req) + '/uploads/' + safeName;
    res.json({ fileUrl });
  }catch(e){
    console.error('UPLOAD ERROR:', e);
    res.status(500).json({ error: 'upload failed' });
  }
});

app.use('/uploads', express.static(UPLOAD_DIR));

const RUNWAY_BASE = process.env.RUNWAY_API_URL || 'https://api.dev.runwayml.com';
const RUNWAY_KEY = process.env.RUNWAY_API_KEY || '';

app.post('/api/jobs', async (req, res) => {
  try{
    const { inputUrl } = req.body || {};
    if(!inputUrl) return res.status(400).json({ error: 'inputUrl required' });
    if(!RUNWAY_KEY) return res.status(500).json({ error: 'RUNWAY_API_KEY not set' });

    const r = await fetch(`${RUNWAY_BASE}/v1/image_to_video`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RUNWAY_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model:'gen4_turbo', duration:5, ratio:'1280:720', promptImage: inputUrl })
    });
    const txt = await r.text();
    if(!r.ok){ console.error('Runway create failed:', txt); return res.status(502).json({ error: 'Runway create failed', detail: txt }); }
    const created = JSON.parse(txt);
    const jobId = created.id || created.task_id || created.taskId;
    if(!jobId){ console.error('Runway missing job id:', created); return res.status(502).json({ error: 'Runway: no job id', detail: created }); }
    res.json({ jobId });
  }catch(e){
    console.error('CREATE JOB ERROR:', e);
    res.status(500).json({ error: 'create job failed' });
  }
});

async function runwayStatus(id){
  const r = await fetch(`${RUNWAY_BASE}/v1/tasks/${id}`, { headers: { 'Authorization': `Bearer ${RUNWAY_KEY}` } });
  const txt = await r.text();
  if(!r.ok) throw new Error(txt);
  const d = JSON.parse(txt);
  return { status: d.status, progressText: d.progress || d.message || null, outputUrl: d.output?.url || d.output_url || null };
}

app.get('/api/jobs/:id', async (req,res)=>{
  try{ res.json(await runwayStatus(req.params.id)); }
  catch(e){ console.error('STATUS ERROR:', e); res.status(500).json({ error: 'status failed' }); }
});

app.get('/api/jobs/:id/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const id = req.params.id;
  let closed = false;
  req.on('close', ()=> { closed = true; });
  res.write(`data: ${JSON.stringify({ status: 'running', progressText: 'Ожидание статуса…' })}

`);
  while(!closed){
    try{
      const st = await runwayStatus(id);
      res.write(`data: ${JSON.stringify(st)}

`);
      if(st.status === 'succeeded' || st.status === 'failed') break;
    }catch(e){}
    await new Promise(r=>setTimeout(r, 2500));
  }
  res.end();
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log('API listening on :' + PORT));
