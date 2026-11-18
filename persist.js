// Race file autosave and browser backups.
// - The race file is a JSON file the user picks. Writing to it uses the File System Access API (Chrome/Edge on desktop).
// - Every change ends in draw(), which calls afterDraw(). If the event data changed, it is written to the race file
//   shortly after and also copied to browser backups (IndexedDB), so nothing depends on remembering to save.
// - Files are untrusted input: they are parsed with JSON.parse and every field is checked and normalised before use.
'use strict';
const FS=!!(window.showSaveFilePicker&&window.showOpenFilePicker&&window.isSecureContext);
const KEYS=['eid','type','all','allSlots','off','seeded','id','pool','inv','hist','sec'];
const FILE_TYPES=[{description:'Zealous race file',accept:{'application/json':['.json']}}];
const SNAP_EVERY=5*60*1000,SNAP_KEEP=20,EVENTS_KEEP=10,SAVE_DELAY=250,BACKUP_DELAY=800;
// h: file handle being saved to · last: event data last seen (JSON) · state: none|saving|saved|error|perm
const F={h:null,name:'',last:null,state:'none',at:0,err:'',timer:0,pending:0,recent:null,bt:0,snapAt:0,backups:[],idb:true};
const hasEvent=()=>!!(S.type||S.all.length);
const newId=()=>(crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2));
const dataStr=()=>JSON.stringify(Object.fromEntries(KEYS.map(k=>[k,S[k]===undefined?null:S[k]])));
const wrap=d=>JSON.stringify({app:'zealous-race',version:1,savedAt:new Date().toISOString(),data:JSON.parse(d)},null,1);
const evName=()=>F.name?F.name.replace(/\.json$/i,''):(S.type||'Untitled')+' event';
const suggest=()=>(S.type||'Race')+'-race-'+new Date().toISOString().slice(0,10)+'.json';
const ago=t=>{const s=Math.round((Date.now()-t)/1000);return s<10?'just now':s<60?s+' s ago':s<3600?Math.round(s/60)+' min ago':new Date(t).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})};

// ---------- reading and checking a race file ----------
function unpack(text){let o;try{o=JSON.parse(text)}catch(e){throw new Error('This file isn\'t valid JSON, so it can\'t be opened as a race file.')}
if(!o||typeof o!='object'||o.app!=='zealous-race'||!o.data||typeof o.data!='object')throw new Error('This isn\'t a Zealous race file.');
if(+o.version>1)throw new Error('This race file was made by a newer version of the app.');
const d=o.data,A=Array.isArray,str=v=>v==null?'':String(v),int=(v,lo,hi)=>Number.isInteger(v)&&v>=lo&&v<=hi;
if(!A(d.all)||!A(d.allSlots))throw new Error('This race file is missing its riders or schedule.');
const all=d.all.filter(r=>r&&typeof r=='object').map(r=>({id:+r.id,name:str(r.name).trim(),cat:str(r.cat),day:str(r.day),team:str(r.team),lic:str(r.lic),ecn:str(r.ecn),ecp:str(r.ecp),pts:Number.isFinite(+r.pts)?+r.pts:0,reg:str(r.reg),dayof:r.dayof?1:0,bib:int(r.bib,0,9999)?r.bib:null,place:int(r.place,1,99999)?r.place:r.place==='DNF'||r.place==='DQ'?r.place:''}));
const allSlots=d.allSlots.filter(s=>s&&typeof s=='object').map(s=>({id:+s.id,time:/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)?s.time:'09:00',day:str(s.day),cats:A(s.cats)?s.cats.map(str):[]}));
const ids=[...all.map(r=>r.id),...allSlots.map(s=>s.id)];
if(ids.some(i=>!Number.isInteger(i)||i<0)||new Set(ids).size!=ids.length||all.some(r=>!r.name))throw new Error('This race file is damaged: some riders or time slots are missing an ID or name.');
const pool=A(d.pool)?[...new Set(d.pool.filter(n=>int(n,0,9999)))].sort((a,b)=>a-b):[];
return {eid:str(d.eid)||newId(),type:d.type==='Gravel'||d.type==='Cyclocross'?d.type:null,all,allSlots,off:A(d.off)?d.off.map(str):[],seeded:A(d.seeded)?d.seeded.map(str):[],
id:Math.max(Number.isInteger(d.id)?d.id:1,1+Math.max(0,...ids)),pool:pool.length?pool:null,inv:pool.length?str(d.inv):'',hist:A(d.hist)?d.hist.filter(i=>Number.isInteger(i)):[],sec:int(d.sec,3,3600)?d.sec:undefined}}
function apply(d){Object.assign(S,d);Object.assign(S,{slot:null,cat:null,edit:null,eerr:null,pick:null,pend:null,te:null,terr:null});F.last=dataStr()}
function reset(){apply({eid:null,type:null,all:[],allSlots:[],off:[],seeded:[],id:1,pool:null,inv:'',hist:[],sec:undefined});S.tab='Open/Import'}

// ---------- the race file ----------
function afterDraw(){if(!hasEvent()&&!F.h){paint();return}const d=dataStr();if(d!==F.last){F.last=d;if(F.h&&F.state!='perm'){clearTimeout(F.timer);F.timer=setTimeout(()=>{F.timer=0;write()},SAVE_DELAY)}queueBackup()}paint()}
// Writes run one after another. Each captures its file and data when queued, so switching events can't mix them up.
let chain=Promise.resolve();
function writeTo(h,d){const p=chain.then(async()=>{const w=await h.createWritable();await w.write(wrap(d));await w.close()});chain=p.catch(()=>{});return p}
function write(){if(!F.h||F.last==null)return Promise.resolve();const h=F.h,d=F.last;F.state='saving';F.pending++;paint();
return writeTo(h,d).then(()=>{if(h===F.h&&d===F.last){F.state='saved';F.at=Date.now();F.err=''}},e=>{if(h===F.h){F.state=e&&(e.name=='NotAllowedError'||e.name=='SecurityError')?'perm':'error';F.err=e&&e.message||String(e)}}).finally(()=>{F.pending--;paint()})}
function flush(){if(F.timer){clearTimeout(F.timer);F.timer=0;write()}return chain}
async function attach(h,{writeNow}){F.h=h;F.name=h.name;F.err='';F.state='saved';F.at=Date.now();F.recent=null;if(writeNow)await write();paint();try{await idbPut('kv','recent',h);await idbPut('kv','recentName',h.name)}catch(e){}}
// Synchronous so a file picker can still open in the same click. A pending save still finishes to the old file.
function detach(){flush();F.h=null;F.name='';F.state='none';F.err='';paint()}
async function canWrite(h,ask){try{if(await h.queryPermission({mode:'readwrite'})=='granted')return true;return ask&&await h.requestPermission({mode:'readwrite'})=='granted'}catch(e){return false}}
// Called straight from a click so the browser allows the file picker.
async function saveAs(name){if(!FS)return msg('er','Saving a race file needs Chrome or Edge on a computer.');let h;
try{h=await showSaveFilePicker({suggestedName:name||suggest(),types:FILE_TYPES})}catch(e){if(e&&(e.name=='AbortError'||e.name=='SecurityError')){paint();return}return msg('er','Couldn\'t create the race file: '+(e&&e.message||e))}
detach();F.last=dataStr();await attach(h,{writeNow:true})}
async function openFile(){if(!FS)return msg('er','Opening a race file needs Chrome or Edge on a computer.');
if(hasEvent()&&!F.h&&!confirm('Open another race file? The current event isn\'t saved to a file. A browser backup of it is kept.'))return;let h;
try{[h]=await showOpenFilePicker({types:FILE_TYPES,multiple:false})}catch(e){if(e&&e.name=='AbortError')return;if(e&&e.name=='SecurityError')return msg('er','Click "Open race file…" again to choose the file.');return msg('er','Couldn\'t open the file: '+(e&&e.message||e))}
await loadFrom(h,false)}
async function loadFrom(h,ask){let d;try{if(ask&&!await canWrite(h,true)){paint();return msg('er','The browser didn\'t allow access to '+h.name+'.')}d=unpack(await (await h.getFile()).text())}
catch(e){paint();return msg('er',(e&&e.name=='NotFoundError'?h.name+' was moved or deleted.':e&&e.message||String(e)))}
detach();apply(d);S.tab='Open/Import';await attach(h,{writeNow:false});
if(!await canWrite(h,true))F.state='perm';
msg('ok','Opened '+h.name+': '+S.all.length+' entries'+(S.type?', '+S.type:'')+'.'+(F.state=='perm'?' Click "Allow saving" so changes are saved to this file.':' Changes save to this file automatically.'))}
async function allowSave(){if(!F.h)return;if(await canWrite(F.h,true)){F.state='saved';await write();msg('ok','Saving to '+F.name+' again.')}else msg('er','The browser didn\'t allow saving to '+F.name+'.')}
// The handle itself is only read from IndexedDB when the user asks to reopen it (Chromium can crash reading file handles back
// in incognito windows, so the page never does it on load). Startup only reads the file name.
async function reopen(){let h=null;try{h=await idbGet('kv','recent')}catch(e){}if(!h)return msg('er','The last race file can\'t be reopened. Use "Open race file…" instead.');await loadFrom(h,true)}
async function closeEvent(){if(!confirm('Close this event? '+(F.h?'Everything is saved in '+F.name+'.':'It isn\'t saved to a file, but a browser backup is kept.')))return;detach();reset();msg('ok','Event closed.')}

// ---------- status bar ----------
function paint(){const el=$('#sv');if(!el)return;let cls='',body='';
if(!FS&&hasEvent()){cls='wa';body='Autosave needs Chrome or Edge on a computer. Changes in this browser aren\'t saved to a race file.'}
else if(F.h){const n='<b>'+esc(F.name)+'</b>';
 if(F.state=='saving')body='Saving to '+n+'…';
 else if(F.state=='saved'){cls='ok';body='Saved to '+n+' · '+ago(F.at)}
 else if(F.state=='perm'){cls='wa';body='Saving to '+n+' is paused until the browser allows it.<button class="p" data-click="allowSave">Allow saving</button>'}
 else{cls='er';body='Couldn\'t save to '+n+': '+esc(F.err)+'<button class="p" data-click="retrySave">Retry</button><button data-click="saveAs">Save as…</button>'}}
else if(hasEvent()){cls='wa';body='Not saving to a file. Changes are only kept as a browser backup.<button class="p" data-click="saveAs">Save race file…</button>'}
el.className='noprint'+(body?' msg sv '+cls:'');el.innerHTML=body?'<span class="dot" aria-hidden="true"></span><span>'+body+'</span>':''}
setInterval(()=>{if(F.state=='saved')paint()},10000);
addEventListener('beforeunload',e=>{if(F.timer||F.pending||(F.h&&F.state!='saved')){e.preventDefault();e.returnValue=''}});

// ---------- browser backups (IndexedDB) ----------
let dbp=null;
const db=()=>dbp||(dbp=new Promise((res,rej)=>{const r=indexedDB.open('zealous-race',1);r.onupgradeneeded=()=>{r.result.createObjectStore('kv');r.result.createObjectStore('backups')};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}));
const tx=(st,mode,fn)=>db().then(d=>new Promise((res,rej)=>{const t=d.transaction(st,mode),q=fn(t.objectStore(st));t.oncomplete=()=>res(q&&q.result);t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error)}));
const idbGet=(st,k)=>tx(st,'readonly',s=>s.get(k)),idbPut=(st,k,v)=>tx(st,'readwrite',s=>s.put(v,k)),idbDel=(st,k)=>tx(st,'readwrite',s=>s.delete(k));
const idbAll=st=>db().then(d=>new Promise((res,rej)=>{const t=d.transaction(st,'readonly'),s=t.objectStore(st),k=s.getAllKeys(),v=s.getAll();t.oncomplete=()=>res(k.result.map((key,i)=>({key,...v.result[i]})));t.onerror=()=>rej(t.error)}));
function queueBackup(){if(!F.idb||!hasEvent())return;clearTimeout(F.bt);F.bt=setTimeout(backup,BACKUP_DELAY)}
async function backup(){if(!hasEvent())return;if(!S.eid)S.eid=newId();const d=dataStr(),now=Date.now(),rec={eid:S.eid,name:evName(),at:now,riders:S.all.length,type:S.type,json:d};
try{await idbPut('backups','latest:'+S.eid,{...rec,kind:'latest'});if(now-F.snapAt>=SNAP_EVERY){F.snapAt=now;await idbPut('backups','snap:'+now,{...rec,kind:'snapshot'})}
const all=await idbAll('backups'),drop=[...all.filter(b=>b.kind=='snapshot').sort((a,b)=>b.at-a.at).slice(SNAP_KEEP),...all.filter(b=>b.kind=='latest').sort((a,b)=>b.at-a.at).slice(EVENTS_KEEP)];
for(const b of drop)await idbDel('backups',b.key)}catch(e){F.idb=false}
refreshBackups()}
async function refreshBackups(){try{F.backups=(await idbAll('backups')).sort((a,b)=>b.at-a.at)}catch(e){F.backups=[];F.idb=false}const el=$('#bk');if(el)el.outerHTML=backupsCard()}
async function restore(key){const b=F.backups.find(x=>x.key===key);if(!b)return;
if(hasEvent()&&!F.h&&!confirm('Restore this backup? The current event isn\'t saved to a file. A browser backup of it is kept.'))return;
let d;try{d=unpack(wrap(b.json))}catch(e){return msg('er','This backup can\'t be restored: '+e.message)}
detach();apply(d);msg('ok','Restored '+b.name+' from '+new Date(b.at).toLocaleString()+' ('+S.all.length+' entries). Choose where to save it.');
if(FS)saveAs(b.name.replace(/[\\/:*?"<>|]/g,'-')+'.json')}
async function clearBackups(){if(!confirm('Delete all browser backups on this computer? Race files you saved are not affected. While an event is open, new changes are backed up again.'))return;
try{await tx('backups','readwrite',s=>s.clear());F.snapAt=0;F.backups=[];await refreshBackups();msg('ok','Browser backups deleted.')}catch(e){msg('er','Couldn\'t delete browser backups: '+(e&&e.message||e))}}

// ---------- Open/Import page cards ----------
function openCard(){return `<div class="card noprint"><h3>Open race file</h3><div class="mu">${FS?'A race file is a JSON file on your computer. Every change saves to it automatically.':'Opening and saving race files needs Chrome or Edge on a computer.'}</div>${FS?`<div class="row"><button class="p" data-click="openFile">Open race file…</button>${F.recent&&!F.h?`<button data-click="reopen">Reopen ${esc(F.recent.name)}</button>`:''}${hasEvent()&&!F.h?'<button data-click="saveAs">Save race file…</button>':''}</div>`:''}</div>`}
function backupsCard(){const b=F.backups,label=x=>x.kind=='latest'?'Latest':'Snapshot';
return `<div class="card noprint" id="bk"><h3>Browser backups</h3><div class="mu">${F.idb?'Copies kept in this browser in case a race file is lost or damaged: the latest version of each event, plus a snapshot every 5 minutes (last '+SNAP_KEEP+' kept). They include rider contact details, so delete them when you\'re done with an event.':'Browser backups aren\'t available in this browser window.'}</div>
${b.length?`<table style="margin-top:8px"><tr><th>Event</th><th>Saved</th><th>Entries</th><th>Kind</th><th></th></tr>${b.map(x=>`<tr><td>${esc(x.name)}${x.type?` <span class="mu">${esc(x.type)}</span>`:''}</td><td>${esc(new Date(x.at).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))}</td><td>${x.riders|0}</td><td class="mu">${label(x)}</td><td><button data-click="restore" data-k="${esc(x.key)}">Restore</button></td></tr>`).join('')}</table>`:F.idb?'<div class="mu" style="margin-top:8px">No backups yet.</div>':''}
${b.length?'<div class="row"><button data-click="clearBackups">Clear browser backups</button></div>':''}</div>`}

// ---------- wiring ----------
// Loading the sample starts a new event; importing a CSV adds to the open event. Either way, ask where to save if there's no file yet.
const _sample=ACT.click.sample,_imp=ACT.click.imp;
Object.assign(ACT.click,{
 sample:()=>{if(F.h&&!confirm('Load the sample data as a new event? '+F.name+' stays saved as it is.'))return;detach();_sample();S.eid=newId();if(FS)saveAs()},
 imp:el=>{_imp(el);if(!S.eid&&hasEvent())S.eid=newId();if(FS&&!F.h&&S.all.length)saveAs()},
 openFile,reopen,closeEvent,allowSave,clearBackups,saveAs:()=>saveAs(),retrySave:()=>write(),restore:el=>restore(el.dataset.k)});
(async()=>{draw();if(F.idb){try{const n=await idbGet('kv','recentName');if(n&&FS&&!F.h&&!hasEvent())F.recent={name:String(n)}}catch(e){F.idb=false}await refreshBackups()}if(S.tab=='Open/Import'&&!hasEvent())draw()})();
