/// <reference types="vite/client" />
import {convexTest} from 'convex-test';
import {beforeEach,expect,it,vi} from 'vitest';
const audit=vi.hoisted(()=>({write:vi.fn()}));
vi.mock('./audit',()=>({writeAuditLog:audit.write}));
import schema from './schema';
import {api} from './_generated/api';
const modules=import.meta.glob('./**/*.ts');
beforeEach(()=>{audit.write.mockReset();audit.write.mockRejectedValue(new Error('Synthetic audit persistence unavailable'));});
it.each([false,true])('rolls back the alternate review change when append-only audit fails (existing=%s)',async existing=>{
 const t=convexTest(schema,modules);const exceptionKey='2026-10-01:recognition_review:synthetic-attempt';
 const uid=await t.run(async ctx=>{const uid=await ctx.db.insert('users',{email:'synthetic-admin@example.test'});await ctx.db.insert('portalMembers',{userId:uid,role:'admin',active:true,createdAt:'2026-10-01'});
  if(existing)await ctx.db.insert('exceptionReviews',{exceptionKey,date:'2026-10-01',type:'recognition_review',status:'reviewed',note:'Original evidence review',reviewedAt:'2026-10-01T09:00:00Z',updatedAt:'2026-10-01T09:00:00Z'});return uid;});
 const before=await t.run(ctx=>ctx.db.query('exceptionReviews').collect());
 await expect(t.withIdentity({subject:uid}).mutation(api.shiftExceptions.review,{exceptionKey,date:'2026-10-01',type:'recognition_review',status:'open',note:'New review'})).rejects.toThrow('Synthetic audit persistence unavailable');
 expect(audit.write).toHaveBeenCalledOnce();
 expect(await t.run(ctx=>ctx.db.query('exceptionReviews').collect())).toEqual(before);
 expect(await t.run(ctx=>ctx.db.query('auditLog').collect())).toHaveLength(0);
});
