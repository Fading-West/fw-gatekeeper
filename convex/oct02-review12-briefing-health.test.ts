/// <reference types="vite/client" />
import {convexTest} from 'convex-test';
import {expect,it} from 'vitest';
import schema from './schema';
import {api} from './_generated/api';
const modules=import.meta.glob('./**/*.ts');
it('briefing flags invalid and future sync timestamps as offline warnings',async()=>{
 const t=convexTest(schema,modules);const now=new Date().toISOString();
 const uid=await t.run(async ctx=>{
  const uid=await ctx.db.insert('users',{email:'synthetic@example.test'});await ctx.db.insert('portalMembers',{userId:uid,role:'admin',active:true,createdAt:now});
  for(const lastSync of ['invalid','2099-01-01T00:00:00Z'])await ctx.db.insert('kiosks',{name:lastSync,kioskId:lastSync,type:'entry',location:'',active:true,lastSync});return uid;
 });
 const result=await t.withIdentity({subject:uid}).query(api.shiftBriefing.summary,{date:'2026-10-01'});
 expect(result.kiosks.rows.map(r=>r.status)).toEqual(['offline','offline']);
 expect(result.summary.kiosk_warnings).toBe(2);
});
