import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import fetch, { Headers } from 'node-fetch';   // <— берём Headers явно
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: true }));

// dirs
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: path.join(__dirname, '..', 'tmp') });

function absoluteBase(req){
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}

// health + root
app.get('/healthz', (req,res)=> res.json({ ok: true }));
app.get('/', (req,res)=> res.type('text/plain').send('OK'));

// upload proxy (MVP)
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try{
    if (!req.file) throw new Error('no file');
    const ext = (req.file.originalname?.split('.').pop() || 'jpg').toLowerCase();
    const safeName = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    fs.renameSync(req.file.path, path.join(UPLOAD_DIR, safeName));
    const fileUrl = absoluteBase(req) + '/uploads/' + safeName;
    res.json({ fileUrl });
  }catch(e){
    console.error('UPLOAD ERROR:', e);
    res.status(500).json({ error: 'upload failed' });
  }
});

// Runway config
const RUNWAY_BASE = process.env.RUNWAY_API_URL || 'https://api.dev.runwayml.com';
const RUNWAY_KEY  = process.env.RUNWAY_API_KEY || '';
const RUNWAY_VER  = process.env.RUNWAY_API_VERSION || '2024-10-01'; // 👈 задаём версию
console.log('Using Runway API version:', RUNWAY_VER);

function runwayHeaders() {
  const h = new Headers();
  h.set('Authorization', `Bearer ${RUNWAY_KEY}`);
  h.set('Content-Type', 'application/json');
  h.set('Accept', 'application/json');
  h.set('X-Runway-Version', RUNWAY_VER);       // 👈 критичный заголовок
  return h;
}

// Create job (Image to video)
app.post('/api/jobs', async (req, res) => {
  try{
    const { inputUrl } = req.body || {};
    if(!inputUrl) return res.status(400).json({ error: 'inputUrl required' });
    if(!RUNWAY_KEY) return res.status(500).json({ error: 'RUNWAY_API_KEY not set' });

    const r = await fetch(`${RUNWAY_BASE}/v1/image_to_video`, {
      method: 'POST',
      headers: runwayHeaders(),
      body: JSON.stringify({
        model: 'gen4_turbo',
        duration: 5,
        ratio: '1280:720',
        promptImage: inputUrl
      })
    });

    const txt = await r.text();
    if(!r.ok){
      console.error('Runway create failed:', txt);
      return res.status(502).json({ error: 'Runway create failed', detail: txt });
    }
    const created = JSON.parse(txt);
    const jobId = created.id || created.task_id || created.taskId;
    if(!jobId){
      console.error('Runway: no job id in response:', created);
      return res.status(502).json({ error: 'Runway: no job id', detail: created });
    }
    res.json({ jobId });
  }catch(e){
    console.error('CREATE JOB ERROR:', e);
    res.status(500).json({ error: 'create job failed' });
  }
});

// Status helpers (тоже с версионным заголовком)
async function runwayStatus(id){
  const r = await fetch(`${RUNWAY_BASE}/v1/tasks/${id}`, {
    headers: runwayHeaders()
  });
  const txt = await r.text();
  if(!r.ok) throw new Error(txt);
  const d = JSON.parse(txt);
  return {
    status: d.status,
    progressText: d.progress || d.message || null,
    outputUrl: d.output?.url || d.output_url || null
  };
}

app.get('/api/jobs/:id', async (req,res)=>{
  try { res.json(await runwayStatus(req.params.id)); }
  catch(e){ console.error('STATUS ERROR:', e); res.status(500).json({ error: 'status failed' }); }
});

// SSE (внутри — polling статуса)
app.get('/api/jobs/:id/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const id = req.params.id;
  let closed = false;
  req.on('close', ()=> { closed = true; });

  res.write(`data: ${JSON.stringify({ status: 'running', progressText: 'Ожидание статуса…' })}\n\n`);

  while(!closed){
    try{
      const st = await runwayStatus(id);
      res.write(`data: ${JSON.stringify(st)}\n\n`);
      if(st.status === 'succeeded' || st.status === 'failed') break;
    }catch(e){}
    await new Promise(r=>setTimeout(r, 2500));
  }
  res.end();
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log('API listening on :' + PORT));
