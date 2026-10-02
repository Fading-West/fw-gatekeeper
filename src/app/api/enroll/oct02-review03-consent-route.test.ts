import {beforeEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({query:vi.fn(),mutation:vi.fn(),action:vi.fn(),authorized:vi.fn(),fetch:vi.fn()}));
vi.mock('@/lib/convex',()=>({default:{query:mocks.query,mutation:mocks.mutation,action:mocks.action}}));
vi.mock('@/lib/portal-auth',()=>({hasValidPortalSession:mocks.authorized}));
import {POST} from './route';
beforeEach(()=>{vi.resetAllMocks();vi.stubGlobal('fetch',mocks.fetch);vi.stubEnv('FACE_SERVICE_KEY','synthetic');mocks.authorized.mockResolvedValue(true);mocks.query.mockResolvedValue(null);mocks.action.mockResolvedValue('synthetic-photo');mocks.mutation.mockResolvedValue({id:'synthetic-worker'});mocks.fetch.mockResolvedValue(Response.json({encoding:Array(512).fill(.1),used_photo_indexes:[0,1,2]}));});
function req(consentAt?:string){return new NextRequest('https://synthetic.test/api/enroll',{method:'POST',body:JSON.stringify({name:'Synthetic Employee',consent:true,consentAt,photos:Array(3).fill('data:image/jpeg;base64,YQ==')})});}
it('passes actual acknowledgement time to mutation rather than minting a newer one',async()=>{
 const consentAt=new Date(Date.now()-30_000).toISOString();expect((await POST(req(consentAt))).status).toBe(201);
 expect(mocks.mutation.mock.calls.find(c=>c[1].faceEncoding)?.[1].consentAt).toBe(consentAt);
});
it.each([undefined,'2020-01-01T00:00:00Z'])('rejects missing or stale acknowledgement before photo processing (%s)',async consentAt=>{
 expect((await POST(req(consentAt))).status).toBe(400);expect(mocks.fetch).not.toHaveBeenCalled();expect(mocks.action).not.toHaveBeenCalled();
});
