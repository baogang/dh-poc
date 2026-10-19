// Small DOM adapter for the actual shipped chat renderer. Browser checks cover layout.
class Element {
  constructor(tag,document){this.tagName=tag.toUpperCase();this.document=document;this.children=[];this.dataset={};this.attrs={};this.className='';this.listeners={};this.open=false;this.scrollTop=0;this.clientHeight=600;this.scrollHeight=600;this._text='';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  append(...children){for(const c of children){c.remove();c.parentElement=this;this.children.push(c);}}
  remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(c=>c!==this);this.parentElement=null;}}
  insertBefore(node,before){node.remove();node.parentElement=this;const i=this.children.indexOf(before);if(i<0)this.children.push(node);else this.children.splice(i,0,node);}
  get firstChild(){return this.children[0]??null;}
  get nextSibling(){return this.parentElement?.children[this.parentElement.children.indexOf(this)+1]??null;}
  setAttribute(key,value){this.attrs[key]=String(value);}
  getAttribute(key){return this.attrs[key]??null;}
  addEventListener(name,fn){this.listeners[name]=fn;}
  matches(selector){return selector.split(',').some(part=>{const tag=part.match(/^[\w-]+/)?.[0];if(tag&&this.tagName!==tag.toUpperCase())return false;return [...part.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)].every(([,key,value])=>{const actual=key.startsWith('data-')?this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]:this.attrs[key];return actual!==undefined&&(value===undefined||String(actual)===value);});});}
  querySelectorAll(selector){return this.children.flatMap(c=>[...(c.matches(selector)?[c]:[]),...c.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
}
export function createDocument(){const document={activeElement:null,createElement:tag=>new Element(tag,document),createTextNode:text=>{const n=new Element('#text',document);n.textContent=text;return n;}};return document;}
