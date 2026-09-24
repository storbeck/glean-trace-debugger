import {extractSpans, orderedSpans, parseBodies, redact} from './trace.js';
import {demoPayload} from './demo.js';

const $=id=>document.getElementById(id), extension=Boolean(globalThis.chrome?.runtime?.id);
let capture=null,selected=null,activeTab='input',collapsed=new Set(),local=false,lastRevision='',busy=false;
const params=new URLSearchParams(location.search); let captureId=params.get('id');
function el(tag,cls,text) {const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function duration(ms) {return !Number.isFinite(ms)?'—':ms<1000?`${Math.round(ms)}ms`:`${(ms/1000).toFixed(2)}s`;}
function spanDuration(s){return s.endTimeMs!=null&&s.startTimeMs!=null&&s.endTimeMs>=s.startTimeMs?s.endTimeMs-s.startTimeMs:undefined;}
function showError(message){$('notice').textContent=message;$('notice').hidden=!message;}
async function command(type) {
  const result=await chrome.runtime.sendMessage({type,id:captureId});
  if(result?.error)throw new Error(result.error);return result;
}
async function run(action){try{showError('');await action();}catch(e){showError(e.message);}}
function activeSpans(){return (capture?.spans||[]).filter(s=>!$('trace-select').value||s.traceId===$('trace-select').value);}
function bounds(spans){
  const timed=spans.filter(s=>spanDuration(s)!==undefined);
  if(!timed.length)return {start:0,end:0,total:0};
  const start=Math.min(...timed.map(s=>s.startTimeMs)),end=Math.max(...timed.map(s=>s.endTimeMs));
  return {start,end,total:end-start};
}
function renderTraceOptions(){
  const select=$('trace-select'),previous=select.value;
  select.replaceChildren(new Option('All traces',''));
  for(const id of new Set((capture?.spans||[]).map(s=>s.traceId)))select.add(new Option(id==='sample-trace'?'Sample run':`${id.slice(0,12)}…`,id));
  if([...select.options].some(o=>o.value===previous))select.value=previous;
}
function render() {
  const spans=capture?.spans||[];
  $('context').textContent=capture?.demo?'SAMPLE / SYNTHETIC DATA':capture?.imported?'IMPORTED / LOCAL TRACE':capture?.chatId?`GLEAN / ${capture.chatId}`:'EXECUTION / WAITING';
  const root=orderedSpans(spans)[0];
  $('run-title').textContent=capture?.title || root?.name || (capture?.state==='capturing'?'Opening the trace…':'Follow every step.');
  $('subtitle').textContent=capture?.demo?'A synthetic run with parallel tool calls. No live Glean data.':spans.length?'Inspect the sequence, timing, and payload of each captured operation.':'Open a saved Glean chat and click the extension to inspect its execution.';
  $('state').textContent=(capture?.state||'ready').toUpperCase();$('state').dataset.state=capture?.state||'ready';
  $('status').textContent=capture?.message||'No capture loaded.';
  const live=extension && !local && !!capture;
  $('stop').hidden=!live||capture.state!=='capturing';$('collector').hidden=!live||capture.state!=='capturing';
  $('retry').hidden=!live||capture.state==='capturing';$('clear').hidden=!capture;
  $('export').disabled=!spans.length;
  $('diagnostic-count').textContent=`${capture?.responses||0} responses · ${capture?.diagnostics?.length||0} events`;
  $('diagnostic-log').textContent=capture?.diagnostics?.map(d=>`${new Date(d.at).toLocaleTimeString()}  ${d.message}`).join('\n') || 'No events.';
  renderTraceOptions();renderTimeline();renderDetail();
}
function renderTimeline() {
  const spans=activeSpans(),b=bounds(spans), ordered=orderedSpans(spans), byKey=new Map(ordered.map(s=>[s.key,s]));
  const query=$('search').value.trim().toLowerCase(),kind=$('kind').value,errorsOnly=$('error-only').checked;
  const filtering=Boolean(query||kind||errorsOnly);
  const rows=ordered.filter(s=>{
    if(query&&!`${s.name} ${s.spanId}`.toLowerCase().includes(query))return false;
    if(kind&&s.kind!==kind)return false;
    if(errorsOnly&&s.status!=='error')return false;
    if(!filtering){let p=byKey.get(`${s.traceId}:${s.parentSpanId}`),seen=new Set();while(p&&!seen.has(p.key)){if(collapsed.has(p.key))return false;seen.add(p.key);p=byKey.get(`${p.traceId}:${p.parentSpanId}`);}}
    return true;
  });
  $('duration').textContent=b.total||spans.some(s=>spanDuration(s)===0)?duration(b.total):'—';
  $('count').textContent=spans.length||'—';$('errors').textContent=spans.length?spans.filter(s=>s.status==='error').length:'—';
  const timeline=$('timeline');timeline.replaceChildren();
  timeline.style.width=`${Number($('zoom').value)*100}%`;
  $('timeline-scroll').hidden=!rows.length;$('empty').hidden=Boolean(rows.length);
  if(!rows.length){
    $('empty').querySelector('h2').textContent=spans.length?'No matching spans.':capture?.state==='capturing'?'Listening for the trace…':capture?.state==='empty'?'Trace format not recognized.':'Your execution, unpacked.';
    $('empty').querySelector('p').textContent=spans.length?'Adjust your search or filters to see more of this run.':capture?.state==='empty'?'Check capture diagnostics. You can also import All Attributes copied from a Glean span.':'Model calls, tools, and their payloads belong together. Capture a chat or import a trace to begin.';
    $('demo').hidden=Boolean(spans.length)||capture?.state==='capturing';
  }
  const axis=el('div','axis'),label=el('div','axis-label');label.append(el('span','','OPERATION'),el('span','','DURATION'));
  const ticks=el('div','ticks');for(let i=0;i<5;i++)ticks.append(el('span','',b.total?duration(b.total*i/4):'—'));axis.append(label,ticks);timeline.append(axis);
  for(const s of rows){
    const row=el('div',`span-row${selected===s.key?' selected':''}`);row.setAttribute('role','listitem');
    const name=el('div','span-label');name.style.paddingLeft=`${8+Math.min(s.depth,12)*12}px`;
    if(s.hasChildren){const fold=el('button','fold',collapsed.has(s.key)?'›':'⌄');fold.setAttribute('aria-label',`${collapsed.has(s.key)?'Expand':'Collapse'} ${s.name}`);fold.setAttribute('aria-expanded',String(!collapsed.has(s.key)));fold.onclick=()=>{collapsed.has(s.key)?collapsed.delete(s.key):collapsed.add(s.key);renderTimeline();};name.append(fold);}else name.append(el('span','fold-placeholder'));
    name.append(el('i',`kind-dot ${s.kind}`));
    const button=el('button','select-span',s.name);button.title=s.name;button.setAttribute('aria-label',`${s.name}, ${duration(spanDuration(s))}, ${s.status}`);button.onclick=()=>choose(s.key);name.append(button);
    if(s.status==='error'){const err=el('span','error-dot','!');err.title='Error';name.append(err);}
    name.append(el('span','span-duration',duration(spanDuration(s))));
    const cell=el('div','bar-cell'),track=el('div','bar-track');
    if(spanDuration(s)!==undefined){
      const bar=el('button',`bar ${s.kind}${s.status==='error'?' error':''}`);bar.style.left=`${b.total?Math.max(0,(s.startTimeMs-b.start)/b.total*100):0}%`;bar.style.width=`${b.total?spanDuration(s)/b.total*100:0}%`;
      bar.title=`${s.name} · ${duration(spanDuration(s))} · +${duration(s.startTimeMs-b.start)}`;bar.setAttribute('aria-label',`Inspect ${s.name}`);bar.tabIndex=-1;bar.onclick=()=>choose(s.key);track.append(bar);
    }else track.append(el('span','unknown-timing','Timing unavailable'));
    cell.append(track);row.append(name,cell);timeline.append(row);
  }
  $('coverage').textContent=`${rows.length} / ${spans.length} spans · ${spans.filter(s=>spanDuration(s)===undefined).length} untimed`;
}
function choose(key){selected=key;renderTimeline();renderDetail();}
function payloadValue(s){return activeTab==='raw'?s.raw:s[activeTab];}
function pretty(value){if(typeof value==='string'){try{return JSON.stringify(JSON.parse(value),null,2);}catch{return value;}}return JSON.stringify(value,null,2);}
function renderDetail(){
  const s=capture?.spans?.find(s=>s.key===selected);
  $('span-name').textContent=s?.name||'Select a step';
  $('span-meta').textContent=s?`${s.kind.toUpperCase()}  /  ${duration(spanDuration(s))}  /  ${s.status.toUpperCase()}`:'Explore the input, output, and context of any operation.';
  if(s?.model)$('span-meta').append(el('div','',s.model));
  if(s?.inputTokens!=null||s?.outputTokens!=null)$('span-meta').append(el('div','',`${s.inputTokens??'—'} input / ${s.outputTokens??'—'} output tokens`));
  if(s?.credits!=null)$('span-meta').append(el('div','',`${s.credits} credits`));
  $('span-identity').replaceChildren();
  if(s){$('span-identity').append(el('div','',`TRACE  ${s.traceId}`),el('div','',`SPAN   ${s.spanId}`));if(s.parentSpanId)$('span-identity').append(el('div','',`PARENT ${s.parentSpanId}`));if(s.startTimeMs!==undefined)$('span-identity').append(el('div','',`START  ${s.startTimeMs} ms`));}
  const value=s?payloadValue(s):undefined;
  $('payload-label').textContent=s?`${activeTab.toUpperCase()} / ${value===undefined?'NOT EXPOSED':'JSON / TEXT'}`:'NO SPAN SELECTED';
  $('payload').textContent=!s?'Select a span in the waterfall.':value===undefined?`No ${activeTab} field was recognized for this span. Check Attributes and Raw for fields specific to this Glean version.`:pretty(value);
  $('copy').disabled=value===undefined;
  $('payload').setAttribute('aria-labelledby',`tab-${activeTab}`);
  document.querySelectorAll('[data-tab]').forEach(b=>{b.setAttribute('aria-selected',String(b.dataset.tab===activeTab));b.tabIndex=b.dataset.tab===activeTab?0:-1;});
}
async function refresh(){
  if(!extension||local||busy)return;busy=true;
  try{
    const result=await chrome.runtime.sendMessage({type:'get'});
    if(params.has('error')){showError(result.error||'Could not start capture.');return;}
    if(captureId && result.capture?.id!==captureId){showError('This capture was cleared or replaced. Use the latest debugger window or import an export.');return;}
    const c=result.capture,revision=JSON.stringify([c?.id,c?.state,c?.revision,c?.message,c?.diagnostics?.length,c?.responses]);
    if(revision===lastRevision)return;lastRevision=revision;capture=c;
    if(!selected||!c?.spans?.some(s=>s.key===selected))selected=c?.spans?.[0]?.key||null;
    render();
  }catch(e){showError(e.message);}finally{busy=false;}
}
function loadLocal(payload,demo=false){
  const spans=parseBodies(payload).flatMap(extractSpans);
  if(!spans.length)throw new Error('No recognized spans. Import the complete trace JSON or a span’s All Attributes section.');
  if(spans.length>5000)throw new Error('This viewer supports up to 5,000 imported spans. Split the trace into smaller runs.');
  local=true;lastRevision='';collapsed.clear();selected=spans[0].key;
  capture={spans:redact(spans),state:demo?'sample':'imported',demo,imported:!demo,message:demo?'Synthetic sample — this is not a captured Glean execution.':'Imported locally. Trace completeness has not been verified.',title:demo?'Portfolio assistant':undefined};
  $('trace-select').value='';$('search').value='';$('kind').value='';$('error-only').checked=false;render();
}
$('search').oninput=renderTimeline;$('kind').onchange=renderTimeline;$('error-only').onchange=renderTimeline;$('trace-select').onchange=renderTimeline;$('zoom').oninput=renderTimeline;
$('expand').onclick=()=>{collapsed.clear();renderTimeline();};
document.querySelectorAll('[data-tab]').forEach(b=>{b.onclick=()=>{activeTab=b.dataset.tab;renderDetail();};b.onkeydown=e=>{const list=[...document.querySelectorAll('[data-tab]')],index=list.indexOf(b);let target;if(e.key==='ArrowRight')target=list[(index+1)%list.length];if(e.key==='ArrowLeft')target=list[(index+list.length-1)%list.length];if(e.key==='Home')target=list[0];if(e.key==='End')target=list.at(-1);if(target){e.preventDefault();target.click();target.focus();}};});
$('copy').onclick=()=>run(async()=>{await navigator.clipboard.writeText($('payload').textContent);$('copy').textContent='Copied';setTimeout(()=>$('copy').textContent='Copy',1500);});
$('stop').onclick=()=>run(async()=>{await command('stop');await refresh();});
$('collector').onclick=()=>run(()=>command('source'));
$('retry').onclick=()=>run(async()=>{const result=await command('retry');captureId=result.id;history.replaceState(null,'',`?id=${captureId}`);lastRevision='';await refresh();});
$('clear').onclick=()=>run(async()=>{if(!local&&extension)await command('clear');capture=null;selected=null;captureId=null;local=true;render();showError('');});
$('demo').onclick=()=>run(()=>loadLocal(JSON.stringify(demoPayload()),true));
$('import').onclick=()=>{$('import-error').textContent='';$('import-dialog').showModal();};
$('file').onchange=async()=>{try{const file=$('file').files[0];if(!file)return;if(file.size>12*1024*1024)throw new Error('File exceeds the 12 MB import limit.');$('import-text').value=await file.text();}catch(e){$('import-error').textContent=e.message;}};
$('load-import').onclick=()=>{try{if($('import-text').value.length>12*1024*1024)throw new Error('Pasted data exceeds the 12 MB limit.');loadLocal($('import-text').value);$('import-dialog').close();showError('');}catch(e){$('import-error').textContent=e.message;}};
$('export').onclick=()=>run(()=>{
  const data=redact({traceLensVersion:1,exportedAt:new Date().toISOString(),coverage:'unverified',sample:Boolean(capture.demo),spans:capture.spans.map(s=>s.raw)});
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const a=el('a');a.href=url;a.download=`trace-lens-${capture.demo?'sample':new Date().toISOString().slice(0,10)}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
render();
if(params.has('demo'))loadLocal(JSON.stringify(demoPayload()),true);
else if(extension){void refresh();setInterval(refresh,1500);}
