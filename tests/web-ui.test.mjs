import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Drive the real result-page renderer and timer. This small DOM adapter models
// innerHTML replacing nodes; browser verification covers native scrolling.
const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
function harness(){
 const nodes=new Map(),timers=new Map();let serial=0,response,fetcher;
 const app={dataset:{},panels:[],html:'',
  set innerHTML(html){
   this.html=html;this.panels=[];nodes.clear();
   for(const match of html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)){
    const attrs=match[1],body=match[2],label=body.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];
    const scrollables=[...body.matchAll(/<pre\b|<div class="table-wrap"/g)].map(()=>({scrollTop:0,scrollLeft:0}));
    this.panels.push({dataset:{runPanel:attrs.match(/data-run-panel="([^"]+)"/)?.[1]},open:/\bopen\b/.test(attrs),label,
     querySelector:selector=>selector==='summary'?{textContent:label}:null,
     querySelectorAll:()=>scrollables,scrollables});
   }
   for(const match of html.matchAll(/<(button|input|select)\b[^>]*id="([^"]+)"[^>]*>/g))nodes.set('#'+match[2],{value:match[2]==='result-state'?'all':''});
   // Replacing a long open panel can clamp the page offset in the browser.
   if(!this.panels.some(p=>p.open))window.scrollY=0;
  },get innerHTML(){return this.html;},
  querySelectorAll:selector=>selector==='[data-run-panel]'?app.panels.filter(p=>p.dataset.runPanel):selector==='details'?app.panels:[],
 };
 const outside=new Map(['#close-detail','#connection','#toast'].map(id=>[id,{}]));
 const document={querySelector:selector=>selector==='#app'?app:nodes.get(selector)??outside.get(selector)??null,querySelectorAll:()=>[]};
 const window={scrollX:0,scrollY:0,scrollTo(x,y){this.scrollX=x;this.scrollY=y;},addEventListener(){}};
 const location={hash:'#run/fixture'};
 const context=vm.createContext({document,window,location,console,setTimeout(){},setInterval(fn){timers.set(++serial,fn);return serial;},clearInterval(id){timers.delete(id);},
  fetch:async()=>({ok:true,json:async()=>fetcher?fetcher():structuredClone(response)})});
 // Suppress only the bootstrap navigation; all renderer/event code is unchanged.
 vm.runInContext(source.replace(/window\.addEventListener\('hashchange',route\);route\(\);\s*$/,"globalThis.ui={runPage};"),context);
 response={status:'running',config:{suite:'emotion',analyzer_version:'emotion-v3.0.0',selected_case_ids:['ONE','TWO']},progress:{finished:0,total:2},summary:{},cases:[]};
 return {app,window,location,nodes,timers,get response(){return response;},set response(value){response=value;},set fetcher(fn){fetcher=fn;},
  render:()=>context.ui.runPage(location.hash.slice(5)),
  panel:label=>app.panels.find(p=>p.label===label),
  async poll(){for(const fn of timers.values())fn();await new Promise(resolve=>setImmediate(resolve));},
 };
}

test('polling preserves an expanded run configuration while updating progress',async()=>{
 const h=harness();await h.render();h.panel('完整运行配置').open=true;
 h.window.scrollY=2300;h.panel('完整运行配置').scrollables[0].scrollTop=480;
 h.panel('完整运行配置').scrollables[0].scrollLeft=72;h.response.progress.finished=1;
 await h.poll();
 assert.match(h.app.innerHTML,/1 \/ 2 条已结算/,'progress must still update');
 assert.equal(h.panel('完整运行配置').open,true,'config must stay expanded after polling');
 assert.equal(h.window.scrollY,2300,'page reading position must survive replacement');
 assert.equal(h.panel('完整运行配置').scrollables[0].scrollTop,480,'JSON reading position must survive replacement');
 assert.equal(h.panel('完整运行配置').scrollables[0].scrollLeft,72);
});

test('explicitly closed panels stay closed independently of other open panels',async()=>{
 const h=harness();await h.render();h.panel('完整运行配置').open=true;
 h.panel('全部指标与评分覆盖').open=true;await h.poll();
 h.panel('完整运行配置').open=false;await h.poll();
 assert.equal(h.panel('完整运行配置').open,false);
 assert.equal(h.panel('全部指标与评分覆盖').open,true);
});

test('a toggle and scroll during an in-flight poll are captured at render time',async()=>{
 const h=harness();await h.render();h.panel('完整运行配置').open=true;
 let release;h.fetcher=()=>new Promise(resolve=>{release=resolve;});
 const pending=h.render();await new Promise(resolve=>setImmediate(resolve));
 h.panel('完整运行配置').open=false;h.panel('全部指标与评分覆盖').open=true;
 h.panel('全部指标与评分覆盖').scrollables[0].scrollTop=300;h.window.scrollY=900;
 release(structuredClone(h.response));await pending;
 assert.equal(h.panel('完整运行配置').open,false);
 assert.equal(h.panel('全部指标与评分覆盖').open,true);
 assert.equal(h.panel('全部指标与评分覆盖').scrollables[0].scrollTop,300);
 assert.equal(h.window.scrollY,900);
});

test('completion can insert metric panels without moving saved state to the wrong panel',async()=>{
 const h=harness();await h.render();h.panel('完整运行配置').open=true;
 h.panel('全部指标与评分覆盖').open=true;
 h.response.status='completed';h.response.summary.metrics={sentiment:{per_label:{}},assessment_status:{per_label:{}}};
 await h.poll();
 assert.equal(h.panel('完整运行配置').open,true);
 assert.equal(h.panel('全部指标与评分覆盖').open,true);
 assert.equal(h.panel('判定状态 · 待补充信息').open,false);
 assert.equal(h.panel('Sentiment 各标签 · 含 negative 转人工误报 / 漏报').open,false);
 assert.equal(h.timers.size,0,'completed runs stop polling');
});

test('filtering and paging completed results preserve expanded configuration',async()=>{
 const h=harness();h.response.status='completed';
 h.response.cases=Array.from({length:81},(_,i)=>({case_id:'CASE-'+i,execution_status:'completed'}));
 await h.render();h.panel('完整运行配置').open=true;
 h.nodes.get('#result-next').onclick();await new Promise(resolve=>setImmediate(resolve));
 assert.match(h.app.innerHTML,/41–80 \/ 81/);assert.equal(h.panel('完整运行配置').open,true);
 h.nodes.get('#result-search').value='CASE-80';h.nodes.get('#filter-results').onclick();
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(h.app.innerHTML,/1–1 \/ 1/);assert.equal(h.panel('完整运行配置').open,true);
});

test('opening a different run does not inherit panel state or reading position',async()=>{
 const h=harness();await h.render();h.panel('完整运行配置').open=true;
 h.window.scrollY=1200;h.location.hash='#run/other';h.window.scrollY=0;await h.render();
 assert.equal(h.panel('完整运行配置').open,false);assert.equal(h.window.scrollY,0);
});

test('a late result response cannot replace the page after navigation',async()=>{
 const h=harness();await h.render();const html=h.app.innerHTML;
 let release;h.fetcher=()=>new Promise(resolve=>{release=resolve;});
 const pending=h.render();await new Promise(resolve=>setImmediate(resolve));
 h.location.hash='#history';h.window.scrollY=0;release(structuredClone(h.response));await pending;
 assert.equal(h.app.innerHTML,html);assert.equal(h.window.scrollY,0);
});
