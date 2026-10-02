import {beforeEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({ingest:vi.fn(),auth:vi.fn()}));
vi.mock('@/lib/convex-ingest',()=>({ingestRecognitionAttemptBatch:mocks.ingest,SecuredIngestError:class extends Error{}}));
vi.mock('@/lib/kiosk-device-auth',()=>({authenticateKiosk:mocks.auth,kioskClaims:()=>[],kioskEvidenceId:()=> 'synthetic'}));
import {POST} from './route';
beforeEach(()=>{vi.resetAllMocks();mocks.ingest.mockResolvedValue({ingested:1,skipped:0,ids:['synthetic']});mocks.auth.mockResolvedValue({kioskId:'synthetic'});});
it.each(['bestScore','best_score','score','confidence','threshold','matchThreshold','brightness','imageQuality','blur'])('rejects valid-JSON overflow in raw numeric alias %s before dropping it',async field=>{
 const body=`{"attempts":[{"timestamp":"2026-10-01T08:00:00","faceDetected":true,"decision":"near_miss","${field}":1e400}]}`;
 const response=await POST(new NextRequest('https://synthetic.test/api/recognition-attempts/bulk',{method:'POST',body}));
 expect(response.status).toBe(400);expect(mocks.ingest).not.toHaveBeenCalled();
});
