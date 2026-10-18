import pg from 'pg';

export function databasePool(connectionString,{max=5,applicationName='government-road-sessions'}={}){
  let url;try{url=new URL(connectionString);}catch{throw Error('A valid PostgreSQL database URL is required');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||url.pathname.length<2)throw Error('A PostgreSQL database URL is required');
  if(!Number.isInteger(max)||max<1||max>50)throw Error('Database pool size must be 1–50');
  // Explicit connection fields prevent URL options from replacing verified TLS.
  const pool=new pg.Pool({host:url.hostname,port:Number(url.port||5432),database:decodeURIComponent(url.pathname.slice(1)),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),ssl:{rejectUnauthorized:true},enableChannelBinding:true,max,idleTimeoutMillis:10000,connectionTimeoutMillis:12000,statement_timeout:12000,application_name:applicationName});
  pool.on('error',()=>console.warn('Database connection interrupted'));
  return pool;
}
