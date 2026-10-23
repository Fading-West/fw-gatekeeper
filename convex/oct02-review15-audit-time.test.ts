/// <reference types="vite/client" />
import {convexTest} from 'convex-test';
import {expect,it} from 'vitest';
import schema from './schema';
import {api,internal} from './_generated/api';
const modules=import.meta.glob('./**/*.ts');
it('preserves actual review timestamp changes and removals in append-only audit details',async()=>{
 const t=convexTest(schema,modules);const uid=await t.run(async ctx=>{const uid=await ctx.db.insert('users',{email:'synthetic@example.test'});await ctx.db.insert('portalMembers',{userId:uid,role:'admin',active:true,createdAt:'2026-10-01'});return uid;});
 const {ids}=await t.mutation(internal.recognitionAttempts.bulkIngestFromHttp,{attempts:[{kioskId:'synthetic',timestamp:'2026-10-01T08:00:00',faceDetected:true,decision:'near_miss',threshold:.45}]});
 const admin=t.withIdentity({subject:uid});
 const first='2026-10-01T09:00:00Z',second='2026-10-01T10:00:00Z';
 await admin.mutation(api.recognitionAttempts.updateReview,{id:ids[0],reviewed:true,reviewedAt:first});
 await admin.mutation(api.recognitionAttempts.updateReview,{id:ids[0],reviewed:true,reviewedAt:second});
 await admin.mutation(api.recognitionAttempts.updateReview,{id:ids[0],reviewed:false});
 const audit=(await t.run(ctx=>ctx.db.query('auditLog').collect())).map(r=>JSON.parse(r.details!));
 expect(audit[1]).toMatchObject({before:{reviewedAt:first},after:{reviewedAt:second}});
 expect(audit[2]).toMatchObject({before:{reviewedAt:second},after:{reviewedAt:null}});
});
