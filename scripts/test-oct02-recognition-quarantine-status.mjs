import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const testDir=path.dirname(fileURLToPath(import.meta.url));
const root=process.env.GK_CHECKOUT || (path.basename(testDir)==='scripts' ? path.dirname(testDir) : path.resolve(testDir,'../worktrees/10-recognition-valid-time'));
const source=fs.readFileSync(path.join(root,'pi-kiosk/templates/index.html'),'utf8');
const start=source.indexOf('async function fetchStatus(');
const end=source.indexOf('\n        async function ',start+1);
assert.ok(start>=0 && end>start,'actual status function must be extracted');
const element=()=>({textContent:'',style:{}});
const chip=element();let health;
const context=vm.createContext({syncChip:chip,statusText:element(),stateValue:element(),workerIdValue:element(),earValue:element(),knownValue:element(),liveValue:element(),lastUpdated:element(),livenessNote:element(),
 fetch:async()=>({json:async()=>({state:'IDLE',health})}),statusMessageFromState:()=>'',applyStatusState:()=>{},renderAdmin:()=>{},setAdminVisible:()=>{}});
vm.runInContext(`let supervisorStateVersion=0;let adminVisible=false;${source.slice(start,end)};globalThis.fetchStatus=fetchStatus;`,context);
for(const online of [true,false]){
 health={sync_online:online,retryable_logs:2,queued_attempts:1,rejected_logs:0,rejected_attempts:4};
 await context.fetchStatus();
 assert.match(chip.textContent,/3 retryable queued/,'quarantined recognition must not inflate the retryable count');
 assert.match(chip.textContent,/4.*(?:recognition|rejected|attention)/i,'quarantine must remain visible as needing review');
 assert.doesNotMatch(chip.textContent,/^Synced|^Connected|^Syncing/,'quarantined evidence must not look healthy or continually uploading');
}
console.log('PASS: actual kiosk status distinguishes retained rejected evidence from retryable queue online/offline');
