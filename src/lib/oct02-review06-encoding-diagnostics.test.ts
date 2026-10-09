/// <reference types="vite/client" />
import {convexTest} from 'convex-test';
import {expect,it} from 'vitest';
import schema from '../../convex/schema';
import {api} from '../../convex/_generated/api';
import {getEncodingValidationMessage,isSupportedEncoding} from './encoding';
const modules=import.meta.glob('../../convex/**/*.ts');
const normReason=/non[- ]?zero|norm|magnitude/i;
for(const magnitude of [0,1e308,1e-300]) {
 const vector=Array(512).fill(0);vector[0]=magnitude;
 it(`explains why a 512-element finite vector of magnitude ${magnitude} is unusable`,()=>{
  expect(vector.every(Number.isFinite)).toBe(true);expect(isSupportedEncoding(vector)).toBe(false);
  expect(getEncodingValidationMessage('Face encoding')).toMatch(normReason);
 });
 it(`explains the same rejection at authenticated Convex create/update boundaries (${magnitude})`,async()=>{
  const t=convexTest(schema,modules);const uid=await t.run(async ctx=>{const uid=await ctx.db.insert('users',{email:'synthetic-admin@example.test'});await ctx.db.insert('portalMembers',{userId:uid,role:'admin',active:true,createdAt:new Date().toISOString()});return uid;});
  const admin=t.withIdentity({subject:uid});const consentAt=new Date().toISOString();
  await expect(admin.mutation(api.workers.create,{name:'Synthetic rejected',faceEncoding:vector,consentAt})).rejects.toThrow(normReason);
  const good=await admin.mutation(api.workers.create,{name:'Synthetic valid',faceEncoding:Array(512).fill(.1),consentAt});
  await expect(admin.mutation(api.workers.update,{id:good.id,expectedIdentityRevision:(await admin.query(api.workers.get,{id:good.id}))?.identity_revision,faceEncoding:vector,consentAt})).rejects.toThrow(normReason);
 });
}
