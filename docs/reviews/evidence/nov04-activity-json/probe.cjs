const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = process.argv[2];
const ts = require(path.join(root, 'node_modules/typescript'));
const source = fs.readFileSync(path.join(root, 'src/app/api/activity/route.ts'), 'utf8');
const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
let upstream;
class ActivityBackendError extends Error { constructor(message,status=502){super(message);this.status=status;} }
const context = {exports:{},Response, console:{error(){}}, require(id){if(id==='@/lib/activity-feed')return {ActivityBackendError,fetchActivityFeed:async()=>upstream};throw Error(id)}};
vm.runInNewContext(js,context);
(async()=>{
let failures=0;
for(const entry of [
{status:200,contentType:'text/html',body:'<html>upstream failure</html>',expected:502},
{status:503,contentType:'text/plain',body:'upstream failure',expected:502},
{status:200,contentType:'application/json',body:'{"incomplete":',expected:502},
{status:200,contentType:null,body:'{}',expected:502},
{status:200,contentType:'application/jsonish',body:'{}',expected:502},
{status:403,contentType:'application/json; charset=utf-8',body:'{ "error": "Forbidden" }',expected:403},
{status:200,contentType:'application/json',body:'{"items":[]}',expected:200},
]) {
upstream=entry; const result=await context.exports.GET({headers:new Headers()});
const body=await result.text(); const expectedBody=entry.expected===502?'{"error":"Activity feed unavailable"}':entry.body;
const pass=result.status===entry.expected && body===expectedBody;
console.log(`${pass?'PASS':'FAIL'} status=${entry.status} contentType=${entry.contentType} => ${result.status} expected=${entry.expected}`);
if(!pass)failures++;
}
process.exitCode=failures?1:0;
})();
