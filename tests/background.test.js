import test from 'node:test';
import assert from 'node:assert/strict';
import {demoPayload} from '../extension/demo.js';

function event(){const callbacks=[];return {addListener:fn=>callbacks.push(fn),fire:(...args)=>Promise.all(callbacks.map(fn=>fn(...args)))};}
async function setup({attachFails=false,initial=null}={}){
  const operations=[],storage={capture:initial};let nextTab=100;
  const runtime={id:'test-extension',getURL:path=>`chrome-extension://test-extension/${path}`,onMessage:event()};
  const debuggerAPI={onEvent:event(),onDetach:event(),attach:async target=>{operations.push(['attach',target]);if(attachFails)throw new Error('Host access is restricted by policy.');},detach:async target=>operations.push(['detach',target]),sendCommand:async(target,method)=>{operations.push([method,target]);return method==='Network.getResponseBody'?{body:JSON.stringify(demoPayload()),base64Encoded:false}:{};}};
  const chrome=globalThis.chrome={runtime,debugger:debuggerAPI,storage:{session:{get:async key=>({[key]:structuredClone(storage[key])}),set:async value=>Object.assign(storage,structuredClone(value))}},windows:{create:async value=>operations.push(['window',value]),update:async()=>{}},tabs:{create:async value=>{operations.push(['create',value]);return {id:nextTab++};},update:async(id,value)=>{operations.push(['navigate',id,value]);return {id,windowId:1};},remove:async id=>operations.push(['remove',id]),onRemoved:event()},alarms:{create:async()=>{},clear:async()=>{},onAlarm:event()},action:{onClicked:event()}};
  await import(`../extension/background.js?test=${Math.random()}`);
  const send=message=>new Promise(resolve=>runtime.onMessage.fire(message,{id:runtime.id,url:runtime.getURL('viewer.html')},resolve));
  const click=()=>chrome.action.onClicked.fire({url:'https://app.glean.com/chat/chat-example?qe=https%3A%2F%2Ftenant-be.glean.com',id:8});
  return {chrome,storage,operations,send,click};
}
test('capture attaches before navigation and stopping closes only the owned collector',async()=>{
  const h=await setup();await h.click();
  const ops=h.operations.map(o=>o[0]);assert.ok(ops.indexOf('attach')<ops.indexOf('Network.enable'));assert.ok(ops.indexOf('Network.enable')<ops.indexOf('navigate'));
  const nav=h.operations.find(o=>o[0]==='navigate');assert.equal(nav[1],100);assert.match(nav[2].url,/debugMode=1/);assert.match(nav[2].url,/qe=/);
  await h.send({type:'stop'});assert.equal(h.storage.capture.state,'stopped');assert.ok(h.operations.some(o=>o[0]==='remove'&&o[1]===100));assert.ok(!h.operations.some(o=>o[0]==='remove'&&o[1]===8));
});
test('network events from other tabs/origins are ignored; Glean spans are ingested',async()=>{
  const h=await setup();await h.click();
  const response=(id,url)=>({requestId:id,type:'Fetch',response:{url,status:200,mimeType:'application/json'}});
  await h.chrome.debugger.onEvent.fire({tabId:8},'Network.responseReceived',response('outside','https://tenant-be.glean.com/trace'));
  await h.chrome.debugger.onEvent.fire({tabId:100},'Network.responseReceived',response('external','https://example.com/trace'));
  await h.chrome.debugger.onEvent.fire({tabId:100},'Network.responseReceived',response('auth','https://tenant-be.glean.com/oauth/token'));
  assert.equal((await h.send({type:'get'})).capture.responses,0);
  await h.chrome.debugger.onEvent.fire({tabId:100},'Network.responseReceived',response('trace','https://tenant-be.glean.com/trace?token=never-store'));
  await h.chrome.debugger.onEvent.fire({tabId:100},'Network.loadingFinished',{requestId:'trace',encodedDataLength:1000});
  await new Promise(resolve=>setImmediate(resolve));
  const {capture}=await h.send({type:'get'});assert.equal(capture.spans.length,14);assert.equal(capture.spans[0].endpoint,'/trace');assert.ok(!JSON.stringify(capture).includes('never-store'));
  await h.send({type:'stop'});
});
test('debugger permission/policy failure is visible and cleans up',async()=>{
  const h=await setup({attachFails:true});await h.click();assert.equal(h.storage.capture.state,'error');assert.match(h.storage.capture.message,/policy/);assert.equal(h.storage.capture.collectorTabId,null);assert.ok(h.operations.some(o=>o[0]==='remove'));
});
test('worker recovery marks interrupted capture and releases collector',async()=>{
  const h=await setup({initial:{id:'old',state:'capturing',collectorTabId:42,spans:[],diagnostics:[]}});
  const {capture}=await h.send({type:'get'});assert.equal(capture.state,'interrupted');assert.equal(capture.collectorTabId,null);assert.ok(h.operations.some(o=>o[0]==='remove'&&o[1]===42));
});
test('deadline produces an explicit empty result; retry creates a new capture',async()=>{
  const h=await setup();await h.click();const first=h.storage.capture.id;
  await h.chrome.alarms.onAlarm.fire({name:'capture-deadline'});assert.equal(h.storage.capture.state,'empty');
  const retried=await h.send({type:'retry',id:first});assert.notEqual(retried.id,first);assert.equal(h.storage.capture.state,'capturing');await h.send({type:'stop',id:retried.id});
});
