(() => {
  'use strict';
  const DB_NAME = 'WorkshopProDB_v2';
  const DB_VERSION = 3;
  const TABLES = ['customers','inventory','services','bills','payments','stockMovements','settings'];
  const $ = id => document.getElementById(id);
  let db, rows = [], editingKey = null;
  const updateChannel = ('BroadcastChannel' in window) ? new BroadcastChannel('WorkshopProDB_updates') : null;
  function notifyApp(){ if(updateChannel) updateChannel.postMessage({type:'database-changed',source:'admin-page',at:Date.now()}); else { try{localStorage.setItem('workshoppro-db-ping',`admin:${Date.now()}`);}catch(_){} } }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const keyField = table => table === 'settings' ? 'key' : 'id';
  const openDB = () => new Promise((resolve,reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = () => { db=req.result; resolve(db); };
    req.onerror = () => reject(req.error || new Error('Could not open Workshop Pro database.'));
    req.onupgradeneeded = () => { const d=req.result; for(const name of TABLES) if(!d.objectStoreNames.contains(name)) d.createObjectStore(name,{keyPath:keyField(name)}); };
  });
  const readAll = table => new Promise((resolve,reject) => { const r=db.transaction(table,'readonly').objectStore(table).getAll(); r.onsuccess=()=>resolve(r.result||[]); r.onerror=()=>reject(r.error); });
  const put = (table,row) => new Promise((resolve,reject) => { const tx=db.transaction(table,'readwrite'); tx.objectStore(table).put(row); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error); });
  const del = (table,key) => new Promise((resolve,reject) => { const tx=db.transaction(table,'readwrite'); tx.objectStore(table).delete(key); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); });
  function setStatus(message){ $('status').textContent=message; }
  async function load(){ rows=await readAll($('table-select').value); render(); await renderAudit(); }
  async function renderAudit(){
    const [customers,inventory,bills,payments]=await Promise.all(['customers','inventory','bills','payments'].map(readAll));
    const missingPhones=customers.filter(c=>!/^\d{10}$/.test(String(c.phone||'').trim())).length;
    const spacedPhones=customers.filter(c=>String(c.phone||'')!==String(c.phone||'').trim()).length;
    const names=new Map();for(const c of customers){const key=String(c.name||'').trim().toLowerCase();if(key)names.set(key,(names.get(key)||0)+1);}const duplicateNames=[...names.values()].filter(n=>n>1).length;
    const nameList=[...names.keys()];const distance=(a,b)=>{const prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let diagonal=prev[0];prev[0]=i;for(let j=1;j<=b.length;j++){const above=prev[j];prev[j]=Math.min(prev[j]+1,prev[j-1]+1,diagonal+(a[i-1]===b[j-1]?0:1));diagonal=above;}}return prev[b.length];};let nearMatches=0;for(let i=0;i<nameList.length;i++)for(let j=i+1;j<nameList.length;j++){const a=nameList[i],b=nameList[j];if(Math.min(a.length,b.length)>=4&&distance(a,b)<=1)nearMatches++;}
    const legacyStock=inventory.filter(i=>Number(i.legacyTotalSold||0)>Number(i.legacyTotalIn||0)).length;
    const duplicateLineBills=bills.filter(b=>{const seen=new Set();return (b.items||[]).some(i=>{const k=String(i.inventoryId||i.serviceId||`${i.code||''}|${i.name||''}`).toLowerCase();if(seen.has(k))return true;seen.add(k);return false;});}).length;
    const customerIds=new Set(customers.map(c=>c.id));const orphanBills=bills.filter(b=>b.customerId&&!customerIds.has(b.customerId)).length;
    const billIds=new Set(bills.map(b=>b.id));const orphanPayments=payments.filter(p=>p.billId&&!billIds.has(p.billId)).length;
    const metrics=[['Customers missing / invalid 10-digit phone',missingPhones],['Phone values with extra spaces',spacedPhones],['Exact duplicate customer-name groups',duplicateNames],['Possible near-match customer-name pairs',nearMatches],['Legacy stock sold exceeds received',legacyStock],['Invoices with repeated item lines',duplicateLineBills],['Invoices with missing customer links',orphanBills],['Payments with missing invoice links',orphanPayments]];
    $('audit-results').innerHTML=metrics.map(([label,count])=>`<div class="audit-item ${count?'warn':'good'}"><strong>${count}</strong><span>${esc(label)}</span></div>`).join('');
  }
  function render(){
    const table=$('table-select').value, query=$('search').value.trim().toLowerCase();
    const filtered=rows.filter(row=>!query||JSON.stringify(row).toLowerCase().includes(query));
    const fields=[...new Set(filtered.flatMap(row=>Object.keys(row)))].slice(0,12);
    $('stats').innerHTML=`<div class="stat"><strong>${rows.length}</strong> total records</div><div class="stat"><strong>${filtered.length}</strong> matching</div><div class="stat"><strong>${table}</strong> selected table</div>`;
    $('thead').innerHTML=`<tr>${fields.map(f=>`<th>${esc(f)}</th>`).join('')}<th>Actions</th></tr>`;
    $('tbody').innerHTML=filtered.length?filtered.map(row=>`<tr>${fields.map(f=>`<td><div class="cell-content" title="${esc(typeof row[f]==='object'?JSON.stringify(row[f]):row[f]??'—')}">${esc(typeof row[f]==='object'?JSON.stringify(row[f]):row[f]??'—')}</div></td>`).join('')}<td><div class="row-actions"><button data-edit="${esc(row[keyField(table)])}">Edit JSON</button><button class="delete" data-delete="${esc(row[keyField(table)])}">Delete</button></div></td></tr>`).join(''):`<tr><td colspan="${fields.length+1}" class="cell-muted">No records found in this table.</td></tr>`;
  }
  function openEditor(row=null){
    const table=$('table-select').value; editingKey=row?row[keyField(table)]:null;
    const fresh=row?structuredClone(row):(table==='settings'?{key:'new-setting',value:''}:{id:crypto.randomUUID(),name:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    $('editor-title').textContent=row?'Edit record':'Add record'; $('record-json').value=JSON.stringify(fresh,null,2); $('editor').showModal();
  }
  async function saveEditor(event){
    event.preventDefault(); const table=$('table-select').value, key=keyField(table);
    try{const record=JSON.parse($('record-json').value); if(!record||typeof record!=='object'||Array.isArray(record)||record[key]==null||record[key]==='') throw new Error(`Record must be an object with a non-empty ${key}.`);
      if(editingKey!==null && String(record[key])!==String(editingKey)) throw new Error(`The ${key} cannot be changed for an existing record.`);
      await put(table,record); notifyApp(); $('editor').close(); await load(); setStatus('Record saved successfully.');
    }catch(error){alert(error.message||'Invalid JSON.');}
  }
  function csvCell(value){let text=String(value??'');if(/^[\s]*[=+@-]/.test(text))text="'"+text;return /[",\n\r]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;}
  function download(content,name,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function exportFull(){const data={};for(const table of TABLES)data[table]=await readAll(table);download(JSON.stringify({app:'WorkshopPro',schemaVersion:3,exportedAt:new Date().toISOString(),data},null,2),`WorkshopPro_Admin_Backup_${new Date().toISOString().slice(0,10)}.json`,'application/json');}
  function exportTable(){const table=$('table-select').value;const fields=[...new Set(rows.flatMap(row=>Object.keys(row)))];const csv=[fields.map(csvCell).join(','),...rows.map(row=>fields.map(field=>csvCell(typeof row[field]==='object'?JSON.stringify(row[field]):row[field])).join(','))].join('\r\n');download('\ufeff'+csv,`WorkshopPro_${table}.csv`,'text/csv;charset=utf-8');}
  async function start(){const expected=String(window.WORKSHOP_CONFIG?.adminPin||'');if(!expected){$('login-hint').textContent='Admin access is disabled. Set a private adminPin in config.js, then reload this page.';return;}
    $('login-form').addEventListener('submit',async event=>{event.preventDefault();if($('admin-pin').value!==expected){$('login-hint').textContent='Incorrect PIN.';return;}try{await openDB();$('login-panel').hidden=true;$('workspace').hidden=false;await load();setStatus('Connected to this browser’s Workshop Pro database.');}catch(error){setStatus(error.message);}});
  }
  $('table-select').addEventListener('change',load);$('search').addEventListener('input',render);$('refresh').addEventListener('click',load);$('add-row').addEventListener('click',()=>openEditor());$('export-csv').addEventListener('click',exportTable);$('export-json').addEventListener('click',exportFull);$('editor-form').addEventListener('submit',saveEditor);$('close-editor').addEventListener('click',()=>$('editor').close());$('cancel-editor').addEventListener('click',()=>$('editor').close());
  $('tbody').addEventListener('click',async event=>{const edit=event.target.closest('[data-edit]');const remove=event.target.closest('[data-delete]');const table=$('table-select').value;if(edit){const row=rows.find(r=>String(r[keyField(table)])===edit.dataset.edit);if(row)openEditor(row);}if(remove){const key=remove.dataset.delete;if(confirm(`Permanently delete this ${table} record? Related invoice and ledger references may be affected.`)){await del(table,key);notifyApp();await load();setStatus('Record deleted. Check related records before continuing.');}}});
  start();
})();
