import test from 'node:test';
import assert from 'node:assert/strict';
import {markdown} from '../web/road/markdown.js';
import {createDocument} from './helpers/dom.mjs';

test('compact record tables preserve column semantics and expose each field label separately from its complete value',()=>{
  for(const headers of [['Report number','Issue'],['工单编号','问题描述','记录状态'],['رقم السجل','وصف المشكلة','الحالة المسجلة','علامة المرفقات']]){
    const values=['INC-26-10-000001','Suspected abandoned vehicle beside Test Cedar Street / 测试雪松街旁疑似废弃车辆','In progress','Not marked as having attachments'].slice(0,headers.length);
    const text='| '+headers.join(' | ')+' |\n| '+headers.map(()=>'---').join(' | ')+' |\n| '+values.join(' | ')+' |',document=createDocument(),node=markdown(document,text),table=node.querySelector('table');
    assert.equal(table.dataset.layout,'records');assert.equal(table.getAttribute('role'),'table');assert.equal(table.querySelector('thead').getAttribute('role'),'rowgroup');
    const cells=table.querySelectorAll('td');assert.equal(cells.length,headers.length);
    for(let i=0;i<cells.length;i++){const label=cells[i].querySelector('[data-cell-label]'),value=cells[i].querySelector('[data-cell-value]');assert.equal(label.textContent,headers[i]);assert.equal(label.getAttribute('aria-hidden'),'true');assert.equal(value.textContent,values[i]);assert.equal(value.dir,'auto');assert.equal(cells[i].getAttribute('role'),'cell');}
  }
});
test('larger comparison tables remain matrix tables with all values and column headings',()=>{
  const document=createDocument(),node=markdown(document,'| A | B | C | D | E |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |'),table=node.querySelector('table');assert.equal(table.dataset.layout,'matrix');assert.deepEqual(table.querySelectorAll('th').map(x=>x.textContent),['A','B','C','D','E']);assert.deepEqual(table.querySelectorAll('[data-cell-value]').map(x=>x.textContent),['1','2','3','4','5']);
});
test('responsive labels retain decoded Markdown text while values preserve safe formatting and reject executable HTML or links',()=>{
  const document=createDocument(),node=markdown(document,'| **Issue** &amp; location | Status |\n|---|---|\n| **Full description** [service](https://balady.gov.sa/) | <img src=x onerror=alert(1)> [bad](javascript:alert(1)) |'),labels=node.querySelectorAll('[data-cell-label]'),values=node.querySelectorAll('[data-cell-value]');assert.equal(labels[0].textContent,'Issue & location');assert.equal(values[0].querySelector('strong').textContent,'Full description');assert.equal(values[0].querySelectorAll('a').length,1);assert.equal(values[1].querySelectorAll('a').length,0);assert.equal(node.querySelectorAll('img').length,0);assert.match(values[1].textContent,/<img/);
});
