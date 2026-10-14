import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreRoadTools,summarizeRoadTools} from '../src/road/eval-metrics.mjs';
const event=name=>({type:'tool_start',name});
const reference=operations=>({expected:{operations}});
const row=(names,operations=names)=>({session:{events:names.map(event)},operations});
test('recall counts a missed required tool and precision counts an unexpected tool',()=>{
  const s=scoreRoadTools(reference(['query_tickets','close_ticket']),row(['query_tickets','complain_ticket']));
  assert.deepEqual(s.selection,{tp:1,fp:1,fn:1,precision:.5,recall:.5,f1:.5});assert.deepEqual(s.phases[0].missing,['close_ticket']);
});
test('repeated HITL tool attempts cannot inflate recall or type-level TP',()=>{
  const s=scoreRoadTools(reference(['create_ticket']),row(['create_ticket','create_ticket','create_ticket'],['create_ticket']));
  assert.equal(s.selection.tp,1);assert.equal(s.selection.recall,1);assert.equal(s.attempts.total,3);assert.equal(s.execution.tp,1);
});
test('pre-switch legitimate proposal is separate from the later query-only intent',()=>{
  const ref={interrupt:{message:'Instead show history'},expected:{operations:['query_tickets'],tool_phases:[{phase:'before_interrupt',operations:['create_ticket']},{phase:'after_interrupt',operations:['query_tickets']}]}};
  const s=scoreRoadTools(ref,{session:{events:[event('create_ticket'),{type:'message',message:{role:'user',text:'Instead show history'}},event('query_tickets')]},operations:['query_tickets']});
  assert.deepEqual(s.selection,{tp:2,fp:0,fn:0,precision:1,recall:1,f1:1});assert.equal(s.execution.tp,1);
  const unsafe=scoreRoadTools(ref,{session:{events:[event('create_ticket'),{type:'message',message:{role:'user',text:'Instead show history'}},event('create_ticket')]},operations:[]});
  assert.equal(unsafe.selection.fp,1);assert.equal(unsafe.selection.fn,1);
});
test('empty-positive FAQ cases report undefined recall; missing cases retain false negatives',()=>{
  assert.equal(scoreRoadTools(reference([]),row([])).selection.recall,null);
  const missing=scoreRoadTools(reference(['query_tickets','close_ticket']),null);assert.equal(missing.selection.fn,2);assert.equal(missing.selection.recall,0);assert.equal(missing.execution.fn,2);
});
test('choosing a tool without a successful receipt does not satisfy execution recall',()=>{
  const s=scoreRoadTools(reference(['close_ticket']),row(['close_ticket'],[]));assert.equal(s.selection.recall,1);assert.equal(s.execution.recall,0);
});
test('micro aggregation uses counts and excludes control tools from business tool scores',()=>{
  const a=scoreRoadTools(reference(['query_tickets','close_ticket']),row(['query_tickets'])),b=scoreRoadTools(reference(['create_ticket']),row(['propose_plan','create_ticket','finish'],['create_ticket']));
  const s=summarizeRoadTools([a,b]);assert.equal(s.selection.recall,2/3);assert.equal(s.selection.precision,1);assert.equal(s.attempts.total,2);
});
