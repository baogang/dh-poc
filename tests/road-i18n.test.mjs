import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {translator,resolveLocale,UI_MESSAGES,uiError} from '../web/road/i18n.js';
import {progressText} from '../web/road/chat-ui.js';

test('every fixed Chinese UI literal has an English translation with matching placeholders',async()=>{
 for(const file of ['app.js','chat-ui.js','feedback-ui.js']){const source=await readFile(new URL('../web/road/'+file,import.meta.url),'utf8');for(const match of source.matchAll(/'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g))assert(Object.hasOwn(UI_MESSAGES.en,match[1]),file+': missing English copy for '+match[1]);}
 for(const [key,value]of Object.entries(UI_MESSAGES.en)){assert(value.trim(),key);const source=UI_MESSAGES.zh[key]??key,variables=s=>[...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();assert.deepEqual(variables(value),variables(source),key+' placeholders');}
 const t=translator('en');assert.equal(t('工单地址：{city}, {street}',{city:'الرياض',street:'原样 Road'}),'Ticket address: الرياض, 原样 Road');
});
test('locale preference and typed error rendering are independent of business data',()=>{
 assert.equal(resolveLocale('en','zh-CN'),'en');assert.equal(resolveLocale('zh','en-US'),'zh');assert.equal(resolveLocale(null,'en-US'),'en');assert.equal(resolveLocale('bad','ar-SA'),'zh');
 assert.equal(uiError({key:'这次请求没有完成：',code:'STALE_CONFIRMATION',detail:'旧服务错误文本'},'en'),'This request could not be completed: This confirmation has expired. Use the current confirmation card.');assert.equal(uiError(null,'en'),null);assert.equal(translator('zh')('notice.human.accepted'),'模拟人工客服已接入。你可以继续在聊天中补充情况。');
});
test('working progress is localized for FAQ, sentiment, every API operation and resume',()=>{
 const state=events=>({events});assert.match(progressText(state([{type:'turn_started',route:'faq_first'}]),'en'),/Checking the FAQ/);assert.match(progressText(state([{type:'emotion_started'}]),'en'),/Analyzing/);assert.match(progressText(state([{type:'turn_started',route:'resume'}]),'en'),/Continuing/);
 for(const operation of ['login','query_tickets','create_ticket','close_ticket','complain_ticket','handoff_to_human'])assert(!/[\u4e00-\u9fff]/.test(progressText(state([{type:'api_start',call:{operation}}]),'en')));
});
