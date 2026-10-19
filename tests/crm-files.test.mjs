import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatRenderer} from '../web/road/chat-ui.js';
import {createDocument} from './helpers/dom.mjs';
import {receiveFile,modelSafe} from '../src/crm/files.mjs';
import {RoadStore} from '../src/road/store.mjs';

test('a requested photo presents a native file picker, not a base64 text box',()=>{
  const document=createDocument(),container=document.createElement('div');
  const state={status:'input',running:false,user:null,messages:[],plans:[],events:[],receipts:[],mock:{handoffs:[]},pendingInput:{id:'photo',kind:'file',question:'Choose the photo you want to attach.'}};
  createChatRenderer(document,container,{}).render(state,{locale:'en'});
  const form=container.children.find(n=>n.dataset.chatId==='input:photo').querySelector('form');
  assert.ok(form.querySelectorAll('input').some(n=>n.type==='file'));
  assert.equal(form.querySelectorAll('textarea').length,0);
  assert.match(form.textContent,/512/);
});
test('selected bytes are validated and private while their metadata is available for planning',()=>{
  const store=new RoadStore(),session=store.create(),base64=Buffer.from('real selected bytes').toString('base64');
  const file=receiveFile(session,{name:'evidence.txt',base64,media_type:'text/plain'});
  assert.equal(file.size,19);assert.equal(session.crmFiles[file.id].base64,base64);
  assert.equal(store.view(session).crmFiles,undefined);assert.deepEqual(store.view(session).facts.files,[file]);
  const observation=modelSafe({body:{AttachStream:base64},response:{AttachmentStream:base64},schema:{AttachStream:{type:'string',description:'File content'}}});
  assert.ok(!JSON.stringify(observation).includes(base64));assert.equal(observation.schema.AttachStream.type,'string');
  for(const value of [{name:'x',base64:''},{name:'x',base64:'not base64'},{name:'../x',base64},{name:'x',base64:Buffer.alloc(512*1024+1).toString('base64')}])assert.throws(()=>receiveFile(session,value));
  assert.equal(session.facts.files.length,1,'Invalid files do not become usable selections');
});
