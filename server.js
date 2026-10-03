const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const app = express();
const port = Number(process.env.PORT || 10000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30000
});

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '200kb' }));
app.use(session({
  store: new PgSession({ pool, tableName: 'web_sessions', createTableIfMissing: true }),
  name: 'robo.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: 'auto', sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 }
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 2, fields: 8 },
  fileFilter: (_req, file, cb) => {
    const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    const fileTypes = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream', 'model/gltf-binary', 'application/x-rbxm', 'application/x-rbxl'];
    cb(null, ['image','logo'].includes(file.fieldname) ? imageTypes.includes(file.mimetype) : fileTypes.includes(file.mimetype));
  }
});

async function init() {
  if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET || !process.env.BOOTSTRAP_ADMIN_PASSWORD) throw new Error('Missing required server configuration');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY, username VARCHAR(24) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role VARCHAR(16) NOT NULL CHECK (role IN ('main','security','uploader')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS resources (
      id UUID PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Tools',
      author TEXT NOT NULL, image_data BYTEA, image_type TEXT, file_data BYTEA, file_name TEXT, file_type TEXT,
      downloads BIGINT NOT NULL DEFAULT 0, status VARCHAR(16) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS activity_logs (
      id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL DEFAULT 'info', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_settings(key,value) VALUES ('visitors','0') ON CONFLICT (key) DO NOTHING;
    INSERT INTO app_settings(key,value) VALUES
      ('site_name','Robo Uncopylocked'),('accent_color','#b071ed'),('site_theme','violet'),
      ('logo_data',''),('logo_hash',''),('pause_until',''),('pause_message','Kurze technische Pause'),('pause_seconds','3')
      ON CONFLICT (key) DO NOTHING;
  `);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM app_users');
  const name = process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin';
  if (rows[0].n === 0) {
    const hash = await bcrypt.hash(process.env.BOOTSTRAP_ADMIN_PASSWORD, 12);
    await pool.query('INSERT INTO app_users(username,password_hash,role) VALUES ($1,$2,$3)', [name, hash, 'main']);
    await logEvent(name, 'Main Admin angelegt', 'Erster sicherer Serverstart');
  } else if (process.env.RESET_MAIN_PASSWORD_ONCE === '1') {
    const hash = await bcrypt.hash(process.env.BOOTSTRAP_ADMIN_PASSWORD, 12);
    const updated = await pool.query("UPDATE app_users SET password_hash=$1 WHERE lower(username)=lower($2) AND role='main'", [hash, name]);
    if (!updated.rowCount) throw new Error('Main Admin could not be rotated');
    await logEvent(name, 'Main-Admin-Passwort erneuert', 'Einmalige sichere Zugangsdatenrotation');
  }
}

async function logEvent(username, action, detail = '', level = 'info') {
  await pool.query('INSERT INTO activity_logs(username,action,detail,level) VALUES ($1,$2,$3,$4)', [String(username).slice(0,80), String(action).slice(0,120), String(detail).slice(0,500), level]);
}
async function removeExpiredLogs() {
  await pool.query("DELETE FROM activity_logs WHERE created_at < now() - interval '10 minutes'");
}
function currentUser(req) { return req.session.user || null; }
function berlinDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function heroImageKeys(slot) { return { data: `hero_${slot}_image_data`, hash: `hero_${slot}_image_hash` }; }
function requireAuth(req, res, next) { if (!currentUser(req)) return res.status(401).json({ error: 'Bitte zuerst anmelden.' }); next(); }
function requireRole(...roles) { return (req,res,next) => !currentUser(req) ? res.status(401).json({error:'Bitte zuerst anmelden.'}) : !roles.includes(currentUser(req).role) ? res.status(403).json({error:'Keine Berechtigung.'}) : next(); }
function requireCsrf(req,res,next) { if (!req.session.csrf || req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({error:'Sitzung abgelaufen. Bitte Seite neu laden.'}); next(); }
function publicUser(row) { return { username: row.username, role: row.role, createdAt: row.created_at }; }
function safeResource(row) { return { id: row.id, title: row.title, description: row.description, category: row.category, author: row.author, downloads: Number(row.downloads), status: row.status, createdAt: row.created_at, hasImage: Boolean(row.image_data), hasFile: Boolean(row.file_data) }; }

app.get('/api/auth', (req,res) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.json({ user: currentUser(req), csrf: req.session.csrf });
});
app.post('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }), requireCsrf, async (req,res,next) => {
  try {
    const username = String(req.body.username || '').trim();
    const { rows } = await pool.query('SELECT * FROM app_users WHERE lower(username)=lower($1)', [username]);
    const row = rows[0];
    if (!row || !(await bcrypt.compare(String(req.body.password || ''), row.password_hash))) {
      await logEvent(username || 'unbekannt', 'Anmeldung fehlgeschlagen', 'Ungültige Zugangsdaten', 'warning');
      return res.status(401).json({ error: 'Benutzername oder Passwort stimmt nicht.' });
    }
    await new Promise((resolve,reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.user = { id: row.id, username: row.username, role: row.role };
    req.session.csrf = crypto.randomBytes(24).toString('hex');
    await logEvent(row.username, 'Anmeldung', 'Erfolgreicher Login');
    req.session.save(err => err ? next(err) : res.json({ user: req.session.user, csrf: req.session.csrf }));
  } catch (err) { next(err); }
});
app.post('/api/logout', requireAuth, requireCsrf, async (req,res,next) => {
  try { const u=currentUser(req); await logEvent(u.username,'Abmeldung'); req.session.destroy(err => err ? next(err) : res.clearCookie('robo.sid').json({ok:true})); }
  catch(err) { next(err); }
});

app.post('/api/visit', async (req,res,next) => {
  try {
    if (!req.session.countedVisit) {
      await pool.query("UPDATE app_settings SET value=(value::bigint+1)::text WHERE key='visitors'");
      req.session.countedVisit = true;
    }
    const {rows}=await pool.query("SELECT value FROM app_settings WHERE key='visitors'");
    res.json({visitors:Number(rows[0]?.value||0)});
  } catch(err) { next(err); }
});
app.get('/api/site-settings', async (_req,res,next) => {
  try {
    const {rows}=await pool.query("SELECT key,value FROM app_settings WHERE key IN ('site_name','accent_color','site_theme','logo_hash','pause_until','pause_message','pause_seconds','daily_timer_date','hero_featured_image_hash','hero_studio_image_hash')");
    const settings=Object.fromEntries(rows.map(r=>[r.key,r.value]));
    const until=Date.parse(settings.pause_until||'');
    let logoHash=settings.logo_hash||'';
    if(!logoHash) {
      const legacy=await pool.query("SELECT value FROM app_settings WHERE key='logo_data'");
      if(legacy.rows[0]?.value) {
        logoHash=crypto.createHash('sha256').update(legacy.rows[0].value).digest('hex').slice(0,16);
        await pool.query("INSERT INTO app_settings(key,value) VALUES('logo_hash',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[logoHash]);
      }
    }
    res.json({siteName:settings.site_name||'Robo Uncopylocked',accentColor:settings.accent_color||'#b071ed',theme:settings.site_theme==='black'?'black':'violet',logoHash,heroFeaturedImageHash:settings.hero_featured_image_hash||'',heroStudioImageHash:settings.hero_studio_image_hash||'',pauseActive:Number.isFinite(until)&&until>Date.now(),pauseUntil:Number.isFinite(until)&&until>Date.now()?until:null,pauseMessage:settings.pause_message||'Kurze technische Pause',pauseSeconds:Number(settings.pause_seconds)||3,dailyTimerUsed:settings.daily_timer_date===berlinDate()});
  } catch(err) { next(err); }
});
app.get('/api/site-logo', async (_req,res,next) => {
  try {
    const {rows}=await pool.query("SELECT value FROM app_settings WHERE key='logo_data'");
    const match=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(rows[0]?.value||'');
    if(!match) return res.redirect('/robo-logo.png');
    const hash=crypto.createHash('sha256').update(rows[0].value).digest('hex').slice(0,16);
    res.set('Cache-Control','public,max-age=3600').set('ETag',`"${hash}"`).type(match[1]).send(Buffer.from(match[2],'base64'));
  } catch(err) { next(err); }
});
app.get('/api/site-image/:slot', async (req,res,next) => {
  try {
    const slot=String(req.params.slot||'');
    if(!['featured','studio'].includes(slot)) return res.sendStatus(404);
    const keys=heroImageKeys(slot);
    const {rows}=await pool.query('SELECT value FROM app_settings WHERE key=$1',[keys.data]);
    const match=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(rows[0]?.value||'');
    if(!match) return res.sendStatus(404);
    const hash=crypto.createHash('sha256').update(rows[0].value).digest('hex').slice(0,16);
    res.set('Cache-Control','public,max-age=3600').set('ETag',`"${hash}"`).type(match[1]).send(Buffer.from(match[2],'base64'));
  } catch(err) { next(err); }
});
app.get('/api/resources', async (_req,res,next) => {
  try { const {rows}=await pool.query("SELECT * FROM resources WHERE status='published' ORDER BY created_at DESC"); res.json(rows.map(safeResource)); }
  catch(err) { next(err); }
});
app.get('/api/resources/:id/image', async (req,res,next) => {
  try { const {rows}=await pool.query('SELECT image_data,image_type FROM resources WHERE id=$1',[req.params.id]); if(!rows[0]?.image_data) return res.sendStatus(404); res.type(rows[0].image_type).set('Cache-Control','public,max-age=3600').send(rows[0].image_data); }
  catch(err) { next(err); }
});
app.get('/api/resources/:id/download', async (req,res,next) => {
  try {
    const {rows}=await pool.query("UPDATE resources SET downloads=downloads+1 WHERE id=$1 AND status='published' AND file_data IS NOT NULL RETURNING file_data,file_type,file_name,title,author",[req.params.id]);
    if(!rows[0]?.file_data) return res.status(404).send('Datei nicht gefunden.');
    await logEvent(currentUser(req)?.username || 'Besucher','Download',rows[0].title);
    const filename=String(rows[0].file_name||`${rows[0].title}.zip`).replace(/[^A-Za-z0-9_. -]/g,'_').slice(0,120);
    res.set('Content-Type',rows[0].file_type||'application/octet-stream').set('Content-Disposition',`attachment; filename="${filename}"`).send(rows[0].file_data);
  } catch(err) { next(err); }
});
app.post('/api/resources', requireAuth, requireCsrf, upload.fields([{name:'image',maxCount:1},{name:'downloadFile',maxCount:1}]), async (req,res,next) => {
  try {
    const title=String(req.body.title||'').trim().slice(0,100), description=String(req.body.description||'').trim().slice(0,2000), category=String(req.body.category||'Tools').trim().slice(0,40);
    if(title.length<3) return res.status(400).json({error:'Der Titel muss mindestens 3 Zeichen haben.'});
    const img=req.files?.image?.[0], file=req.files?.downloadFile?.[0], u=currentUser(req), status=u.role==='uploader'?'pending':'published';
    const id=crypto.randomUUID();
    await pool.query(`INSERT INTO resources(id,title,description,category,author,image_data,image_type,file_data,file_name,file_type,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,title,description,category,u.username,img?.buffer||null,img?.mimetype||null,file?.buffer||null,file?.originalname||null,file?.mimetype||null,status]);
    await logEvent(u.username,status==='pending'?'Upload zur Prüfung eingereicht':'Ressource veröffentlicht',title);
    res.status(201).json({id,status});
  } catch(err) { next(err); }
});

app.get('/api/admin/overview', requireRole('main','security'), async (_req,res,next) => {
  try {
    const [counts,visitor,latest]=await Promise.all([
      pool.query("SELECT (SELECT count(*) FROM resources)::int AS resources,(SELECT count(*) FROM resources WHERE status='pending')::int AS pending,(SELECT count(*) FROM app_users)::int AS users"),
      pool.query("SELECT value FROM app_settings WHERE key='visitors'"),
      pool.query('SELECT id,username,action,detail,level,created_at FROM activity_logs ORDER BY id DESC LIMIT 8')
    ]);
    res.json({stats:counts.rows[0],visitors:Number(visitor.rows[0]?.value||0),activity:latest.rows});
  } catch(err) { next(err); }
});
app.get('/api/admin/users', requireRole('main'), async (_req,res,next) => { try { const {rows}=await pool.query('SELECT username,role,created_at FROM app_users ORDER BY created_at'); res.json(rows.map(publicUser)); } catch(err){next(err);} });
app.post('/api/admin/users', requireRole('main'), requireCsrf, async (req,res,next) => {
  try {
    const username=String(req.body.username||'').trim(), password=String(req.body.password||''), role=String(req.body.role||'uploader');
    if(!/^[A-Za-z0-9_-]{3,24}$/.test(username)) return res.status(400).json({error:'Name: 3–24 Zeichen, Buchstaben, Zahlen, _ oder -.'});
    if(password.length<12) return res.status(400).json({error:'Das Passwort muss mindestens 12 Zeichen haben.'});
    if(!['main','security','uploader'].includes(role)) return res.status(400).json({error:'Diese Rolle kann hier nicht vergeben werden.'});
    const hash=await bcrypt.hash(password,12); const {rows}=await pool.query('INSERT INTO app_users(username,password_hash,role) VALUES($1,$2,$3) RETURNING username,role,created_at',[username,hash,role]);
    await logEvent(currentUser(req).username,'Konto erstellt',`${username} · ${role}`); res.status(201).json(publicUser(rows[0]));
  } catch(err) { if(err.code==='23505') return res.status(409).json({error:'Dieser Nutzername ist schon vergeben.'}); next(err); }
});
app.delete('/api/admin/users/:username', requireRole('main'), requireCsrf, async (req,res,next) => {
  const name=String(req.params.username||'');
  if(name.toLowerCase()===String(currentUser(req).username).toLowerCase()) return res.status(400).json({error:'Das eigene Konto kann nicht gelöscht werden.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const found=await client.query('SELECT id,username,role FROM app_users WHERE lower(username)=lower($1) FOR UPDATE',[name]);
    if(!found.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({error:'Konto nicht gefunden.'}); }
    const account=found.rows[0];
    if(account.role==='main') {
      await client.query('SELECT pg_advisory_xact_lock(714255,1)');
      const {rows}=await client.query("SELECT count(*)::int AS n FROM app_users WHERE role='main'");
      if(rows[0].n<=1) { await client.query('ROLLBACK'); return res.status(400).json({error:'Das letzte Main-Admin-Konto muss bestehen bleiben.'}); }
    }
    await client.query("DELETE FROM web_sessions WHERE sess->'user'->>'id'=$1 OR lower(sess->'user'->>'username')=lower($2)",[String(account.id),account.username]);
    await client.query('DELETE FROM app_users WHERE id=$1',[account.id]);
    await client.query('COMMIT');
    await logEvent(currentUser(req).username,'Konto gelöscht',`${account.username} · alle Sitzungen beendet`,'warning');
    res.json({ok:true,sessionsEnded:true});
  } catch(err) { try{await client.query('ROLLBACK');}catch{} next(err); }
  finally { client.release(); }
});
app.get('/api/admin/logs', requireRole('main','security'), async (_req,res,next) => { try { await removeExpiredLogs(); const {rows}=await pool.query('SELECT id,username,action,detail,level,created_at FROM activity_logs ORDER BY id DESC LIMIT 200'); res.json(rows); } catch(err){next(err);} });
app.delete('/api/admin/logs/:id', requireRole('main'), requireCsrf, async (req,res,next) => {
  try {
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1) return res.status(400).json({error:'Ungültiger Logeintrag.'});
    const {rowCount}=await pool.query('DELETE FROM activity_logs WHERE id=$1',[id]);
    if(!rowCount) return res.status(404).json({error:'Logeintrag nicht gefunden.'});
    res.json({ok:true});
  } catch(err){next(err);}
});
app.get('/api/admin/resources', requireRole('main','security'), async (_req,res,next) => { try { const {rows}=await pool.query('SELECT * FROM resources ORDER BY created_at DESC LIMIT 200'); res.json(rows.map(safeResource)); } catch(err){next(err);} });
app.patch('/api/admin/resources/:id', requireRole('main','security'), requireCsrf, async (req,res,next) => {
  try { const status=String(req.body.status||''); if(!['published','pending','rejected'].includes(status)) return res.status(400).json({error:'Ungültiger Status.'}); const {rows}=await pool.query('UPDATE resources SET status=$1 WHERE id=$2 RETURNING title',[status,req.params.id]); if(!rows[0]) return res.status(404).json({error:'Ressource nicht gefunden.'}); await logEvent(currentUser(req).username,'Ressourcenstatus geändert',`${rows[0].title} · ${status}`); res.json({ok:true}); }
  catch(err){next(err);}
});
app.put('/api/admin/resources/:id/downloads', requireRole('main'), requireCsrf, async (req,res,next) => {
  try {
    const downloads=Number(req.body.downloads);
    if(!Number.isSafeInteger(downloads)||downloads<0||downloads>2147483647) return res.status(400).json({error:'Bitte eine Zahl zwischen 0 und 2.147.483.647 eingeben.'});
    const {rows}=await pool.query('UPDATE resources SET downloads=$1 WHERE id=$2 RETURNING title,downloads',[downloads,req.params.id]);
    if(!rows[0]) return res.status(404).json({error:'Ressource nicht gefunden.'});
    await logEvent(currentUser(req).username,'Downloadzahl angepasst',`${rows[0].title} · ${downloads}`);
    res.json({ok:true,downloads:Number(rows[0].downloads)});
  } catch(err){next(err);}
});
app.delete('/api/admin/resources/:id', requireRole('main'), requireCsrf, async (req,res,next) => {
  try { const {rows}=await pool.query('DELETE FROM resources WHERE id=$1 RETURNING title',[req.params.id]); if(!rows[0]) return res.status(404).json({error:'Ressource nicht gefunden.'}); await logEvent(currentUser(req).username,'Ressource gelöscht',rows[0].title,'warning'); res.json({ok:true}); }
  catch(err){next(err);}
});
app.post('/api/admin/visitors', requireRole('main'), requireCsrf, async (req,res,next) => {
  try { const n=Number(req.body.value); if(!Number.isSafeInteger(n)||n<0||n>2147483647) return res.status(400).json({error:'Bitte eine Besucherzahl zwischen 0 und 2.147.483.647 eingeben.'}); await pool.query("UPDATE app_settings SET value=$1 WHERE key='visitors'",[String(n)]); await logEvent(currentUser(req).username,'Besucherzahl angepasst',String(n)); res.json({visitors:n}); }
  catch(err){next(err);}
});
app.get('/api/admin/settings', requireRole('main'), async (_req,res,next) => {
  try {
    const {rows}=await pool.query("SELECT key,value FROM app_settings WHERE key IN ('site_name','accent_color','site_theme','logo_data','hero_featured_image_data','hero_studio_image_data','hero_featured_image_hash','hero_studio_image_hash','pause_until','pause_message','pause_seconds','daily_timer_date')");
    const s=Object.fromEntries(rows.map(r=>[r.key,r.value]));
    const until=Date.parse(s.pause_until||'');
    res.json({siteName:s.site_name||'Robo Uncopylocked',accentColor:s.accent_color||'#b071ed',theme:s.site_theme==='black'?'black':'violet',hasLogo:Boolean(s.logo_data),logoData:s.logo_data||'',heroFeaturedImageData:s.hero_featured_image_data||'',heroFeaturedImageHash:s.hero_featured_image_hash||'',heroStudioImageData:s.hero_studio_image_data||'',heroStudioImageHash:s.hero_studio_image_hash||'',pauseActive:Number.isFinite(until)&&until>Date.now(),pauseSeconds:Number(s.pause_seconds)||3,pauseMessage:s.pause_message||'Kurze technische Pause',dailyTimerUsed:s.daily_timer_date===berlinDate()});
  } catch(err) { next(err); }
});
app.post('/api/admin/daily-timer', requireRole('main'), requireCsrf, async (req,res,next) => {
  const client=await pool.connect();
  try {
    const today=berlinDate();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(714255,2)');
    const {rows}=await client.query("SELECT key,value FROM app_settings WHERE key IN ('daily_timer_date','pause_until')");
    const settings=Object.fromEntries(rows.map(row=>[row.key,row.value]));
    if(settings.daily_timer_date===today) { await client.query('ROLLBACK'); return res.status(409).json({error:'Der Ein-Minuten-Timer wurde heute bereits verwendet.'}); }
    const currentPause=Date.parse(settings.pause_until||'');
    if(Number.isFinite(currentPause)&&currentPause>Date.now()) { await client.query('ROLLBACK'); return res.status(409).json({error:'Eine Pause läuft bereits. Bitte warte, bis sie beendet ist.'}); }
    const until=new Date(Date.now()+60_000).toISOString();
    const values={daily_timer_date:today,pause_until:until,pause_message:'Ein-Minuten-Timer',pause_seconds:'60'};
    for(const [key,value] of Object.entries(values)) await client.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[key,value]);
    await client.query('COMMIT');
    await logEvent(currentUser(req).username,'Ein-Minuten-Timer gestartet',today);
    res.json({ok:true,pauseUntil:Date.parse(until),dailyTimerUsed:true});
  } catch(err) { try{await client.query('ROLLBACK');}catch{} next(err); }
  finally { client.release(); }
});
app.put('/api/admin/settings', requireRole('main'), requireCsrf, async (req,res,next) => {
  try {
    const siteName=String(req.body.siteName||'').trim().slice(0,48);
    const accentColor=String(req.body.accentColor||'').trim();
    const theme=String(req.body.theme||'violet');
    const pauseMessage=String(req.body.pauseMessage||'Kurze technische Pause').trim().slice(0,120);
    const pauseSeconds=Number(req.body.pauseSeconds);
    const pauseActive=req.body.pauseActive===true;
    if(!siteName) return res.status(400).json({error:'Bitte einen Webseitennamen eingeben.'});
    if(!/^#[0-9a-fA-F]{6}$/.test(accentColor)) return res.status(400).json({error:'Bitte eine gültige Akzentfarbe wählen.'});
    if(!['violet','black'].includes(theme)) return res.status(400).json({error:'Ungültiges Farbdesign.'});
    if(!Number.isInteger(pauseSeconds)||pauseSeconds<3||pauseSeconds>300) return res.status(400).json({error:'Die Pause muss zwischen 3 und 300 Sekunden dauern.'});
    const until=pauseActive?new Date(Date.now()+pauseSeconds*1000).toISOString():'';
    const values={site_name:siteName,accent_color:accentColor,site_theme:theme,pause_until:until,pause_message:pauseMessage||'Kurze technische Pause',pause_seconds:String(pauseSeconds)};
    await Promise.all(Object.entries(values).map(([key,value])=>pool.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[key,value])));
    await logEvent(currentUser(req).username,'Webseite angepasst',`${siteName} · ${theme} · Pause ${pauseActive?'gestartet':'aus'}`);
    res.json({ok:true,pauseUntil:pauseActive?Date.parse(until):null});
  } catch(err) { next(err); }
});
app.post('/api/admin/settings/logo', requireRole('main'), requireCsrf, upload.single('logo'), async (req,res,next) => {
  try {
    if(!req.file) return res.status(400).json({error:'Bitte ein Bild auswählen.'});
    if(req.file.size>2*1024*1024) return res.status(400).json({error:'Das Logo darf höchstens 2 MB groß sein.'});
    const logoData=`data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const logoHash=crypto.createHash('sha256').update(logoData).digest('hex').slice(0,16);
    await pool.query("INSERT INTO app_settings(key,value) VALUES('logo_data',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[logoData]);
    await pool.query("INSERT INTO app_settings(key,value) VALUES('logo_hash',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[logoHash]);
    await logEvent(currentUser(req).username,'Webseitenlogo geändert',req.file.originalname.slice(0,120));
    res.json({ok:true});
  } catch(err) { next(err); }
});
app.post('/api/admin/settings/hero-image/:slot', requireRole('main'), requireCsrf, upload.single('image'), async (req,res,next) => {
  try {
    const slot=String(req.params.slot||'');
    if(!['featured','studio'].includes(slot)) return res.status(404).json({error:'Bildbereich nicht gefunden.'});
    if(!req.file) return res.status(400).json({error:'Bitte ein Bild auswählen.'});
    if(req.file.size>5*1024*1024) return res.status(400).json({error:'Das Bild darf höchstens 5 MB groß sein.'});
    const keys=heroImageKeys(slot);
    const imageData=`data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const imageHash=crypto.createHash('sha256').update(imageData).digest('hex').slice(0,16);
    await Promise.all([[keys.data,imageData],[keys.hash,imageHash]].map(([key,value])=>pool.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[key,value])));
    await logEvent(currentUser(req).username,'Website-Bild geändert',`${slot} · ${req.file.originalname.slice(0,120)}`);
    res.json({ok:true,imageHash});
  } catch(err) { next(err); }
});
app.delete('/api/admin/settings/hero-image/:slot', requireRole('main'), requireCsrf, async (req,res,next) => {
  try {
    const slot=String(req.params.slot||'');
    if(!['featured','studio'].includes(slot)) return res.status(404).json({error:'Bildbereich nicht gefunden.'});
    const keys=heroImageKeys(slot);
    await pool.query('DELETE FROM app_settings WHERE key=ANY($1::text[])',[[keys.data,keys.hash]]);
    await logEvent(currentUser(req).username,'Website-Bild zurückgesetzt',slot);
    res.json({ok:true});
  } catch(err) { next(err); }
});

app.use(express.static(__dirname,{index:'index.html',maxAge:0}));
app.use('/api',(_req,res)=>res.status(404).json({error:'API-Endpunkt nicht gefunden.'}));
app.use((err,_req,res,_next)=>{
  console.error(err.message);
  if(err instanceof multer.MulterError) return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'Dateien dürfen höchstens 20 MB groß sein.':'Upload konnte nicht verarbeitet werden.'});
  res.status(500).json({error:'Serverfehler. Bitte später erneut versuchen.'});
});

init().then(()=>{
  const logCleanup=setInterval(()=>removeExpiredLogs().catch(err=>console.error('Log-Bereinigung fehlgeschlagen:',err.message)),15_000);
  logCleanup.unref();
  return app.listen(port,'0.0.0.0',()=>console.log(`Robo Uncopylocked läuft auf Port ${port}`));
}).catch(err=>{console.error('Serverstart fehlgeschlagen:',err.message);process.exit(1)});
