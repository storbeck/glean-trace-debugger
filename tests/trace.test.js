import test from 'node:test';
import assert from 'node:assert/strict';
import {debugUrl,extractSpans,mergeSpans,orderedSpans,parseBodies,redact} from '../extension/trace.js';
import {demoPayload} from '../extension/demo.js';

const gleanAttributes={
  'span.gle':{
    span_info:{span_name:'Execute Action: search_orders',type:'action',chat_session_id:'chat-example',execution_status:{code:'OK'},start_end_timestamps:{start_time_millis:'1790216269943',end_time_millis:'1790216344549'}},
    context:{agent_trace:{trace_id:'trace-example',span_id:'tool-span',parent_id:'parent-span'}},
    action:{tool_call_arguments:{risk_only:'true',limit:'100'},tool_call_result:{structuredContent:{result:{count:3}}}}
  }
};
test('debug URL preserves tenant query, hash, and sets flag idempotently',()=>{
  const source='https://app.glean.com/chat/abc?qe=https%3A%2F%2Facme-be.glean.com&debugMode=0#message';
  const url=new URL(debugUrl(source));
  assert.equal(url.searchParams.get('qe'),'https://acme-be.glean.com');assert.equal(url.hash,'#message');assert.equal(url.searchParams.get('debugMode'),'1');assert.equal(debugUrl(url.href),url.href);
  for(const u of ['https://app.glean.com.evil.test/chat/abc','https://evil.test/chat/abc','http://app.glean.com/chat/abc','https://app.glean.com/chat/agents?x=1','https://app.glean.com/']) {
    assert.throws(()=>debugUrl(u));
  }
});
test('observed Glean attributes retain real timestamps, parent and complete I/O',()=>{
  const [s]=extractSpans(gleanAttributes);assert.equal(s.name,'Execute Action: search_orders');assert.equal(s.kind,'tool');assert.equal(s.endTimeMs-s.startTimeMs,74606);assert.equal(s.traceId,'trace-example');assert.equal(s.parentSpanId,'parent-span');assert.equal(s.status,'ok');assert.deepEqual(s.input,{risk_only:'true',limit:'100'});assert.equal(s.output.structuredContent.result.count,3);
});
test('encoded span.gle inside OTLP attributes and envelopes is recognized',()=>{
  const [s]=extractSpans({resourceSpans:[{scopeSpans:[{spans:[{spanId:'tool-span',name:'tool',attributes:[{key:'span.gle',value:{stringValue:JSON.stringify(gleanAttributes['span.gle'])}}]}]}]}]});
  assert.equal(s.spanId,'tool-span');assert.equal(s.startTimeMs,1790216269943);
});
test('nanoseconds remain precise and missing timestamps are not invented',()=>{
  const [s,u]=extractSpans({spans:[{traceId:'t',spanId:'1',name:'a',startTimeUnixNano:'1790216269943123456',endTimeUnixNano:'1790216344549123456'},{traceId:'t',spanId:'2',name:'b'}]});
  assert.equal(s.startTimeMs,1790216269943);assert.equal(s.endTimeMs-s.startTimeMs,74606);assert.equal(u.startTimeMs,undefined);assert.equal(u.endTimeMs,undefined);
});
test('nested span children and multiple traces are preserved; tool data is not telemetry',()=>{
  const spans=extractSpans({traces:[{traceId:'t1',spans:[{spanId:'1',name:'root',children:[{spanId:'2',name:'child',parentSpanId:'1'}],output:{spanId:'fake',name:'content'}}]},{traceId:'t2',spans:[{spanId:'1',name:'different run'}]}]});
  assert.equal(spans.length,3);assert.equal(new Set(spans.map(s=>s.key)).size,3);
});
test('JSON, NDJSON and SSE bodies decode; unrelated responses do not create spans',()=>{
  assert.equal(parseBodies(JSON.stringify({spans:[]})).length,1);
  assert.equal(parseBodies('data: {"a":1}\n\ndata: [DONE]\n{"b":2}\n').length,2);
  assert.equal(extractSpans({config:{name:'agent'},messages:[{text:'spanId: fake'}]}).length,0);
});
test('merges lazy details without creating duplicate spans',()=>{
  const [s]=extractSpans(gleanAttributes);const shallow={...s,input:undefined,output:undefined};
  const result=mergeSpans([shallow],[s]);assert.equal(result.length,1);assert.equal(result[0].output.structuredContent.result.count,3);
  assert.deepEqual(mergeSpans(result,[shallow])[0].input,s.input);
});
test('ordering supports parallel calls, missing parents, and malformed cycles',()=>{
  const spans=extractSpans(demoPayload()),ordered=orderedSpans(spans);
  assert.equal(ordered.length,14);assert.equal(ordered[0].depth,0);
  assert.equal(ordered.find(s=>s.spanId==='11').depth,ordered.find(s=>s.spanId==='12').depth);
  const cycle=[{key:'t:a',traceId:'t',spanId:'a',parentSpanId:'b'},{key:'t:b',traceId:'t',spanId:'b',parentSpanId:'a'}];
  assert.equal(orderedSpans(cycle).length,2);
});
test('known credential fields are redacted in nested objects and JSON strings',()=>{
  const result=redact({authorization:'secret',input:JSON.stringify({api_key:'key',message:'keep'}),user_id:'private',ordinary:'keep'});
  assert.equal(result.authorization,'[redacted]');assert.equal(JSON.parse(result.input).api_key,'[redacted]');assert.equal(JSON.parse(result.input).message,'keep');assert.equal(result.ordinary,'keep');
});
