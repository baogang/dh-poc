import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { uid } from './util.mjs';
export class MockClient {
  constructor(baseURL,token,child){this.baseURL=baseURL;this.token=token;this.child=child;}
  static async start(cwd=process.cwd()) {
    const token=randomBytes(24).toString('hex');
    const env={...process.env,POC_MOCK_CONTROL_TOKEN:token,PYTHONUNBUFFERED:'1'};
    delete env.DEEPSEEK_API_KEY;
    const child=spawn('python3',['-m','poc_mocks.server','--port','0'],{cwd,env,stdio:['ignore','pipe','pipe']});
    const baseURL=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>{child.kill();reject(new Error('Mock server startup timeout'));},10000);
      child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
      child.stderr.on('data',()=>{});
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error('Mock server exit '+code));});
    });
    return new MockClient(baseURL,token,child);
  }
  async control(path,method='GET',body,{ignoreAbort=false}={}){const signal=!ignoreAbort&&this.signal?AbortSignal.any([this.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000);const r=await fetch(this.baseURL+'/__poc'+path,{method,headers:{'X-POC-Control-Token':this.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal});const data=await r.json();if(!r.ok)throw Object.assign(new Error(JSON.stringify(data.error)),{code:data.error?.code});return data;}
  async createCase(input={},case_id=uid('case')){if(input.actor&&!['citizen-a','citizen-b'].includes(input.actor))throw Object.assign(new Error('Known fixture actor required'),{code:'MOCK_ACTOR_REQUIRED'});await this.control('/cases','POST',{case_id,actor:input.actor??'citizen-a',...(input.fixture_patch?{fixture_patch:input.fixture_patch}:{})});return case_id;}
  snapshot(case_id){return this.control(`/cases/${case_id}/snapshot`);}
  confirm(case_id,operation_id,path_parameters,body){return this.control(`/cases/${case_id}/confirmations`,'POST',{operation_id,path_parameters,body,confirmed:true});}
  async business(case_id,actor,operation,args,{confirmation_ref,idempotencyKey,signal}={}) {
    signal=signal&&this.signal?AbortSignal.any([signal,this.signal]):signal??this.signal;
    let path=operation.path;const body={...args};
    for(const key of operation.path_parameters){path=path.replace('{'+key+'}',encodeURIComponent(body[key]));delete body[key];}
    if(confirmation_ref)body.confirmation_ref=confirmation_ref;
    const r=await fetch(this.baseURL+path,{method:operation.method,headers:{'Content-Type':'application/json','X-POC-Case-ID':case_id,'X-POC-Actor':actor,...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},...(operation.method==='GET'?{}:{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
    return {http_status:r.status,...await r.json()};
  }
  stop(){this.child?.kill('SIGTERM');}
}
