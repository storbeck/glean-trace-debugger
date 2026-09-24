import {debugUrl, extractSpans, mergeSpans, parseBodies, redact} from './trace.js';

const MAX_BODY=12*1024*1024, MAX_CAPTURE=6*1024*1024;
let current=null, starting=false, ready, saveChain=Promise.resolve();
const requests=new Map();
function save() {
  const snapshot=structuredClone(current);
  saveChain=saveChain.catch(()=>{}).then(()=>chrome.storage.session.set({capture:snapshot}));
  return saveChain;
}
async function init() {
  if(!ready) ready=(async()=>{
    current=(await chrome.storage.session.get('capture')).capture ?? null;
    if(current?.state==='capturing') {
      // A browser/service-worker interruption must not silently strand a collector.
      const tabId=current.collectorTabId;
      current.state='interrupted'; current.message='Capture was interrupted. Retry to collect again.';
      current.collectorTabId=null;
      if(tabId) {await chrome.debugger.detach({tabId}).catch(()=>{}); await chrome.tabs.remove(tabId).catch(()=>{});}
      await save();
    }
  })();
  return ready;
}
function note(c, message) {
  c.diagnostics.push({at:Date.now(),message});
  if(c.diagnostics.length>100)c.diagnostics.shift();
}
async function finish(c, state, message) {
  if(c!==current || c.state!=='capturing')return;
  c.state=state; c.message=message; c.finishedAt=Date.now();
  clearTimeout(captureTimer); clearInterval(quietTimer);
  await chrome.alarms.clear('capture-deadline');
  const tabId=c.collectorTabId; c.collectorTabId=null; requests.clear();
  await save();
  if(tabId) {
    await chrome.debugger.detach({tabId}).catch(()=>{});
    await chrome.tabs.remove(tabId).catch(()=>{});
  }
}
let captureTimer,quietTimer;
async function start(sourceUrl, sourceTabId, openViewer=true) {
  await init();
  if(starting)throw new Error('A capture is already starting.');
  starting=true;
  try {
    const url=debugUrl(sourceUrl);
    if(current?.state==='capturing')await finish(current,'stopped','Stopped for a new capture.');
    const c=current={id:crypto.randomUUID(),sourceUrl,sourceTabId,chatId:new URL(url).pathname.split('/')[2],state:'capturing',message:'Opening the saved chat in debug mode…',startedAt:Date.now(),spans:[],diagnostics:[],responses:0,collectorTabId:null,revision:0};
    await save();
    if(openViewer) await chrome.windows.create({url:chrome.runtime.getURL(`viewer.html?id=${c.id}`),type:'popup',width:1440,height:930});
    try {
      const tab=await chrome.tabs.create({url:'about:blank',active:false});
      c.collectorTabId=tab.id; await save();
      await chrome.debugger.attach({tabId:tab.id},'1.3');
      await chrome.debugger.sendCommand({tabId:tab.id},'Network.enable',{maxTotalBufferSize:32*1024*1024,maxResourceBufferSize:MAX_BODY});
      // Register listeners at module scope, attach, and enable Network BEFORE navigation.
      await chrome.tabs.update(tab.id,{url,active:false});
      c.message='Reading trace responses. Your original chat stays unchanged.';
      await save();
      await chrome.alarms.create('capture-deadline',{when:Date.now()+90000});
      captureTimer=setTimeout(()=>finish(c,c.spans.length?'captured':'empty',c.spans.length?'Capture window ended; coverage is unverified.':'No supported trace payload found. Inspect diagnostics or import copied span attributes.'),90000);
      quietTimer=setInterval(()=>{
        if(c===current && c.state==='capturing' && c.spans.length && !c.manual && Date.now()-(c.lastSpanAt||Date.now())>8000 && !c.pendingBodies) {
          finish(c,'captured','Captured available spans. Coverage is unverified; lazy-loaded details may need another capture.');
        }
      },1000);
      return c.id;
    }catch(e){await finish(c,'error',e.message); return c.id;}
  }finally{starting=false;}
}

function allowedResponse(url,sourceUrl) {
  try {const u=new URL(url),source=new URL(sourceUrl);return u.protocol==='https:' && (u.hostname===source.hostname || u.hostname.endsWith('.glean.com')) && !/\/(?:oauth|auth|login|config|token)(?:\/|$)/i.test(u.pathname);}catch{return false;}
}
function consume(c,text,path) {
  if(c!==current || c.state!=='capturing')return;
  if(text.length>MAX_BODY){note(c,`${path}: body exceeds the 12 MB capture limit.`);return;}
  const bodies=parseBodies(text);
  const candidates=bodies.flatMap(extractSpans);
  const spans=candidates.filter(s=>!s.chatId || s.chatId===c.chatId).map(s=>({...redact(s),endpoint:path}));
  if(!spans.length) {
    // Discovery evidence only: no unrelated response content or auth headers retained.
    const shape=bodies[0] && typeof bodies[0]==='object'?Object.keys(bodies[0]).slice(0,12).join(', '):'not JSON';
    if(bodies.length)note(c,`${path}: JSON keys [${shape}], no recognized spans.`);
    return;
  }
  const next=mergeSpans(c.spans,spans);
  if(new TextEncoder().encode(JSON.stringify(next)).length>MAX_CAPTURE) {
    note(c,'Trace data exceeds the 6 MB session limit. Retained earlier spans; this capture is partial.');
    void finish(c,'partial','Capture limit reached. Export this partial capture before starting another.');return;
  }
  c.spans=next; c.revision++; c.lastSpanAt=Date.now();
  c.message=`Captured ${next.length} spans. Waiting for additional trace details…`;
  note(c,`${path}: ${spans.length} recognized spans.`);
}

chrome.debugger.onEvent.addListener((source,method,p)=>{
  const c=current;
  if(!c || c.state!=='capturing' || source.tabId!==c.collectorTabId || source.sessionId)return;
  if(method==='Network.responseReceived') {
    if(['XHR','Fetch','EventSource'].includes(p.type) && allowedResponse(p.response.url,c.sourceUrl)) {
      const u=new URL(p.response.url);
      requests.set(p.requestId,{path:u.pathname,status:p.response.status,mime:p.response.mimeType});
      c.responses++;
      if(p.response.status>=400)note(c,`${u.pathname}: HTTP ${p.response.status}`);
    }
  }
  if(method==='Network.loadingFailed') {
    const r=requests.get(p.requestId);if(r){note(c,`${r.path}: ${p.errorText}`);requests.delete(p.requestId);void save();}
  }
  if(method==='Network.eventSourceMessageReceived') {
    const r=requests.get(p.requestId);if(r){consume(c,p.data,r.path);void save();}
  }
  if(method==='Network.loadingFinished') {
    const r=requests.get(p.requestId);if(!r)return;
    requests.delete(p.requestId);
    if(p.encodedDataLength>MAX_BODY){note(c,`${r.path}: response too large; skipped.`);void save();return;}
    c.pendingBodies=(c.pendingBodies||0)+1;
    chrome.debugger.sendCommand(source,'Network.getResponseBody',{requestId:p.requestId}).then(result=>{
      let body=result.body;
      if(result.base64Encoded)body=new TextDecoder().decode(Uint8Array.from(atob(body),x=>x.charCodeAt(0)));
      consume(c,body,r.path);
    }).catch(e=>note(c,`${r.path}: body unavailable (${e.message}).`)).finally(()=>{c.pendingBodies--;if(c===current)void save();});
  }
});
chrome.debugger.onDetach.addListener((source,reason)=>{
  if(current?.collectorTabId===source.tabId)void finish(current,'interrupted',`Debugger detached (${reason}). Captured data is still available.`);
});
chrome.tabs.onRemoved.addListener(tabId=>{
  if(current?.collectorTabId===tabId)void finish(current,'interrupted','Collector was closed. Captured data is still available.');
});
chrome.alarms.onAlarm.addListener(async alarm=>{
  if(alarm.name!=='capture-deadline')return;await init();
  if(current?.state==='capturing')await finish(current,current.spans.length?'captured':'empty','Capture window ended; coverage is unverified.');
});
chrome.action.onClicked.addListener(async tab=>{
  try{await start(tab.url,tab.id);}catch(e){
    await chrome.storage.session.set({launchError:e.message});
    await chrome.windows.create({url:chrome.runtime.getURL('viewer.html?error=1'),type:'popup',width:1100,height:780});
  }
});
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(sender.id!==chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('viewer.html')))return false;
  (async()=>{
    await init();
    if(msg.type==='get')return {capture:current,error:(await chrome.storage.session.get('launchError')).launchError};
    if(!current || (msg.id && msg.id!==current.id))throw new Error('This capture has been replaced. Use the latest debugger window.');
    if(msg.type==='stop'){await finish(current,'stopped','Capture stopped. Coverage is unverified.');return {};}
    if(msg.type==='source'){
      if(!current.collectorTabId)throw new Error('Retry capture, then open the collector while capture is running.');
      current.manual=true;
      const t=await chrome.tabs.update(current.collectorTabId,{active:true});await chrome.windows.update(t.windowId,{focused:true});await save();return {};
    }
    if(msg.type==='retry')return {id:await start(current.sourceUrl,current.sourceTabId,false)};
    if(msg.type==='clear'){
      if(current.state==='capturing')await finish(current,'stopped','Cleared.');
      current=null;await save();return {};
    }
    throw new Error('Unknown command.');
  })().then(reply).catch(e=>reply({error:e.message}));
  return true;
});
