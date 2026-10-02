/// <reference types="vite/client" />
import {convexTest} from 'convex-test';
import {afterEach,expect,it,vi} from 'vitest';
import schema from './schema';
import {api} from './_generated/api';
const modules=import.meta.glob('./**/*.ts');
const date='2026-10-01';
async function fixture(){
 const t=convexTest(schema,modules);const ids=await t.run(async ctx=>{
  const add=async(role:'admin'|'enrollment'|'viewer',active=true)=>{const uid=await ctx.db.insert('users',{email:`synthetic-${role}-${active}@example.test`});await ctx.db.insert('portalMembers',{userId:uid,role,active,createdAt:new Date().toISOString()});return uid;};
  const admin=await add('admin'),viewer=await add('viewer'),inactive=await add('enrollment',false);
  const attempt=await ctx.db.insert('recognitionAttempts',{timestamp:`${date}T08:00:00`,kioskId:'synthetic',faceDetected:true,decision:'near_miss',threshold:.45,reviewed:false,createdAt:new Date().toISOString()});return {admin,viewer,inactive,attempt};
 });return {t,...ids,key:`${date}:recognition_review:${ids.attempt}`};
}
afterEach(()=>vi.useRealTimers());
it('denies anonymous/viewer/inactive shift review without changing state or creating audit',async()=>{
 const {t,viewer,inactive,key}=await fixture();const input={exceptionKey:key,date,type:'recognition_review',status:'ignored' as const,note:'hide evidence'};
 await expect(t.mutation(api.shiftExceptions.review,input)).rejects.toThrow();
 for(const uid of [viewer,inactive])await expect(t.withIdentity({subject:uid}).mutation(api.shiftExceptions.review,input)).rejects.toThrow();
 expect(await t.run(ctx=>ctx.db.query('exceptionReviews').collect())).toHaveLength(0);expect(await t.run(ctx=>ctx.db.query('auditLog').collect())).toHaveLength(0);
});
it('audits actor and effective before/after state across recognition exception close, note edit and reopen',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(`${date}T15:00:00Z`));
 const {t,admin:uid,key}=await fixture();const admin=t.withIdentity({subject:uid});
 const input={exceptionKey:key,date,type:'recognition_review',status:'reviewed' as const,note:'Checked evidence'};
 vi.advanceTimersByTime(1000);const first=await admin.mutation(api.shiftExceptions.review,input);
 const repeat=await admin.mutation(api.shiftExceptions.review,input);expect(repeat.id).toBe(first.id);expect(await t.run(ctx=>ctx.db.query('exceptionReviews').collect())).toHaveLength(1);
 vi.advanceTimersByTime(1000);const edited=await admin.mutation(api.shiftExceptions.review,{...input,note:'Corrected review note'});
 vi.advanceTimersByTime(1000);const reopened=await admin.mutation(api.shiftExceptions.review,{...input,status:'open',note:'Needs another check'});
 const audits=await t.run(ctx=>ctx.db.query('auditLog').collect());expect(audits.length).toBeGreaterThanOrEqual(3);
 for(const audit of audits){expect(audit.actorUserId).toBe(uid);expect(audit.targetTable).toBe('exceptionReviews');expect(audit.targetId).toBe(first.id);}
 const details=audits.map(a=>JSON.parse(a.details!));
 expect(details[0]).toMatchObject({after:{status:'reviewed',note:'Checked evidence',reviewedAt:first.reviewedAt}});
 expect(details.find(d=>d.after?.note==='Corrected review note')).toMatchObject({before:{status:'reviewed',note:'Checked evidence',reviewedAt:first.reviewedAt},after:{status:'reviewed',note:'Corrected review note',reviewedAt:edited.reviewedAt}});
 expect(details.at(-1)).toMatchObject({before:{status:'reviewed',note:'Corrected review note',reviewedAt:edited.reviewedAt},after:{status:'open',note:'Needs another check',reviewedAt:null}});
 expect(reopened.reviewedAt).toBeUndefined();
 const summary=await admin.query(api.shiftExceptions.summary,{date});expect(summary.exceptions.find(row=>row.key===key)).toMatchObject({status:'open',review_note:'Needs another check'});
});
it('does not invent an open prior override when the first shift action reopens a Recognition Lab review',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(`${date}T15:00:00Z`));
 const {t,admin:uid,attempt,key}=await fixture();const admin=t.withIdentity({subject:uid});
 vi.advanceTimersByTime(1000);await admin.mutation(api.recognitionAttempts.updateReview,{id:attempt,reviewed:true,reviewedLabel:'confirmed',reviewedNote:'Lab verified'});
 const before=await admin.query(api.shiftExceptions.summary,{date});expect(before.exceptions.find(row=>row.key===key)).toMatchObject({status:'reviewed'});
 expect(await t.run(ctx=>ctx.db.query('exceptionReviews').collect())).toHaveLength(0);
 vi.advanceTimersByTime(1000);const reopened=await admin.mutation(api.shiftExceptions.review,{exceptionKey:key,date,type:'recognition_review',status:'open',note:'Recheck lab decision'});
 const audit=(await t.run(ctx=>ctx.db.query('auditLog').collect())).find(a=>a.targetTable==='exceptionReviews'&&a.targetId===reopened.id)!;
 expect(audit).toBeDefined();const details=JSON.parse(audit.details!);
 // The target record did not exist. Null accurately records creation of an
 // override; calling the nonexistent prior override "open" invents history.
 expect(details.before).toBeNull();expect(details.after).toMatchObject({status:'open',note:'Recheck lab decision',reviewedAt:null});
});
