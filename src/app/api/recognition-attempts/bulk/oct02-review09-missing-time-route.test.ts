import {expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({ingest:vi.fn().mockResolvedValue({ingested:1,skipped:0,ids:['synthetic']}),auth:vi.fn().mockResolvedValue({kioskId:'synthetic'})}));
vi.mock('@/lib/convex-ingest',()=>({ingestRecognitionAttemptBatch:mocks.ingest,SecuredIngestError:class extends Error{}}));
vi.mock('@/lib/kiosk-device-auth',()=>({authenticateKiosk:mocks.auth,kioskClaims:()=>[],kioskEvidenceId:()=> 'synthetic'}));
import {POST} from './route';
it('does not fabricate a new timestamp for an unkeyed timestamp-less legacy attempt',async()=>{
 const body={attempts:[{faceDetected:true,decision:'near_miss',threshold:.45,bestScore:.4}]};
 const response=await POST(new NextRequest('https://synthetic.test/api/recognition-attempts/bulk',{method:'POST',body:JSON.stringify(body)}));
 expect(response.status).toBe(400);expect(mocks.ingest).not.toHaveBeenCalled();
});
