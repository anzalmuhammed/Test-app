/* WorkshopPro v5 record-level Google Drive synchronization.
 * Append-only operation files; local IndexedDB remains the immediate source of writes.
 * Google Drive is storage, not a transactional database. */
(() => {
  'use strict';
  const PREFIX = 'WP5_OP_';
  const MANIFEST_NAME = 'WorkshopPro_V5_Sync_Manifest.json';
  const SYNC_STORES = ['syncMeta', 'syncOutbox', 'syncApplied', 'syncConflicts'];
  const DATA_STORES = ['customers', 'inventory', 'services', 'bills', 'payments', 'stockMovements', 'settings'];
  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const canonical = value => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  const hash = value => {
    const source = canonical(value);
    let h1 = 0xdeadbeef ^ source.length, h2 = 0x41c6ce57 ^ source.length;
    for (let i = 0, ch; i < source.length; i++) {
      ch = source.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  };
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const keyOf = (store, row) => store === 'settings' ? row.key : row.id;
  const cleanRecord = (store, row) => {
    const copy = clone(row);
    // Inventory quantity is represented by immutable stock movement operations.
    if (store === 'inventory') delete copy.quantity;
    return copy;
  };

  class DriveRecordSync {
    constructor({ db, getToken, setStatus, onApplied, deviceId }) {
      this.db = db; this.getToken = getToken; this.setStatus = setStatus; this.onApplied = onApplied;
      this.deviceId = deviceId || uuid(); this.running = false; this.rerunRequested = false; this.started = false; this.timer = null; this.lastError = ''; this.role = null; this.onRole = null;
    }
    tx(stores, mode, work) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(stores, mode);
        let result;
        try { result = work(tx); } catch (e) { try { tx.abort(); } catch (_) {} reject(e); return; }
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('Local synchronization database transaction failed.'));
      });
    }
    all(store) { return new Promise((resolve, reject) => { const tx=this.db.transaction(store,'readonly'); const r=tx.objectStore(store).getAll(); r.onsuccess=()=>resolve(r.result||[]); r.onerror=()=>reject(r.error); }); }
    one(store,key) { return new Promise((resolve,reject)=>{const tx=this.db.transaction(store,'readonly');const r=tx.objectStore(store).get(key);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);}); }
    put(store,row) { return this.tx([store],'readwrite',tx=>tx.objectStore(store).put(row)); }
    async meta(key,value) { if (arguments.length===2) return this.put('syncMeta',{key,value}); const row=await this.one('syncMeta',key); return row?.value; }
    async loadRole(){this.role=await this.meta('deviceRole')||null;return this.role;}
    async api(url, options={}) {
      const token=this.getToken(); if(!token) throw new Error('Google Drive is not connected in this browser session.');
      const response=await fetch(url,{...options,headers:{...(options.headers||{}),Authorization:`Bearer ${token}`}});
      if(response.status===401) throw new Error('Google authorization expired. Reconnect Google Drive to resume automatic sync.');
      if(!response.ok){let msg='';try{msg=(await response.json()).error?.message||'';}catch(_){}throw new Error(msg||`Drive request failed (${response.status}).`);}
      return response;
    }
    async findByName(name) {
      const q=encodeURIComponent(`name = '${name.replace(/'/g,"\\'")}' and trashed = false`);
      const r=await this.api(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=10&orderBy=createdTime&fields=files(id,name,createdTime)`);
      return (await r.json()).files?.[0]||null;
    }
    async ensureManifest() {
      let manifest=await this.findByName(MANIFEST_NAME);
      if(!manifest){
        const body={schema:1,app:'WorkshopPro',syncVersion:5,ownerDeviceId:this.deviceId,createdAt:new Date().toISOString(),policy:'single-shop-writer-append-only-ops'};
        const boundary=`wp5_${uuid().replace(/-/g,'')}`;
        const multipart=new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name:MANIFEST_NAME,mimeType:'application/json'})}\r\n`,`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}\r\n`,`--${boundary}--`],{type:`multipart/related; boundary=${boundary}`});
        const createdResponse=await this.api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body:multipart});
        manifest=await createdResponse.json();
      }
      if(!manifest) throw new Error('Could not establish the shared WorkshopPro sync manifest.');
      const response=await this.api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(manifest.id)}?alt=media`);
      const data=await response.json();
      await this.meta('manifestOwnerDeviceId',data.ownerDeviceId||'');
      return data;
    }
    async primeBaseline() {
      for(const store of DATA_STORES){
        for(const row of await this.all(store)){const id=keyOf(store,row);if(id==null)continue;const baselineKey=`baseline:${store}:${id}`;if((await this.meta(baselineKey))===undefined)await this.meta(baselineKey,hash(cleanRecord(store,row)));}
      }
    }
    async seedCurrentDatabase() {
      // The initial seed is a current-state snapshot. Supersede queued pre-seed deltas so
      // their quantities are not replayed on top of the seeded stock balance.
      for(const queued of await this.all('syncOutbox')){queued.uploaded=true;queued.supersededByInitialSeed=true;await this.put('syncOutbox',queued);}
      for(const store of DATA_STORES){
        for(const row of await this.all(store)){
          const id=keyOf(store,row);if(id==null)continue;
          const normalized=cleanRecord(store,row);const operation={id:uuid(),deviceId:this.deviceId,store,recordId:id,kind:store==='stockMovements'?'stock-movement':'upsert',baseHash:null,record:normalized,createdAt:new Date().toISOString(),historical:store==='stockMovements'};
          if(store==='inventory')operation.initialQuantity=Number(row.quantity||0);
          await this.put('syncOutbox',{id:operation.id,operation,uploaded:false,createdAt:operation.createdAt});
          await this.meta(`baseline:${store}:${id}`,hash(normalized));
        }
      }
    }
    async captureLocalChanges() {
      const pending=[];
      for(const store of DATA_STORES){
        const rows=await this.all(store);
        for(const row of rows){
          const id=keyOf(store,row); if(id==null) continue;
          const normalized=cleanRecord(store,row); const fingerprint=hash(normalized);
          const unresolved=(await this.all('syncConflicts')).some(c=>c.status==='unresolved'&&c.store===store&&c.recordId===id);
          if(unresolved) continue;
          const baselineKey=`baseline:${store}:${id}`; const previous=await this.meta(baselineKey);
          if(previous===fingerprint) continue;
          const operation={id:uuid(),deviceId:this.deviceId,store,recordId:id,kind:store==='stockMovements'?'stock-movement':'upsert',baseHash:previous||null,record:normalized,createdAt:new Date().toISOString(),historical:false};
          if(store==='inventory'&&!previous) operation.initialQuantity=Number(row.quantity||0);
          await this.put('syncOutbox',{id:operation.id,operation,uploaded:false,createdAt:operation.createdAt});
          await this.meta(baselineKey,fingerprint);
          pending.push(operation);
        }
      }
      return pending.length;
    }
    async uploadOutbox() {
      const rows=(await this.all('syncOutbox')).filter(x=>!x.uploaded).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
      for(const row of rows){
        const name=PREFIX+row.id+'.json';
        const boundary=`wp5_${uuid().replace(/-/g,'')}`;
        const metadata={name,mimeType:'application/json',appProperties:{workshopProOperationId:row.id}};
        const body=new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(row.operation)}\r\n`,`--${boundary}--`],{type:`multipart/related; boundary=${boundary}`});
        await this.api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body});
        row.uploaded=true; row.uploadedAt=new Date().toISOString(); await this.put('syncOutbox',row);
      }
      return rows.length;
    }
    async listRemoteOperations() {
      const files=[]; let pageToken='';
      do {
        const params=new URLSearchParams({q:`name contains '${PREFIX}' and trashed = false`,pageSize:'1000',orderBy:'createdTime',fields:'nextPageToken,files(id,name,createdTime)'});
        if(pageToken) params.set('pageToken',pageToken);
        const response=await this.api(`https://www.googleapis.com/drive/v3/files?${params}`); const data=await response.json();
        files.push(...(data.files||[])); pageToken=data.nextPageToken||'';
      } while(pageToken);
      return files;
    }
    async applyOperation(op) {
      if(!op?.id||!DATA_STORES.includes(op.store)) return false;
      if(await this.one('syncApplied',op.id)) return false;
      const store=op.store;
      if(store==='stockMovements'){
        const movement=op.record; const existing=await this.one(store,movement.id);
        if(!existing){
          const item=await this.one('inventory',movement.inventoryId);
          if(!item) return false; // Retry after its inventory record arrives.
          await this.tx(['inventory','stockMovements','syncApplied','syncMeta'],'readwrite',tx=>{
            const current=tx.objectStore('inventory').get(movement.inventoryId);
            current.onsuccess=()=>{const itemNow=current.result;if(!itemNow) return; if(!op.historical) itemNow.quantity=Number(itemNow.quantity||0)+Number(movement.delta||0); itemNow.updatedAt=new Date().toISOString();tx.objectStore('inventory').put(itemNow);tx.objectStore('stockMovements').put(movement);tx.objectStore('syncApplied').put({id:op.id,appliedAt:new Date().toISOString()});};
          });
        } else await this.put('syncApplied',{id:op.id,appliedAt:new Date().toISOString()});
        return true;
      }
      const key=store==='settings'?op.record.key:op.record.id;
      const current=await this.one(store,key);
      const incomingHash=hash(cleanRecord(store,op.record));
      if(current){
        const currentHash=hash(cleanRecord(store,current));
        if(currentHash===incomingHash){await this.meta(`baseline:${store}:${key}`,incomingHash);await this.put('syncApplied',{id:op.id,appliedAt:new Date().toISOString()});return true;}
        if(op.baseHash && currentHash!==op.baseHash){
          await this.put('syncConflicts',{id:op.id,operationId:op.id,store,recordId:key,localRecord:current,remoteRecord:op.record,detectedAt:new Date().toISOString(),status:'unresolved'});
          await this.put('syncApplied',{id:op.id,appliedAt:new Date().toISOString(),conflict:true}); return true;
        }
        if(!op.baseHash){
          await this.put('syncConflicts',{id:op.id,operationId:op.id,store,recordId:key,localRecord:current,remoteRecord:op.record,detectedAt:new Date().toISOString(),status:'unresolved'});
          await this.put('syncApplied',{id:op.id,appliedAt:new Date().toISOString(),conflict:true}); return true;
        }
      }
      let recordToSave=op.record;
      if(store==='inventory') recordToSave=current?{...current,...op.record,quantity:Number(current.quantity||0)}:{...op.record,quantity:Number(op.initialQuantity||0)};
      else if(current) recordToSave={...current,...op.record};
      await this.put(store,recordToSave);
      await this.meta(`baseline:${store}:${key}`,incomingHash);
      await this.put('syncApplied',{id:op.id,appliedAt:new Date().toISOString()});
      return true;
    }
    async downloadAndApply() {
      const files=await this.listRemoteOperations(); let applied=0;
      const operations=[];
      for(const file of files){
        const opId=file.name.slice(PREFIX.length).replace(/\.json$/,'');
        if(!opId||await this.one('syncApplied',opId)) continue;
        const response=await this.api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
        operations.push(await response.json());
      }
      operations.sort((a,b)=>((a.store==='inventory'?0:a.store==='stockMovements'?2:1)-(b.store==='inventory'?0:b.store==='stockMovements'?2:1))||String(a.createdAt).localeCompare(String(b.createdAt)));
      for(const op of operations) if(await this.applyOperation(op)) applied++;
      return applied;
    }
    async status(extra='') {
      const pending=(await this.all('syncOutbox')).filter(x=>!x.uploaded).length;
      const conflicts=(await this.all('syncConflicts')).filter(x=>x.status==='unresolved').length;
      const base=extra|| (pending?`${pending} change(s) waiting to sync`:'All changes synchronized');
      const text=conflicts?`${base} · ${conflicts} conflict(s) need review`:base;
      this.setStatus({text,pending,conflicts});
    }
    async sync() {
      if(this.running){this.rerunRequested=true;return;}
      if(!navigator.onLine||!this.getToken()) return;
      this.running=true;
      try{
        this.setStatus({text:'Checking shared records…',pending:0,conflicts:0});
        const manifest=await this.ensureManifest();
        const owner=manifest.ownerDeviceId||'';
        const nextRole=owner===this.deviceId?'shop-writer':'read-only';
        const roleChanged=this.role!==nextRole;
        this.role=nextRole;
        await this.meta('deviceRole',this.role);
        if(roleChanged&&this.onRole) this.onRole(this.role);
        // Only the device that first establishes the shared workspace seeds its existing local data.
        const seeded=await this.meta('initialSeedComplete');
        if(owner===this.deviceId&&!seeded){await this.seedCurrentDatabase();await this.meta('initialSeedComplete',true);}
        if(owner!==this.deviceId&&!seeded){
          const localSets=await Promise.all(['customers','inventory','services','bills','payments','stockMovements'].map(store=>this.all(store)));
          if(localSets.some(rows=>rows.length)){
            this.setStatus({text:'Sync paused: this device already has local records. Use an empty second-device database to avoid merging two independent starting copies.',pending:(await this.all('syncOutbox')).filter(row=>!row.uploaded).length,conflicts:0});
            return;
          }
          await this.meta('initialSeedComplete',true);
        }
        // Pull first on secondary devices. This prevents their pre-existing local copy from
        // being uploaded as a competing first version before the shop tablet's seed arrives.
        let applied=await this.downloadAndApply();
        await this.captureLocalChanges();
        await this.uploadOutbox();
        applied += await this.downloadAndApply();
        if(applied&&this.onApplied) await this.onApplied();
        await this.status(applied?`Synchronized · ${applied} incoming change(s) applied`:'');
        this.lastError='';
      }catch(error){this.lastError=error.message||'Synchronization failed';await this.status(`Sync error: ${this.lastError}`);}
      finally{this.running=false;if(this.rerunRequested){this.rerunRequested=false;setTimeout(()=>this.sync(),0);}}
    }
    start(){
      this.sync();
      if(this.timer) clearInterval(this.timer);
      this.timer=setInterval(()=>this.sync(),30000);
      if(!this.started){window.addEventListener('online',()=>this.sync());this.started=true;}
    }
    stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  }
  window.WorkshopDriveSync={DriveRecordSync,DATA_STORES,SYNC_STORES,hash,cleanRecord};
})();
