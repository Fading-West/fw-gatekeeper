/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect,it } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
const modules=import.meta.glob('./**/*.ts');
it('acknowledges exact legacy retries behind more than 500 historical duplicates without deleting records',async()=>{
 const t=convexTest(schema,modules);
 const attempt={kioskId:'synthetic',timestamp:'2026-10-01T08:00:00',faceDetected:true,decision:'near_miss',threshold:.45,bestScore:.88};
 await t.run(async ctx=>{for(let i=0;i<502;i++)await ctx.db.insert('recognitionAttempts',{...attempt,bestScore:i===501?.88:.4,reviewed:false,createdAt:'2026-10-01T08:00:00Z'});});
 expect(await t.mutation(internal.recognitionAttempts.bulkIngestFromHttp,{attempts:[attempt]})).toMatchObject({ingested:0,skipped:1});
 expect(await t.run(ctx=>ctx.db.query('recognitionAttempts').collect())).toHaveLength(502);
});
