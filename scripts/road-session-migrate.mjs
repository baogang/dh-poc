import {resolve} from 'node:path';
import {NeonRoadStore} from '../src/road/neon-store.mjs';

const args=process.argv.slice(2);
if(args.length>1||args[0]?.startsWith('-'))throw Error('Usage: npm run road:session-migrate -- [legacy-directory]');
const store=NeonRoadStore.fromEnv();
try{
  await store.initialize();
  const result=await store.importDirectory(resolve(args[0]??process.env.ROAD_STATE_DIR??'.road-state'));
  console.log(JSON.stringify({storage:'neon',...result,source_files_preserved:true}));
}finally{await store.close();}
