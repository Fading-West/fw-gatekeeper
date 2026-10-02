/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect,it } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
const modules=import.meta.glob('./**/*.ts');
it('repairs an invalid future legacy watermark with a valid heartbeat and preserves ordering afterward',async()=>{
 const t=convexTest(schema,modules);const now=new Date().toISOString();
 const id=await t.run(ctx=>ctx.db.insert('kiosks',{name:'Synthetic',kioskId:'synthetic',type:'entry',location:'',active:true,lastSync:'2099-01-01T00:00:00Z',health:{cameraOk:false,reportedAt:'2099-01-01T00:00:00Z'}}));
 await t.mutation(internal.kiosks.updateLastSyncFromHttp,{kioskId:'synthetic',lastSync:now,health:{cameraOk:true,reportedAt:now}});
 expect(await t.run(ctx=>ctx.db.get(id))).toMatchObject({lastSync:now,health:{cameraOk:true}});
 const old=new Date(Date.now()-60_000).toISOString();
 await t.mutation(internal.kiosks.updateLastSyncFromHttp,{kioskId:'synthetic',lastSync:old,health:{cameraOk:false,reportedAt:old}});
 expect(await t.run(ctx=>ctx.db.get(id))).toMatchObject({lastSync:now,health:{cameraOk:true}});
});
