(() => {
  const $ = (s) => document.querySelector(s);
  const modal = $('#adminModal'), body = $('#adminBody');
  let csrf = '', user = null, panelTab = 'overview';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const roleName = { main:'Main Admin', security:'Sicherheitsadmin', uploader:'Uploader' };
  async function api(url, options={}) {
    const headers = new Headers(options.headers || {});
    if (csrf && options.method && options.method !== 'GET') headers.set('x-csrf-token', csrf);
    if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type','application/json');
    const response = await fetch(url,{...options,headers,credentials:'same-origin'});
    let data={}; try { data=await response.json(); } catch {}
    if (!response.ok) throw new Error(data.error || 'Aktion fehlgeschlagen.');
    return data;
  }
  function toast(text) { const el=$('#toast'); el.textContent=text; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2600); }
  function openModal() { modal.classList.remove('hidden'); document.body.style.overflow='hidden'; if(user) renderPanel(); else renderLogin(); }
  function closeModal() { modal.classList.add('hidden'); document.body.style.overflow=''; }
  function renderLogin(message='') {
    body.innerHTML=`<form id="loginForm" class="admin-form"><label>Benutzername<input name="username" autocomplete="username" required maxlength="24" placeholder="Admin-Benutzername"></label><label>Passwort<input name="password" type="password" autocomplete="current-password" required placeholder="Dein Passwort"></label><div class="admin-message" id="adminMessage">${esc(message)}</div><button class="button button-primary">Sicher anmelden <span>↗</span></button><p class="form-note">Zugänge werden serverseitig geprüft. Zugangsdaten werden nicht in diesem Browser gespeichert.</p></form>`;
    $('#loginForm').onsubmit=async e=>{e.preventDefault();const form=new FormData(e.currentTarget);try{const r=await api('/api/login',{method:'POST',body:JSON.stringify({username:form.get('username'),password:form.get('password')})});user=r.user;csrf=r.csrf;renderPanel();toast('Angemeldet.');}catch(err){renderLogin(err.message);}};
  }
  function formUpload() {
    return `<section class="admin-section"><h3>Neue Ressource hochladen</h3><form id="uploadForm" class="admin-form" enctype="multipart/form-data"><label>Titel<input name="title" required minlength="3" maxlength="100" placeholder="Name des Projekts"></label><label>Beschreibung<textarea name="description" maxlength="2000" placeholder="Was ist enthalten? Credits und Nutzungshinweise nicht vergessen."></textarea></label><label>Kategorie<select name="category"><option>Maps</option><option>Modelle</option><option>UI Kits</option><option>Tools</option></select></label><label>Vorschaubild<input name="image" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label><label>Download-Datei<input name="downloadFile" type="file" accept=".zip,.rbxm,.rbxl,.rbxmx,.rbxlx,.glb,.gltf"></label><small class="form-note">Bilder und Dateien bis 20 MB. Uploader-Einsendungen müssen vor der Veröffentlichung geprüft werden.</small><div class="admin-message" id="uploadMessage"></div><button class="button button-primary">Hochladen</button></form></section>`;
  }
  async function renderPanel() {
    if(!user) return renderLogin();
    const main=user.role==='main', security=user.role==='security';
    const tabs=[['overview','Übersicht'],['upload','Upload']];
    if(main) tabs.push(['accounts','Konten']);
    if(main||security) tabs.push(['review','Prüfung'],['logs','Logs']);
    if(!tabs.some(t=>t[0]===panelTab)) panelTab='overview';
    body.innerHTML=`<div class="admin-panel"><div class="admin-welcome"><div><b>${esc(user.username)}</b><small>${esc(roleName[user.role]||user.role)} · sicher angemeldet</small></div><button class="button button-quiet small" id="logoutBtn">Abmelden</button></div><div class="admin-tabs">${tabs.map(([id,label])=>`<button class="admin-tab ${panelTab===id?'active':''}" data-tab="${id}">${label}</button>`).join('')}</div><div id="panelContent"><span class="form-note">Lade Panel…</span></div></div>`;
    $('#logoutBtn').onclick=async()=>{try{await api('/api/logout',{method:'POST',body:'{}'});}catch{}user=null;const auth=await api('/api/auth');csrf=auth.csrf;renderLogin();toast('Abgemeldet.');};
    document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{panelTab=b.dataset.tab;renderPanel();});
    const content=$('#panelContent');
    if(panelTab==='upload') {content.innerHTML=formUpload();bindUpload();return;}
    if(panelTab==='overview') {
      if(user.role==='uploader') {content.innerHTML=`<section class="admin-section"><h3>Willkommen</h3><p class="form-note">Dein Konto kann Ressourcen einreichen. Veröffentlichungen werden von einem Admin geprüft.</p><button class="button button-primary" id="goUpload">＋ Ressource einreichen</button></section>`;$('#goUpload').onclick=()=>{panelTab='upload';renderPanel();};return;}
      try { const d=await api('/api/admin/overview'); content.innerHTML=`<div class="admin-layout"><div class="admin-stat"><b>${d.stats.resources}</b><span>Ressourcen</span></div><div class="admin-stat"><b>${d.stats.pending}</b><span>Warten auf Prüfung</span></div><div class="admin-stat"><b>${d.visitors}</b><span>Besucher gesamt</span></div></div>${main?`<form id="visitorForm" class="visitor-control"><div><span class="visitor-control-kicker">BESUCHERANZEIGE</span><b>Besucherzahl einstellen</b><small>Der Wert bleibt für alle Besucher synchron.</small></div><label><span class="sr-only">Besucherzahl</span><input name="value" type="number" min="0" max="2147483647" value="${d.visitors}"></label><button class="button button-primary small">Speichern</button></form>`:''}<section class="admin-section"><h3>Letzte Aktivitäten</h3>${activityRows(d.activity)}</section>`;
        $('#visitorForm')?.addEventListener('submit',async e=>{e.preventDefault();try{const value=new FormData(e.currentTarget).get('value');await api('/api/admin/visitors',{method:'POST',body:JSON.stringify({value:Number(value)})});await refreshCounters();toast('Besucherzahl gespeichert.');renderPanel();}catch(err){toast(err.message);}});
      } catch(err) {content.innerHTML=`<p class="admin-message">${esc(err.message)}</p>`;}
      return;
    }
    if(panelTab==='accounts') {
      try {const accounts=await api('/api/admin/users');content.innerHTML=`<section class="admin-section"><h3>Admin-Konto anlegen</h3><form id="accountForm" class="admin-form"><label>Benutzername<input name="username" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_-]+"></label><label>Passwort<input name="password" type="password" required minlength="12" autocomplete="new-password"></label><label>Rolle<select name="role"><option value="uploader">Uploader</option><option value="security">Sicherheitsadmin</option></select></label><div class="admin-message" id="accountMessage"></div><button class="button button-primary">Konto erstellen</button></form></section><section class="admin-section"><h3>Konten</h3><div class="admin-list">${accounts.map(a=>`<div class="admin-row"><span><b>${esc(a.username)}</b><small>${esc(roleName[a.role]||a.role)}</small></span><span class="role-tag ${esc(a.role)}">${esc(roleName[a.role]||a.role)}</span>${a.role==='main'?'<span class="tag">geschützt</span>':`<button class="button danger small" data-delete-user="${esc(a.username)}">Löschen</button>`}</div>`).join('')}</div></section>`;
        $('#accountForm').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('/api/admin/users',{method:'POST',body:JSON.stringify({username:f.get('username'),password:f.get('password'),role:f.get('role')})});toast('Konto angelegt.');renderPanel();}catch(err){$('#accountMessage').textContent=err.message;}};
        document.querySelectorAll('[data-delete-user]').forEach(b=>b.onclick=async()=>{if(!confirm(`Konto ${b.dataset.deleteUser} wirklich löschen?`))return;try{await api(`/api/admin/users/${encodeURIComponent(b.dataset.deleteUser)}`,{method:'DELETE'});toast('Konto gelöscht.');renderPanel();}catch(err){toast(err.message);}});
      } catch(err){content.innerHTML=`<p class="admin-message">${esc(err.message)}</p>`;} return;
    }
    if(panelTab==='review') {
      try {const list=await api('/api/admin/resources');content.innerHTML=`<section class="admin-section"><h3>Ressourcen prüfen</h3><div class="admin-list">${list.length?list.map(r=>`<div class="admin-row"><span><b>${esc(r.title)}</b><small>${esc(r.author)} · ${esc(r.category)} · ${esc(r.status)}</small></span>${r.status!=='published'?`<button class="button button-primary small" data-publish="${esc(r.id)}">Freigeben</button>`:''}${main?`<button class="button danger small" data-delete-resource="${esc(r.id)}">Löschen</button>`:''}</div>`).join(''):'<p class="form-note">Noch keine Ressourcen.</p>'}</div></section>`;
        document.querySelectorAll('[data-publish]').forEach(b=>b.onclick=async()=>{try{await api(`/api/admin/resources/${b.dataset.publish}`,{method:'PATCH',body:JSON.stringify({status:'published'})});toast('Ressource veröffentlicht.');renderPanel();loadResources();}catch(err){toast(err.message);}});
        document.querySelectorAll('[data-delete-resource]').forEach(b=>b.onclick=async()=>{if(!confirm('Ressource endgültig löschen?'))return;try{await api(`/api/admin/resources/${b.dataset.deleteResource}`,{method:'DELETE'});toast('Ressource gelöscht.');renderPanel();loadResources();}catch(err){toast(err.message);}});
      } catch(err){content.innerHTML=`<p class="admin-message">${esc(err.message)}</p>`;} return;
    }
    if(panelTab==='logs') {try{const rows=await api('/api/admin/logs');content.innerHTML=`<section class="admin-section"><h3>Sicherheits- und Aktivitätslogs</h3>${activityRows(rows)}</section>`;}catch(err){content.innerHTML=`<p class="admin-message">${esc(err.message)}</p>`;}}
  }
  function activityRows(rows) {return `<div class="admin-list">${rows.length?rows.map(a=>`<div class="admin-row"><span><b>${esc(a.action)}</b><small>${esc(a.username)} · ${esc(a.detail||'')} · ${new Date(a.created_at).toLocaleString('de-DE')}</small></span><span class="role-tag">${esc(a.level||'info')}</span></div>`).join(''):'<p class="form-note">Noch keine Einträge.</p>'}</div>`;}
  function bindUpload() {
    $('#uploadForm').onsubmit=async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;try{const result=await api('/api/resources',{method:'POST',body:new FormData(e.currentTarget)});toast(result.status==='pending'?'Zur Prüfung eingereicht.':'Ressource veröffentlicht.');e.currentTarget.reset();if(result.status==='published')loadResources();panelTab='overview';renderPanel();}catch(err){$('#uploadMessage').textContent=err.message;}finally{button.disabled=false;}};
  }
  async function loadResources() {
    try {const resources=await api('/api/resources');$('#resourceCount').textContent=String(resources.length).padStart(2,'0');$('#emptyState').classList.toggle('hidden',resources.length>0);$('#resourceGrid').innerHTML=resources.map(r=>`<article class="resource-card"><div class="card-image">${r.hasImage?`<img src="/api/resources/${encodeURIComponent(r.id)}/image" alt="${esc(r.title)}">`:'<div class="image-placeholder theme-violet"><span class="placeholder-icon">✦</span></div>'}<span class="badge category">${esc(r.category)}</span></div><div class="card-body"><div class="card-topline"><h3>${esc(r.title)}</h3></div><p class="card-description">${esc(r.description)}</p><div class="card-foot"><span>von <b class="author">${esc(r.author)}</b></span>${r.hasFile?`<a class="button button-quiet small" href="/api/resources/${encodeURIComponent(r.id)}/download">↓ Download (${Number(r.downloads).toLocaleString('de-DE')})</a>`:`<span class="download-count">Bildvorschau</span>`}</div></div></article>`).join('');} catch {}
  }
  async function refreshCounters() {try{const d=await api('/api/visit');$('#visitorCount').textContent=Number(d.visitors).toLocaleString('de-DE');}catch{}}
  $('#adminEntry').addEventListener('click',e=>{e.preventDefault();openModal();});
  $('#closeAdmin').addEventListener('click',closeModal);
  modal.addEventListener('click',e=>{if(e.target===modal)closeModal();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});
  (async()=>{try{const auth=await api('/api/auth');user=auth.user;csrf=auth.csrf;await refreshCounters();}catch{}await loadResources();})();
})();
