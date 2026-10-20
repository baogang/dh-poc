import {lexer} from './vendor/marked.js';

// Use Marked only to tokenize. Build a small DOM allowlist ourselves so model/API
// text never becomes HTML, executable links, images, or arbitrary attributes.
const decode=text=>String(text??'').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(all,key)=>{
  if(key[0]!=='#')return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[key.toLowerCase()]??all;
  const point=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));
  return point>0&&point<=0x10ffff&&!(point>=0xd800&&point<=0xdfff)?String.fromCodePoint(point):'�';
});
const safeLink=href=>{try{const url=new URL(decode(href));return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}};

export function markdown(document,text,{tableLabel='Data table'}={}){
  const el=(tag,value)=>{const n=document.createElement(tag);if(value!==undefined)n.textContent=value;return n;};
  const literal=(parent,value)=>parent.append(document.createTextNode(value));
  function inline(parent,tokens){
    for(const token of tokens??[]){
      if(['strong','em','del'].includes(token.type)){const n=el(token.type);inline(n,token.tokens);parent.append(n);}
      else if(token.type==='codespan')parent.append(el('code',token.text));
      else if(token.type==='br')parent.append(el('br'));
      else if(token.type==='link'){
        const href=safeLink(token.href),n=el(href?'a':'span');if(href){n.href=href;n.target='_blank';n.rel='noopener noreferrer';}
        inline(n,token.tokens);parent.append(n);
      }else if(token.type==='image')literal(parent,decode(token.text));
      else if(token.tokens)inline(parent,token.tokens);
      else literal(parent,token.type==='html'?token.raw:decode(token.text??token.raw));
    }
  }
  function blocks(parent,tokens){
    for(const token of tokens){
      if(token.type==='space')continue;
      if(token.type==='table'){
        const wrap=el('div'),table=el('table'),head=el('thead'),body=el('tbody');
        wrap.className='markdown-table';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',tableLabel);
        // Explicit roles retain table semantics when narrow containers stack rows.
        table.dataset.layout=token.header.length<=4?'records':'matrix';table.setAttribute('role','table');head.setAttribute('role','rowgroup');body.setAttribute('role','rowgroup');
        let labels=[];
        const row=(cells,header)=>{const tr=el('tr');tr.setAttribute('role','row');for(const [index,cell]of cells.entries()){
          const td=el(header?'th':'td');td.setAttribute('role',header?'columnheader':'cell');if(header)td.setAttribute('scope','col');if(cell.align)td.className='align-'+cell.align;
          if(header)inline(td,cell.tokens);
          else{
            if(table.dataset.layout==='records'){const label=el('span',labels[index]??'');label.className='table-cell-label';label.dataset.cellLabel='';label.dir='auto';label.setAttribute('aria-hidden','true');td.append(label);}
            const value=el('div');value.className='table-cell-value';value.dataset.cellValue='';value.dir='auto';inline(value,cell.tokens);td.append(value);
          }
          tr.append(td);
        }if(header)labels=[...tr.children].map(cell=>cell.textContent);return tr;};
        head.append(row(token.header,true));for(const cells of token.rows)body.append(row(cells,false));table.append(head,body);wrap.append(table);parent.append(wrap);
      }else if(token.type==='code'){const pre=el('pre');pre.append(el('code',token.text));parent.append(pre);}
      else if(token.type==='list'){
        const list=el(token.ordered?'ol':'ul');if(token.ordered&&token.start!==1)list.start=token.start;
        for(const item of token.items){const li=el('li');if(item.task)literal(li,item.checked?'☑ ':'☐ ');blocks(li,item.tokens);list.append(li);}parent.append(list);
      }else if(token.type==='blockquote'){const quote=el('blockquote');blocks(quote,token.tokens);parent.append(quote);}
      else if(token.type==='hr')parent.append(el('hr'));
      else if(token.type==='heading'){const h=el('h'+Math.min(6,token.depth+2));inline(h,token.tokens);parent.append(h);}
      else if(['paragraph','text'].includes(token.type)){const p=el('p');if(token.tokens)inline(p,token.tokens);else p.textContent=decode(token.text);parent.append(p);}
      else parent.append(el('p',token.raw??token.text??''));
    }
  }
  const root=el('div');root.className='message-text markdown-body';
  try{blocks(root,lexer(String(text??''),{gfm:true}));}catch{root.textContent=String(text??'');}
  return root;
}
