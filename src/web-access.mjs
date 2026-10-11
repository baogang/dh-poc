import { createHash,timingSafeEqual } from 'node:crypto';

const forbidden=message=>Object.assign(new Error(message),{status:403});
const digest=value=>createHash('sha256').update(value).digest();

function publicOrigin(value){
 if(!value)return null;
 let url;try{url=new URL(value);}catch{throw new Error('POC_PUBLIC_ORIGIN / RENDER_EXTERNAL_URL must be an HTTPS origin');}
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Public origin must use HTTPS without credentials, path, query or fragment');
 return url.origin;
}

export function webConfigFromEnv(env=process.env){
 const port=Number(env.PORT??env.POC_WEB_PORT??8787);
 if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT / POC_WEB_PORT must be 1024–65535');
 const origin=publicOrigin(env.POC_PUBLIC_ORIGIN||env.RENDER_EXTERNAL_URL);
 const host=env.POC_WEB_HOST??(origin?'0.0.0.0':'127.0.0.1');
 if(!['127.0.0.1','localhost','0.0.0.0'].includes(host))throw new Error('POC_WEB_HOST must be 127.0.0.1, localhost or 0.0.0.0');
 if(host==='0.0.0.0'&&!origin)throw new Error('Public listening requires POC_PUBLIC_ORIGIN or RENDER_EXTERNAL_URL');
 const access={publicOrigin:origin,username:env.POC_AUTH_USERNAME??'admin',password:env.POC_AUTH_PASSWORD};
 createWebAccess(access);
 return {port,host,access};
}

export function createWebAccess({publicOrigin:configuredOrigin,username='admin',password}={}){
 const origin=publicOrigin(configuredOrigin);
 if(origin&&!password)throw new Error('Public access requires POC_AUTH_PASSWORD');
 if(password&&(password.length<16||!/^[\x21-\x7e]{1,80}$/.test(username)||username.includes(':')))throw new Error('Use an ASCII username without colon and a password of at least 16 characters');
 const expected=password?digest(username+':'+password):null;
 return {
  originFor(req,port){
   if(origin){if(req.headers.host!==new URL(origin).host)throw forbidden('访问域名不匹配');return origin;}
   if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))throw forbidden('仅接受本机访问');
   return 'http://'+req.headers.host;
  },
  authenticated(req){
   if(!expected)return true;
   const header=req.headers.authorization;
   if(typeof header!=='string'||!/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(header))return false;
   return timingSafeEqual(expected,digest(Buffer.from(header.slice(6),'base64')));
  }
 };
}
