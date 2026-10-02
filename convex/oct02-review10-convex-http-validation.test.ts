/// <reference types="vite/client" />
import {convexTest} from 'convex-test';
import {expect,it,vi} from 'vitest';
import schema from './schema';
const modules=import.meta.glob('./**/*.ts');
it('returns a permanent timestamp-validation 400 from the actual secured Convex HTTP endpoint',async()=>{
 vi.stubEnv('CONVEX_INGEST_KEY','synthetic-ingest-key');
 const t=convexTest(schema,modules);
 const response=await t.fetch('/api/ingest/recognition-attempts/bulk',{method:'POST',headers:{authorization:'Bearer synthetic-ingest-key','content-type':'application/json'},body:JSON.stringify({attempts:[{kioskId:'synthetic',timestamp:'2026-02-30T08:00:00',faceDetected:true,decision:'near_miss',threshold:.45}]})});
 expect(response.status).toBe(400);
 expect(await response.json()).toMatchObject({code:'INVALID_RECOGNITION_TIMESTAMP'});
 expect(await t.run(ctx=>ctx.db.query('recognitionAttempts').collect())).toHaveLength(0);
 vi.unstubAllEnvs();
});
