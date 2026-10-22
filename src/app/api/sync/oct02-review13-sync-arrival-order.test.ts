import {NextRequest} from 'next/server';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({portal:vi.fn(),authenticate:vi.fn(),update:vi.fn(),fetch:vi.fn()}));
vi.mock('@/lib/auth',()=>({hasDeviceKeyFormat:()=>true,unauthorizedApiResponse:()=>Response.json({error:'Unauthorized'},{status:401})}));
vi.mock('@/lib/portal-auth',()=>({hasValidPortalSession:mocks.portal}));
vi.mock('@/lib/kiosk-device-auth',()=>({authenticateKiosk:mocks.authenticate}));
vi.mock('@/lib/convex-ingest',()=>({fetchWorkersForSync:mocks.fetch,updateKioskLastSync:mocks.update,issueRosterReceipt:vi.fn()}));
import {GET} from './route';
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.clearAllMocks();mocks.portal.mockResolvedValue(false);mocks.authenticate.mockResolvedValue({documentId:'synthetic-kiosk'});mocks.update.mockResolvedValue({updated:true});mocks.fetch.mockResolvedValue({workers:[]});});
afterEach(()=>vi.useRealTimers());
const req=(ok:boolean)=>new NextRequest(`https://synthetic.test/api/sync?kiosk_id=synthetic-kiosk&camera_ok=${ok?1:0}`);
it('orders concurrent health observations by route arrival even when older authentication finishes last',async()=>{
 const firstArrival=Date.parse('2026-10-02T12:00:00Z');vi.setSystemTime(firstArrival);
 let resolveOld!:(value:boolean)=>void;const oldAuth=new Promise<boolean>(resolve=>{resolveOld=resolve;});mocks.portal.mockReturnValueOnce(oldAuth);
 const older=GET(req(false));expect(mocks.portal).toHaveBeenCalledOnce();
 vi.setSystemTime(firstArrival+1000);expect((await GET(req(true))).status).toBe(200);
 vi.setSystemTime(firstArrival+2000);resolveOld(false);expect((await older).status).toBe(200);
 const newerCall=mocks.update.mock.calls.find(call=>call[2]?.cameraOk===true)!;
 const olderCall=mocks.update.mock.calls.find(call=>call[2]?.cameraOk===false)!;
 expect(Date.parse(olderCall[1])).toBe(firstArrival);
 expect(Date.parse(newerCall[1])).toBe(firstArrival+1000);
 expect(Date.parse(olderCall[1])).toBeLessThan(Date.parse(newerCall[1]));
});
it('denies unauthenticated health observations without advancing any watermark',async()=>{
 mocks.authenticate.mockResolvedValue(null);expect((await GET(req(false))).status).toBe(401);expect(mocks.update).not.toHaveBeenCalled();
});
