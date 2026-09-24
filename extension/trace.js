// The span.gle mapping was verified in Glean's own attribute inspector.
// Envelope aliases support OTLP JSON and common trace exports; no endpoint is assumed.
export function debugUrl(source) {
  const u = new URL(source);
  if (u.protocol !== 'https:' || u.hostname !== 'app.glean.com' || !/^\/chat\/[\w-]+\/?$/.test(u.pathname) || /^\/chat\/(agents|new)\/?$/.test(u.pathname)) {
    throw new Error('Open a saved chat on app.glean.com, then click Trace Lens.');
  }
  u.searchParams.set('debugMode', '1');
  return u.href;
}

function decoded(value) {
  if (typeof value !== 'string' || !/^[\s]*[\[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
}
function typed(value) {
  if (!value || typeof value !== 'object') return decoded(value);
  for (const k of ['stringValue','intValue','doubleValue','boolValue']) if (k in value) return decoded(value[k]);
  if (value.kvlistValue) return attributes(value.kvlistValue.values);
  if (value.arrayValue) return (value.arrayValue.values || []).map(typed);
  return value;
}
function attributes(value) {
  value = decoded(value);
  if (Array.isArray(value)) return Object.fromEntries(value.filter(x=>x && typeof x.key === 'string').map(x=>[x.key,typed(x.value)]));
  return value && typeof value === 'object' ? value : {};
}
function time(ms, nano) {
  if (ms != null && ms !== '') { const n=Number(ms); return Number.isFinite(n)?n:undefined; }
  if (nano != null) { try { return Number(BigInt(nano)/1000000n); } catch { return undefined; } }
}
function normalize(node, inheritedTrace) {
  const attrs=attributes(node.attributes ?? node.tags ?? node);
  const gle=decoded(attrs['span.gle'] ?? node['span.gle']);
  const info=gle?.span_info ?? {};
  const ctx=gle?.context?.agent_trace ?? {};
  const id=ctx.span_id ?? node.spanId ?? node.span_id;
  const traceId=ctx.trace_id ?? node.traceId ?? node.trace_id ?? inheritedTrace;
  if (!id || (!gle && !node.name && !node.spanName && !node.span_name)) return null;
  const timing=info.start_end_timestamps ?? {};
  const start=time(timing.start_time_millis ?? node.startTimeMillis ?? node.start_time_millis, node.startTimeUnixNano);
  const end=time(timing.end_time_millis ?? node.endTimeMillis ?? node.end_time_millis, node.endTimeUnixNano);
  const action=gle?.action, llm=gle?.llm_call;
  let name=info.span_name ?? node.name ?? node.spanName ?? node.span_name ?? 'Unnamed span';
  if(name==='LLM Call' && llm?.provider_model)name+=`: ${llm.provider_model}${llm.reasoning_effort?` [${llm.reasoning_effort}]`:''}`;
  const type=String(info.type ?? node.kind ?? '').toLowerCase();
  const kind=/llm|model/.test(type+' '+name.toLowerCase())?'model':action || /action|tool/.test(type)?'tool':/retriev|search/.test(type)?'retrieval':/agent|workflow/.test(type+' '+name.toLowerCase())?'agent':'other';
  const statusCode=info.execution_status?.code ?? action?.execution_status ?? node.status?.code ?? attrs['status.code'];
  const status=['ERROR','FAILED','FAILURE',2].includes(statusCode)?'error':['OK','SUCCESS',1].includes(statusCode)?'ok':'unknown';
  const parent=ctx.parent_id ?? node.parentSpanId ?? node.parent_span_id ?? node.parentId;
  return {
    key:`${traceId ?? 'unassigned'}:${id}`, spanId:String(id), traceId:traceId?String(traceId):'unassigned',
    parentSpanId:parent?String(parent):undefined, externalParentId:ctx.external_parent_id,
    chatId:info.chat_session_id ?? attrs.chat_session_id,
    name, kind, status, startTimeMs:start, endTimeMs:end,
    input:action?.tool_call_arguments ?? node.input ?? attrs.input ?? llm?.input_messages ?? attrs['gen_ai.input.messages'] ?? attrs['input.value'],
    output:action?.tool_call_result ?? node.output ?? attrs.output ?? llm?.output_messages ?? attrs['gen_ai.output.messages'] ?? attrs['output.value'],
    model:llm?.provider_model ?? attrs.provider_model,
    inputTokens:llm?.input_tokens ?? attrs.input_tokens,
    outputTokens:llm?.output_tokens ?? attrs.output_tokens,
    credits:attrs['derived.credit_usage'],
    attributes:attrs, raw:node, source:'captured'
  };
}

export function extractSpans(payload) {
  const found=new Map(), visited=new WeakSet(); let budget=180000;
  function visit(value, depth=0, inheritedTrace) {
    if (--budget < 0 || depth > 35) return;
    value=decoded(value);
    if (!value || typeof value!=='object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) { for (const x of value) visit(x,depth+1,inheritedTrace); return; }
    const span=normalize(value,inheritedTrace);
    if(span) {
      const old=found.get(span.key);
      if(!old || JSON.stringify(span.raw).length>JSON.stringify(old.raw).length) found.set(span.key,span);
      for(const key of ['children','spans','childSpans']) if(value[key])visit(value[key],depth+1,span.traceId);
      return;
    }
    const trace=value.traceId ?? value.trace_id ?? inheritedTrace;
    // Do not mistake model/tool content for independent telemetry.
    for(const [k,v] of Object.entries(value)) if(!['input','output','prompt','tool_call_result','tool_call_arguments'].includes(k)) visit(v,depth+1,trace);
  }
  visit(payload);
  return [...found.values()];
}

export function parseBodies(text) {
  try {return [JSON.parse(text)];} catch {}
  return text.split(/\r?\n/).map(line=>line.replace(/^data:\s*/, '')).filter(Boolean).flatMap(line=>{
    try{return [JSON.parse(line)];}catch{return [];}
  });
}

export function mergeSpans(existing, incoming) {
  const map=new Map(existing.map(x=>[x.key,x]));
  for(const next of incoming) {
    const old=map.get(next.key);
    map.set(next.key, old?{...old,...Object.fromEntries(Object.entries(next).filter(([,v])=>v!==undefined)),attributes:{...old.attributes,...next.attributes}}:next);
  }
  return [...map.values()];
}

export function orderedSpans(spans) {
  const keys=new Set(spans.map(s=>s.key)), children=new Map(), roots=[];
  for(const s of spans) {
    const parent=`${s.traceId}:${s.parentSpanId}`;
    if(s.parentSpanId && keys.has(parent) && parent!==s.key) {
      if(!children.has(parent)) children.set(parent,[]); children.get(parent).push(s);
    }else roots.push(s);
  }
  const sort=(a,b)=>(a.startTimeMs??Infinity)-(b.startTimeMs??Infinity);
  const result=[], seen=new Set();
  function walk(s,depth) {if(seen.has(s.key))return; seen.add(s.key); result.push({...s,depth,hasChildren:children.has(s.key)}); for(const c of (children.get(s.key)||[]).sort(sort))walk(c,depth+1);}
  roots.sort(sort).forEach(s=>walk(s,0));
  spans.forEach(s=>walk(s,0)); // Malformed/cyclic parents remain inspectable.
  return result;
}

export function redact(value) {
  const secrets=/^(authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|password|session_tracking_token|user_id|prompt_cache_key|EncryptedReasoning|CompactionEncryptedContent)$/i;
  if(Array.isArray(value))return value.map(redact);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,secrets.test(k)?'[redacted]':redact(v)]));
  if(typeof value==='string') {const d=decoded(value); if(d!==value)return JSON.stringify(redact(d));}
  return value;
}
