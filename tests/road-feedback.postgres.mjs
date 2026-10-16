import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {FeedbackRepository,feedbackPool,feedbackRecord} from '../src/road/feedback.mjs';
import {feedbackExport} from '../web/road/feedback-data.js';
const url=process.env.ROAD_FEEDBACK_DATABASE_URL;
test('real Neon transaction, idempotency, concurrent versions, ownership and reconnect persistence',{skip:!url},async t=>{
 const schema='feedback_test_'+randomUUID().replaceAll('-',''),pool=feedbackPool(url);let repository;
 try{
 await pool.query(`CREATE SCHEMA "${schema}"`);repository=new FeedbackRepository({pool,schema});await repository.initialize();
 const snapshot={question:'Original question',answer:'Verified mock answer',review_status:'unreviewed'},input={answer_message_id:'answer-one',rating:'satisfied',request_id:'request-one',expected_version:0};let first;
 await t.test('save and replay produce one version and one row',async()=>{first=await repository.submit('owner',input,snapshot);assert.equal(first.version,1);assert.equal((await repository.submit('owner',input,{question:'changed'})).version,1);assert.equal((await repository.list('owner')).length,1);assert.equal((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".road_answer_feedback_events`)).rows[0].n,1);});
 await t.test('changing rating retains immutable answer evidence and rejects stale writes',async()=>{const changed=await repository.submit('owner',{...input,rating:'unsatisfied',request_id:'request-two',expected_version:1},{question:'changed'});assert.equal(changed.version,2);assert.equal(changed.snapshot.question,'Original question');assert.equal(changed.rating,'unsatisfied');await assert.rejects(repository.submit('owner',{...input,request_id:'request-stale',expected_version:1},snapshot),{code:'FEEDBACK_CONFLICT'});assert.equal((await repository.submit('owner',input,snapshot)).version,2);assert.equal((await repository.list('other')).length,0);});
 await t.test('concurrent opposite ratings cannot overwrite a newer revision',async()=>{const outcomes=await Promise.allSettled([repository.submit('owner',{...input,request_id:'request-three',expected_version:2},snapshot),repository.submit('owner',{...input,request_id:'request-four',expected_version:2},snapshot)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.find(x=>x.status==='rejected').reason.code,'FEEDBACK_CONFLICT');assert.equal((await repository.list('owner'))[0].rating,'satisfied');assert.equal((await repository.list('owner'))[0].version,3);});
 await t.test('new repository reads persisted records and exports all sessions independently of chat memory',async()=>{const reopened=new FeedbackRepository({pool,schema});await reopened.load('owner');assert.equal(reopened.cached('owner')['answer-one'].version,3);const rows=(await reopened.list()).map(feedbackRecord);assert.equal(JSON.parse(feedbackExport(rows)).snapshot.answer,'Verified mock answer');});
 }finally{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await pool.end();}
});
