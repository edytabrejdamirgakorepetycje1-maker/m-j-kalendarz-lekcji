
/*
 MÓJ KALENDARZ — AKTUALIZACJA SYNCHRONIZACJI v13
 ------------------------------------------------
 Synchronizuje bazę kalendarza między telefonem i iPadem
 przez plik JSON w prywatnym repozytorium GitHub.

 WAŻNE:
 - Nie wkładaj tokenu GitHub bezpośrednio do kodu.
 - Token wpisujesz jednorazowo w ustawieniach aplikacji.
 - Token jest przechowywany tylko lokalnie na danym urządzeniu.
 - Repozytorium może być prywatne.
*/

const SYNC_CONFIG_KEY = 'moj_kalendarz_github_sync_v1';

function getSyncConfig(){
  try { return JSON.parse(localStorage.getItem(SYNC_CONFIG_KEY) || 'null') || {}; }
  catch(e){ return {}; }
}
function saveSyncConfig(c){
  localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(c));
}

function githubHeaders(token, json=false){
  const h = {
    'Accept':'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28'
  };
  if(token) h.Authorization = 'Bearer ' + token;
  if(json) h['Content-Type'] = 'application/json';
  return h;
}

function b64EncodeUnicode(str){
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunk = 0x8000;
  for(let i=0;i<bytes.length;i+=chunk){
    binary += String.fromCharCode(...bytes.subarray(i, i+chunk));
  }
  return btoa(binary);
}

function b64DecodeUnicode(b64){
  const binary = atob(b64.replace(/\n/g,''));
  const bytes = Uint8Array.from(binary, c=>c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function githubGetSync(){
  const c=getSyncConfig();
  if(!c.token || !c.owner || !c.repo || !c.path)
    throw new Error('Brak konfiguracji synchronizacji.');

  const url=`https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${c.path}`;
  const r=await fetch(url,{headers:githubHeaders(c.token)});
  if(r.status===404) return {exists:false, sha:null, data:null};
  if(!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
  const x=await r.json();
  return {exists:true,sha:x.sha,data:JSON.parse(b64DecodeUnicode(x.content))};
}

async function githubPutSync(newData, sha){
  const c=getSyncConfig();
  const url=`https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${c.path}`;
  const body={
    message:'Aktualizacja kalendarza lekcji',
    content:b64EncodeUnicode(JSON.stringify(newData,null,2)),
    ...(sha ? {sha} : {})
  };
  const r=await fetch(url,{
    method:'PUT',
    headers:githubHeaders(c.token,true),
    body:JSON.stringify(body)
  });
  if(!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
  return await r.json();
}

/* Łączenie danych:
   - uczniowie i wydarzenia są identyfikowane po id,
   - nowsza wersja rekordu wygrywa,
   - usunięcia są zapisywane jako tombstone, aby nie wracały po synchronizacji.
*/
function mergeSyncData(local, remote){
  const out={
    students:Array.isArray(local.students)?local.students.slice():[],
    events:Array.isArray(local.events)?local.events.slice():[],
    dayNotes:{...(local.dayNotes||{})},
    syncMeta:{...(local.syncMeta||{})}
  };
  const rStudents=Array.isArray(remote?.students)?remote.students:[];
  const rEvents=Array.isArray(remote?.events)?remote.events:[];
  const rNotes=remote?.dayNotes||{};

  const lm=out.syncMeta.records||{};
  const tomb=out.syncMeta.tombstones||{};

  function mergeArray(key, remoteArr){
    const map=new Map(out[key].map(x=>[x.id,x]));
    for(const r of remoteArr){
      if(!r || !r.id) continue;
      const l=map.get(r.id);
      const lr=Number(l?._updatedAt||0);
      const rr=Number(r?._updatedAt||0);
      if(!l || rr>lr) map.set(r.id,r);
    }
    out[key]=Array.from(map.values());
  }

  mergeArray('students',rStudents);
  mergeArray('events',rEvents);

  for(const k of Object.keys(rNotes)){
    if(!(k in out.dayNotes)) out.dayNotes[k]=rNotes[k];
  }
  for(const k of Object.keys(out.dayNotes)){
    if(!(k in rNotes) && remote?.dayNotes && remote.dayNotes.__clearAll) delete out.dayNotes[k];
  }

  out.syncMeta.lastMergeAt=Date.now();
  return out;
}

function markLocalSyncChanges(){
  const now=Date.now();
  data.syncMeta=data.syncMeta||{};
  data.syncMeta.lastLocalChange=now;
  for(const s of data.students||[]) s._updatedAt=s._updatedAt||now;
  for(const e of data.events||[]) e._updatedAt=e._updatedAt||now;
}

async function syncNow(){
  const c=getSyncConfig();
  if(!c.token || !c.owner || !c.repo || !c.path){
    throw new Error('Najpierw ustaw GitHub: właściciel repozytorium, nazwa repozytorium, plik i token.');
  }

  markLocalSyncChanges();
  const remote=await githubGetSync();

  if(!remote.exists){
    await githubPutSync(data,null);
    data.syncMeta.lastSyncAt=Date.now();
    persist();
    return 'uploaded';
  }

  const merged=mergeSyncData(data,remote.data||{});
  data=merged;
  markLocalSyncChanges();
  await githubPutSync(data,remote.sha);
  data.syncMeta.lastSyncAt=Date.now();
  persist();
  return 'synced';
}

async function pullSyncOnly(){
  const remote=await githubGetSync();
  if(!remote.exists) throw new Error('Nie znaleziono pliku synchronizacji.');
  data=mergeSyncData(data,remote.data||{});
  persist();
  if(typeof renderCalendar==='function') renderCalendar();
  if(typeof renderStudents==='function') renderStudents();
}

function openSyncSettings(){
  const c=getSyncConfig();
  const token=prompt(
    'Wklej GitHub Fine-grained Personal Access Token.\n\n' +
    'Token powinien mieć dostęp Contents: Read and write tylko do wybranego repozytorium.',
    c.token||''
  );
  if(token===null) return;

  const owner=prompt('Nazwa użytkownika / organizacji GitHub:',c.owner||'');
  if(owner===null)return;
  const repo=prompt('Nazwa repozytorium:',c.repo||'');
  if(repo===null)return;
  const path=prompt('Nazwa pliku synchronizacji:',c.path||'kalendarz-sync.json');
  if(path===null)return;

  saveSyncConfig({token:token.trim(),owner:owner.trim(),repo:repo.trim(),path:path.trim()});
  alert('Ustawienia zapisane. Teraz wybierz „Synchronizuj teraz”.');
}

async function runSyncUI(){
  const btn=document.getElementById('syncNowButton');
  const status=document.getElementById('syncStatus');
  if(btn)btn.disabled=true;
  if(status)status.textContent='Synchronizuję…';
  try{
    await syncNow();
    if(status)status.textContent='✓ Zsynchronizowano '+new Date().toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});
    if(typeof renderCalendar==='function')renderCalendar();
    if(typeof renderStudents==='function')renderStudents();
  }catch(e){
    console.error(e);
    if(status)status.textContent='⚠ Błąd synchronizacji';
    alert('Nie udało się zsynchronizować danych.\n\n'+e.message);
  }finally{
    if(btn)btn.disabled=false;
  }
}

function addSyncControls(){
  if(document.getElementById('syncControls')) return;
  const actions=document.querySelector('.calendar-head .cal-nav');
  if(!actions)return;

  const wrap=document.createElement('div');
  wrap.id='syncControls';
  wrap.style.cssText='display:flex;gap:7px;align-items:center;margin-left:auto;flex-wrap:wrap';

  const set=document.createElement('button');
  set.textContent='☁️ Ustaw synchronizację';
  set.className='secondary';
  set.onclick=openSyncSettings;

  const sync=document.createElement('button');
  sync.id='syncNowButton';
  sync.textContent='↻ Synchronizuj';
  sync.className='primary';
  sync.onclick=runSyncUI;

  const status=document.createElement('span');
  status.id='syncStatus';
  status.className='details';
  status.textContent='Dane są lokalne — włącz synchronizację';

  wrap.append(set,sync,status);
  actions.parentElement.appendChild(wrap);
}

window.addEventListener('load',()=>{
  setTimeout(addSyncControls,50);
});
