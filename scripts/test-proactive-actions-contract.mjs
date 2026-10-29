#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sourcePath = new URL('../src/lib/proactive-actions.ts', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const executableSource = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
}).outputText;

// proactive-actions.ts imports the dependency-free date helpers; transpile them the same way.
const dateModule = { exports: {} };
new Script(ts.transpileModule(read('src/lib/date.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { filename: 'src/lib/date.ts' }).runInNewContext({
  exports: dateModule.exports,
  module: dateModule,
  require,
});

const module = { exports: {} };
new Script(executableSource, { filename: 'src/lib/proactive-actions.ts' }).runInNewContext({
  exports: module.exports,
  module,
  require: (specifier) => (specifier === './date' ? dateModule.exports : require(specifier)),
  console,
});

const {
  buildLiveShiftSentinelItems,
  buildProactiveActions,
  buildProactiveShiftTrustPlan,
  getLiveShiftSentinelSnapshot,
  getProactiveActionEvidenceChips,
  getProactiveActionFreshnessLabel,
  getProactiveActionOutcomeChips,
  getProactiveActionProofLink,
  PROACTIVE_ACTION_PRIORITY_RANK,
} = module.exports;

const actionKeys = (actions) => JSON.parse(JSON.stringify(actions.map((action) => action.key)));
const plain = (value) => JSON.parse(JSON.stringify(value));
const findAction = (actions, key) => actions.find((action) => action.key === key);

function assertCurrentSignalFailure(action, sourceKeys, message) {
  assert.deepEqual(
    plain(action.freshness),
    {
      lastSuccessAt: '2026-06-26T13:50:00.000Z',
      failed: true,
      current: true,
      message,
      status: 'stale',
      reason: 'current-signal-failure',
      unavailable: true,
      sourceKeys,
    },
    `${action.key} should expose stale freshness for the failed current signal.`,
  );
}

assert.deepEqual(JSON.parse(JSON.stringify(PROACTIVE_ACTION_PRIORITY_RANK)), {
  critical: 0,
  warning: 1,
  closeout: 2,
  info: 3,
}, 'Proactive action priorities must make the ranking contract explicit.');

const mixedRiskPayload = {
  signalFailures: [
    {
      key: 'stats',
      label: 'Dashboard stats',
      href: '/reports',
      message: 'Dashboard stats could not refresh: upstream timeout',
    },
  ],
  workers: [
    { id: 'w1', name: 'Ava', department: 'Dock', encoding_status: 'valid', has_face_encoding: true, status: 'in' },
    { id: 'w2', name: 'Ben', department: 'Dock', encoding_status: 'invalid', has_face_encoding: true, status: 'absent' },
    { id: 'w3', name: 'Cam', department: 'Pack', encoding_status: 'missing', has_face_encoding: false, status: 'absent' },
  ],
  systemHealth: {
    checked_at: '2026-06-26T14:00:00.000Z',
    kiosks: {
      total: 2,
      counts: { online: 1, stale: 0, offline: 1, never_synced: 0 },
    },
    warnings: ['Main Entry kiosk is offline', 'Face service latency is elevated'],
  },
  stats: {
    totalWorkers: 3,
    notArrived: 2,
    scheduleWarning: 'No active schedule covers today.',
  },
  shiftExceptions: {
    date: '2026-06-26',
    summary: { total: 4, open: 3, critical: 1, warning: 2, info: 0 },
  },
  shiftCloseout: {
    date: '2026-06-26',
    closeout: null,
    blockers: [{
      id: 'critical-exceptions',
      label: 'Critical exceptions',
      proof: {
        label: 'open critical exceptions',
        count: 1,
        href: '/exceptions?date=2026-06-26&status=open&severity=critical&exception_key=2026-06-26%3Acritical%3Aw2',
        exact: true,
      },
    }],
    can_complete: false,
    summary: { open_exceptions: 3, critical_exceptions: 1, kiosk_warnings: 1 },
  },
};

const rankedActions = buildProactiveActions(mixedRiskPayload);

assert.deepEqual(actionKeys(rankedActions), [
  'system-health-0',
  'invalid-face',
  'shift-exceptions',
  'system-health-1',
  'missing-face',
  'schedule-warning',
  'signal-failure-stats',
  'shift-closeout-pending',
  'not-arrived',
], 'Critical kiosk/enrollment/exceptions must rank before warnings, closeout, and informational actions.');

const sentinelItems = buildLiveShiftSentinelItems(rankedActions);
assert.deepEqual(
  plain(sentinelItems.map((item) => ({ key: item.key, kind: item.kind, status: item.status }))),
  [
    { key: 'system-health-0', kind: 'kiosk-trust', status: 'current' },
    { key: 'shift-exceptions', kind: 'critical-exception', status: 'current' },
    { key: 'system-health-1', kind: 'kiosk-trust', status: 'current' },
    { key: 'signal-failure-stats', kind: 'signal-unavailable', status: 'current' },
    { key: 'shift-closeout-pending', kind: 'closeout-blocked', status: 'current' },
  ],
  'Live Shift Sentinel should derive urgent current risk from existing deterministic action evidence.',
);
assert.deepEqual(
  plain(sentinelItems[0]),
  {
    key: 'system-health-0',
    signature: sentinelItems[0].signature,
    status: 'current',
    kind: 'kiosk-trust',
    priority: 'critical',
    severity: 'critical',
    tone: 'red',
    label: 'Kiosk sync warning',
    description: 'Main Entry kiosk is offline',
    href: '/kiosks',
    cta: 'Open kiosks',
    source: 'kiosk',
    evidenceChips: ['1 offline kiosk'],
    outcomeChips: ['Clears shift readiness', 'Clears closeout trust'],
    freshnessLabel: null,
    acknowledged: false,
    changedSinceSeen: false,
    proofLink: null,
    actionability: { access: 'operate', canOperate: true, role: null },
  },
  'Sentinel items should carry role-safe handoff copy, evidence chips, and exact current-risk status without creating new source semantics.',
);
const sentinelSnapshot = getLiveShiftSentinelSnapshot(sentinelItems);
assert.equal(sentinelSnapshot['system-health-0'], sentinelItems[0].signature, 'Sentinel snapshots should persist stable item signatures for client-local seen tracking.');
assert.equal(
  findAction(buildLiveShiftSentinelItems(rankedActions, { seenSnapshot: sentinelSnapshot, hasSeenBaseline: true }), 'system-health-0').status,
  'seen',
  'Sentinel seen tracking should acknowledge the exact deterministic signature without hiding the item.',
);
assert.equal(
  findAction(buildLiveShiftSentinelItems(rankedActions, { seenSnapshot: { ...sentinelSnapshot, 'shift-exceptions': 'old-signature' }, hasSeenBaseline: true }), 'shift-exceptions').status,
  'changed',
  'Sentinel should mark changed items when the source evidence signature differs from the last seen value.',
);
assert.equal(
  findAction(buildLiveShiftSentinelItems(rankedActions, { seenSnapshot: { 'system-health-0': sentinelItems[0].signature }, hasSeenBaseline: true }), 'shift-exceptions').status,
  'new',
  'Sentinel should mark newly appearing urgent items after a seen baseline exists.',
);
const perCardSeenSnapshot = { 'system-health-0': sentinelItems[0].signature };
const perCardSeenItems = buildLiveShiftSentinelItems(rankedActions, { seenSnapshot: perCardSeenSnapshot, hasSeenBaseline: false });
assert.equal(findAction(perCardSeenItems, 'system-health-0').status, 'seen', 'Per-card Sentinel acknowledgement should mark only that exact card seen.');
assert.equal(findAction(perCardSeenItems, 'shift-exceptions').status, 'current', 'Per-card Sentinel acknowledgement should not create a global baseline that makes already-visible sibling cards look new.');
const changedSingleSeenItems = buildLiveShiftSentinelItems(
  rankedActions.map((action) => action.key === 'system-health-0'
    ? { ...action, evidence: { ...action.evidence, warning: 'Main Exit kiosk is offline' } }
    : action),
  { seenSnapshot: perCardSeenSnapshot, hasSeenBaseline: false },
);
assert.equal(findAction(changedSingleSeenItems, 'system-health-0').status, 'changed', 'A per-card seen item should still become changed when its own deterministic signature changes.');

const closeoutProofSentinel = findAction(buildLiveShiftSentinelItems(buildProactiveActions({
  date: '2026-06-26',
  shiftCloseout: {
    date: '2026-06-26',
    closeout: null,
    blockers: [{
      id: 'missing-clock-outs',
      label: 'Missing clock-outs',
      proof: {
        label: 'missing clock-outs',
        count: 1,
        href: '/exceptions?date=2026-06-26&status=open&type=missing_clock_out&exception_key=one&intent=correct',
        exact: true,
      },
    }],
    can_complete: false,
  },
})), 'shift-closeout-pending');
const closeoutProofChanged = buildLiveShiftSentinelItems(buildProactiveActions({
  date: '2026-06-26',
  shiftCloseout: {
    date: '2026-06-26',
    closeout: null,
    blockers: [{
      id: 'missing-clock-outs',
      label: 'Missing clock-outs',
      proof: {
        label: 'missing clock-outs',
        count: 2,
        href: '/exceptions?date=2026-06-26&status=open&type=missing_clock_out&exception_key=two&intent=correct',
        exact: true,
      },
    }],
    can_complete: false,
  },
}), {
  seenSnapshot: { 'shift-closeout-pending': closeoutProofSentinel.signature },
  hasSeenBaseline: false,
});
assert.equal(
  findAction(closeoutProofChanged, 'shift-closeout-pending').status,
  'changed',
  'Closeout Sentinel signatures should include blocker proof identity so shifted source proof is not left marked seen.',
);
const viewerSentinelSnapshot = getLiveShiftSentinelSnapshot(buildLiveShiftSentinelItems(buildProactiveActions({
  ...mixedRiskPayload,
  currentRole: 'viewer',
})));
const adminSentinelAfterRoleResolution = buildLiveShiftSentinelItems(buildProactiveActions({
  ...mixedRiskPayload,
  currentRole: 'admin',
}), {
  seenSnapshot: viewerSentinelSnapshot,
  hasSeenBaseline: true,
});
assert.equal(
  findAction(adminSentinelAfterRoleResolution, 'system-health-0').status,
  'seen',
  'Sentinel signatures should ignore role-derived CTA and href changes when the source evidence has not changed.',
);
const criticalExceptionA = buildLiveShiftSentinelItems(buildProactiveActions({
  date: '2026-06-26',
  shiftExceptions: {
    date: '2026-06-26',
    exceptions: [{ key: '2026-06-26:missing_arrival:w1', type: 'missing_arrival', status: 'open', severity: 'critical' }],
    summary: {
      total: 1,
      open: 1,
      critical: 1,
      warning: 0,
      info: 0,
      by_type: { missing_arrival: 1 },
      by_status: { open: 1 },
    },
  },
}));
const criticalExceptionB = buildLiveShiftSentinelItems(buildProactiveActions({
  date: '2026-06-26',
  shiftExceptions: {
    date: '2026-06-26',
    exceptions: [{ key: '2026-06-26:missing_arrival:w2', type: 'missing_arrival', status: 'open', severity: 'critical' }],
    summary: {
      total: 1,
      open: 1,
      critical: 1,
      warning: 0,
      info: 0,
      by_type: { missing_arrival: 1 },
      by_status: { open: 1 },
    },
  },
}), {
  seenSnapshot: getLiveShiftSentinelSnapshot(criticalExceptionA),
  hasSeenBaseline: true,
});
assert.equal(
  findAction(criticalExceptionB, 'shift-exceptions').status,
  'changed',
  'Generic critical-exception Sentinel signatures should include date and exception row identity, not only aggregate counts.',
);
const focusedExceptionSetA = buildLiveShiftSentinelItems(buildProactiveActions({
  date: '2026-06-26',
  shiftExceptions: {
    date: '2026-06-26',
    exceptions: [
      { key: '2026-06-26:missing_clock_out:w2', type: 'missing_clock_out', status: 'open' },
      { key: '2026-06-26:missing_clock_out:w3', type: 'missing_clock_out', status: 'open' },
      { key: '2026-06-26:recognition_review:a1', type: 'recognition_review', status: 'open' },
      { key: '2026-06-26:recognition_review:a2', type: 'recognition_review', status: 'open' },
    ],
    summary: {
      total: 4,
      open: 4,
      critical: 0,
      warning: 4,
      info: 0,
      by_type: { missing_clock_out: 2, recognition_review: 2 },
      by_status: { open: 4 },
    },
  },
}));
const focusedExceptionSetB = buildLiveShiftSentinelItems(buildProactiveActions({
  date: '2026-06-26',
  shiftExceptions: {
    date: '2026-06-26',
    exceptions: [
      { key: '2026-06-26:missing_clock_out:w2', type: 'missing_clock_out', status: 'open' },
      { key: '2026-06-26:missing_clock_out:w4', type: 'missing_clock_out', status: 'open' },
      { key: '2026-06-26:recognition_review:a1', type: 'recognition_review', status: 'open' },
      { key: '2026-06-26:recognition_review:a3', type: 'recognition_review', status: 'open' },
    ],
    summary: {
      total: 4,
      open: 4,
      critical: 0,
      warning: 4,
      info: 0,
      by_type: { missing_clock_out: 2, recognition_review: 2 },
      by_status: { open: 4 },
    },
  },
}), {
  seenSnapshot: getLiveShiftSentinelSnapshot(focusedExceptionSetA),
  hasSeenBaseline: true,
});
assert.equal(
  findAction(focusedExceptionSetB, 'missing-clock-outs').status,
  'changed',
  'Focused missing-clock-out Sentinel signatures should include every matching exception row, not only the first one.',
);
assert.equal(
  findAction(focusedExceptionSetB, 'recognition-review').status,
  'changed',
  'Focused recognition-review Sentinel signatures should include every matching exception row, not only the first one.',
);

const trustPlan = buildProactiveShiftTrustPlan(rankedActions);
assert.deepEqual(
  plain(trustPlan),
  {
    actionKey: 'system-health-0',
    label: 'Do this first: Kiosk sync warning',
    description: 'Main Entry kiosk is offline.',
    impactLabel: 'Unblocks: Shift readiness + Closeout trust',
    href: '/kiosks',
    cta: 'Open kiosks',
    evidenceChips: ['1 offline kiosk'],
    outcomeChips: ['Clears shift readiness', 'Clears closeout trust'],
    proofLink: null,
    tone: 'red',
    access: 'operate',
    stale: false,
    staleLabel: null,
    unlocks: ['Shift readiness', 'Closeout trust'],
  },
  'Shift trust plan should summarize the already-ranked top action without creating a second ranking system.',
);

const offlineKiosk = rankedActions[0];
assert.equal(offlineKiosk.priority, 'critical', 'Offline kiosk warnings must be critical.');
assert.equal(offlineKiosk.severity, 'critical', 'Offline kiosk warnings must expose critical severity.');
assert.equal(offlineKiosk.blocksReadiness, true, 'Offline kiosks block readiness.');
assert.equal(offlineKiosk.blocksCloseout, true, 'Kiosk warnings should block closeout until acknowledged.');
assert.deepEqual(plain(offlineKiosk.actionability), { access: 'operate', canOperate: true, role: null }, 'Missing currentRole should preserve the legacy operate contract.');
assert.deepEqual(offlineKiosk.evidence.kioskCounts, { online: 1, stale: 0, offline: 1, never_synced: 0 }, 'Kiosk evidence must include fleet counts.');
assert.deepEqual(plain(offlineKiosk.freshness), {
  status: 'unknown',
  reason: 'not-provided',
  sourceKeys: ['system-health', 'kiosk'],
}, 'Missing signal freshness should preserve existing behavior while marking evidence freshness unknown.');

const statsSignalFailure = findAction(rankedActions, 'signal-failure-stats');
assert.deepEqual(plain(statsSignalFailure.freshness), {
  status: 'stale',
  reason: 'current-signal-failure',
  sourceKeys: ['stats', 'signal'],
  failed: true,
  current: true,
  unavailable: true,
  message: 'Dashboard stats could not refresh: upstream timeout',
}, 'Signal failure actions must be stale and unavailable even when freshness metadata is absent.');
assert.deepEqual(
  plain(getProactiveActionEvidenceChips(statsSignalFailure)),
  ['Stats signal'],
  'Signal failure evidence chips should name the unavailable dashboard source.',
);
assert.deepEqual(
  plain(getProactiveActionEvidenceChips(findAction(rankedActions, 'system-health-1'))),
  ['Face service warning'],
  'Face-service warning evidence chips should name the service source without borrowing kiosk fleet counts.',
);
assert.equal(findAction(rankedActions, 'system-health-1').href, '/enroll', 'Face-service warning actions should send operators to enrollment readiness instead of kiosk management.');
assert.equal(findAction(rankedActions, 'system-health-1').cta, 'Review face service', 'Face-service warning actions should name the face-service review handoff.');
const lowercaseFaceServiceActions = buildProactiveActions({
  systemHealth: {
    warnings: ['face service model is unavailable'],
  },
});
assert.equal(findAction(lowercaseFaceServiceActions, 'system-health-0').source, 'service', 'Face-service warning classification should be case-insensitive.');
assert.equal(findAction(lowercaseFaceServiceActions, 'system-health-0').href, '/enroll', 'Lowercase face-service warnings should keep the enrollment readiness handoff.');
assert.deepEqual(
  plain(getProactiveActionEvidenceChips(findAction(lowercaseFaceServiceActions, 'system-health-0'))),
  ['Face service warning'],
  'Lowercase face-service warnings should still get face-service-specific evidence.',
);

const invalidEnrollment = findAction(rankedActions, 'invalid-face');
assert.equal(invalidEnrollment.description, '1 worker needs re-enrollment because their face data is not kiosk-valid.');
assert.equal(invalidEnrollment.href, '/enroll?worker_id=w2', 'Invalid enrollment actions should deep-link to the first affected worker enrollment flow.');
assert.equal(invalidEnrollment.cta, 'Enroll face', 'Invalid enrollment actions should send operators directly to face enrollment.');
assert.equal(invalidEnrollment.blocksReadiness, true, 'Invalid enrollment blocks readiness.');
assert.deepEqual(plain(invalidEnrollment.evidence), {
  count: 1,
  firstWorkerId: 'w2',
  workerIds: ['w2'],
}, 'Invalid enrollment evidence should name affected workers and the exact first handoff target.');
assert.deepEqual(
  plain(getProactiveActionEvidenceChips(invalidEnrollment)),
  ['1 worker', 'Exact worker ready'],
  'Shared evidence chips should expose exact worker handoffs for operating enrollment actions.',
);

const missingEnrollment = findAction(rankedActions, 'missing-face');
assert.equal(missingEnrollment.description, '1 worker is missing face data for kiosk recognition.');
assert.equal(missingEnrollment.href, '/enroll?worker_id=w3', 'Missing enrollment actions should deep-link to the first affected worker enrollment flow.');
assert.equal(missingEnrollment.cta, 'Enroll face', 'Missing enrollment actions should send operators directly to face enrollment.');
assert.equal(missingEnrollment.priority, 'warning', 'Missing enrollment remains a warning action.');
assert.deepEqual(plain(missingEnrollment.evidence), {
  count: 1,
  firstWorkerId: 'w3',
  workerIds: ['w3'],
}, 'Missing enrollment evidence should name affected workers and the exact first handoff target.');

const exceptions = findAction(rankedActions, 'shift-exceptions');
assert.equal(exceptions.description, '3 exceptions need supervisor review, including 1 critical.');
assert.equal(exceptions.blocksCloseout, true, 'Open exceptions block closeout.');
assert.equal(exceptions.blocksReadiness, true, 'Critical exceptions block readiness.');
assert.equal(exceptions.href, '/exceptions?date=2026-06-26&status=open&severity=critical', 'Open exception actions should deep-link to the dated critical exception queue.');

const scheduleWarning = findAction(rankedActions, 'schedule-warning');
assert.deepEqual(
  plain(getProactiveActionEvidenceChips(scheduleWarning)),
  ['Schedule needs review'],
  'Schedule warning actions should expose a compact shared evidence chip.',
);

const closeout = findAction(rankedActions, 'shift-closeout-pending');
assert.equal(closeout.priority, 'closeout', 'Closeout should rank after warning actions.');
assert.equal(closeout.severity, 'warning', 'Closeout with blockers should still show warning severity.');
assert.equal(closeout.description, '1 closeout checklist item needs acknowledgement: Critical exceptions.');
assert.equal(closeout.cta, 'Close shift', 'Legacy closeout CTA should remain operational when no role is supplied.');
assert.equal(closeout.href, '/closeout?date=2026-06-26', 'Closeout actions should preserve the selected date.');
assert.equal(closeout.evidence.firstBlockerLabel, 'Critical exceptions', 'Closeout evidence should preserve the first blocker label.');
assert.deepEqual(plain(closeout.evidence.firstBlockerProof), {
  label: 'open critical exceptions',
  count: 1,
  href: '/exceptions?date=2026-06-26&status=open&severity=critical&exception_key=2026-06-26%3Acritical%3Aw2',
  exact: true,
}, 'Closeout evidence should preserve first blocker proof without rerouting the action away from closeout.');
const correctionProofAction = {
  source: 'closeout',
  evidence: {
    firstBlockerProof: {
      href: '/exceptions?date=2026-06-26&status=open&type=missing_clock_out&exception_key=2026-06-26%3Amissing_clock_out%3Aw2&intent=correct',
      exact: true,
    },
  },
  actionability: { access: 'operate', canOperate: true, role: 'admin' },
};
assert.deepEqual(plain(getProactiveActionProofLink(correctionProofAction)), {
  href: '/exceptions?date=2026-06-26&status=open&type=missing_clock_out&exception_key=2026-06-26%3Amissing_clock_out%3Aw2&intent=correct',
  label: 'Open exact source',
}, 'Operating roles should keep exact closeout proof links intact.');
assert.deepEqual(plain(getProactiveActionProofLink({
  ...correctionProofAction,
  actionability: { access: 'review', canOperate: false, role: 'viewer' },
})), {
  href: '/exceptions?date=2026-06-26&status=open&type=missing_clock_out&exception_key=2026-06-26%3Amissing_clock_out%3Aw2',
  label: 'Review exact source',
}, 'Review-only roles should preserve exact proof row context while stripping correction intent.');
assert.deepEqual(plain(getProactiveActionProofLink({
  ...correctionProofAction,
  actionability: { access: 'operate', canOperate: true, role: null },
})), {
  href: '/exceptions?date=2026-06-26&status=open&type=missing_clock_out&exception_key=2026-06-26%3Amissing_clock_out%3Aw2',
  label: 'Review exact source',
}, 'Unknown roles should use review-safe closeout proof links until portal role resolution completes.');
const closeoutProofPlan = buildProactiveShiftTrustPlan(buildProactiveActions({
  date: '2026-06-26',
  shiftCloseout: {
    date: '2026-06-26',
    closeout: null,
    blockers: [{
      id: 'missing-clock-outs',
      label: 'Missing clock-outs',
      proof: {
        label: 'missing clock-out exceptions',
        count: 1,
        href: '/exceptions?date=2026-06-26&status=open&type=missing_clock_out&exception_key=2026-06-26%3Amissing_clock_out%3Aw2&intent=correct',
        exact: true,
      },
    }],
    can_complete: false,
  },
  currentRole: 'admin',
}));
assert.equal(closeoutProofPlan.actionKey, 'shift-closeout-pending', 'Blocked closeout can be the next best action when higher-risk blockers are absent.');
assert.deepEqual(plain(closeoutProofPlan.proofLink), {
  href: '/exceptions?date=2026-06-26&status=open&type=missing_clock_out&exception_key=2026-06-26%3Amissing_clock_out%3Aw2&intent=correct',
  label: 'Open Missing clock-outs source',
}, 'Shift trust plan should expose blocker-specific exact closeout proof links for operating roles.');
assert.deepEqual(
  plain(closeoutProofPlan.evidenceChips),
  ['1 blocker', 'Missing clock-outs', 'Exact source ready'],
  'Shift trust plan should carry the first closeout blocker label before source-proof chips.',
);
assert.equal(closeoutProofPlan.description, '1 closeout checklist item needs acknowledgement: Missing clock-outs.', 'Shift trust plan should name the closeout blocker that should be handled first.');
const multiBlockerCloseoutPlan = buildProactiveShiftTrustPlan(buildProactiveActions({
  date: '2026-06-26',
  shiftCloseout: {
    date: '2026-06-26',
    closeout: null,
    blockers: [
      {
        id: 'missing-clock-outs',
        label: 'Missing clock-outs',
        proof: {
          label: 'missing clock-out exceptions',
          count: 2,
          href: '/exceptions?date=2026-06-26&status=open&type=missing_clock_out',
          exact: false,
        },
      },
      {
        id: 'recognition-review',
        label: 'Recognition reviews',
      },
    ],
    can_complete: false,
  },
}));
assert.equal(multiBlockerCloseoutPlan.description, '2 closeout checklist items need acknowledgement. Start with Missing clock-outs.', 'Multi-blocker closeout plans should point supervisors at the first blocker without hiding the total count.');
assert.deepEqual(
  plain(multiBlockerCloseoutPlan.evidenceChips),
  ['2 blockers', 'Missing clock-outs', 'Source proof ready'],
  'Multi-blocker closeout evidence chips should include the first blocker and grouped proof status.',
);
const viewerCloseoutProofPlan = buildProactiveShiftTrustPlan(buildProactiveActions({
  date: '2026-06-26',
  shiftCloseout: {
    date: '2026-06-26',
    closeout: null,
    blockers: [{
      id: 'missing-clock-outs',
      label: 'Missing clock-outs',
      proof: {
        label: 'missing clock-out exceptions',
        count: 1,
        href: '/exceptions?date=2026-06-26&status=open&type=missing_clock_out&exception_key=2026-06-26%3Amissing_clock_out%3Aw2&intent=correct',
        exact: true,
      },
    }],
    can_complete: false,
  },
  currentRole: 'viewer',
}));
assert.deepEqual(plain(viewerCloseoutProofPlan.proofLink), {
  href: '/exceptions?date=2026-06-26&status=open&type=missing_clock_out&exception_key=2026-06-26%3Amissing_clock_out%3Aw2',
  label: 'Review Missing clock-outs source',
}, 'Shift trust plan should strip correction intent from exact closeout proof links for review-only roles while naming the blocker.');

const notArrived = findAction(rankedActions, 'not-arrived');
assert.equal(notArrived.priority, 'info', 'Not-arrived attendance is informational after closeout work.');
assert.equal(notArrived.description, '2 active workers have no clock-in scans today.');
assert.equal(notArrived.href, '/briefing?date=2026-06-26&status=missing', 'Attendance actions should deep-link to the dated missing-worker briefing filter.');
assert.equal(notArrived.cta, 'Review missing', 'Not-arrived actions should point supervisors at the missing-worker review.');
assert.deepEqual(
  plain(getProactiveActionEvidenceChips(notArrived)),
  ['2 missing scans', 'Worker list ready'],
  'Roster-backed missing-arrival actions should show that the worker list is ready in Briefing.',
);
const statsOnlyNotArrived = findAction(buildProactiveActions({
  date: '2026-06-26',
  workers: [],
  stats: { notArrived: 2 },
}), 'not-arrived');
assert.equal(
  statsOnlyNotArrived.description,
  '2 missing arrivals are reported from attendance stats today.',
  'Stats-only missing-arrival actions should describe stats evidence without implying worker rows were loaded.',
);
assert.deepEqual(
  plain(getProactiveActionEvidenceChips(statsOnlyNotArrived)),
  ['2 missing scans'],
  'Stats-only missing-arrival actions should not claim a worker list is ready.',
);

const focusedExceptionActions = buildProactiveActions({
  date: '2026-06-26',
  shiftExceptions: {
    date: '2026-06-26',
    exceptions: [
      { key: '2026-06-26:missing_clock_out:w2', type: 'missing_clock_out', status: 'open' },
      { key: '2026-06-26:missing_clock_out:w3', type: 'missing_clock_out', status: 'open' },
      { key: '2026-06-26:recognition_review:a1', type: 'recognition_review', status: 'open' },
      { type: 'recognition_review', status: 'resolved' },
    ],
    summary: {
      total: 4,
      open: 3,
      critical: 0,
      warning: 3,
      info: 0,
      by_type: { missing_clock_out: 2, recognition_review: 2 },
      by_status: { open: 3, resolved: 1 },
    },
  },
});

assert.deepEqual(actionKeys(focusedExceptionActions), [
  'missing-clock-outs',
  'recognition-review',
  'shift-exceptions',
], 'Open exception type rows should create focused action cards before the generic exception action.');
assert.deepEqual(
  plain(buildLiveShiftSentinelItems(focusedExceptionActions).map((item) => ({ key: item.key, kind: item.kind }))),
  [
    { key: 'missing-clock-outs', kind: 'missing-clock-out' },
    { key: 'recognition-review', kind: 'recognition-review' },
  ],
  'Live Shift Sentinel should call out missing clock-outs and recognition reviews as focused urgent live conditions.',
);
const clockOutAction = findAction(focusedExceptionActions, 'missing-clock-outs');
assert.equal(clockOutAction.description, '2 workers are still clocked in after the scheduled shift end.');
assert.equal(clockOutAction.href, '/exceptions?date=2026-06-26&status=open&type=missing_clock_out&exception_key=2026-06-26%3Amissing_clock_out%3Aw2&intent=correct', 'Missing clock-out actions should deep-link to the first filtered correction target.');
assert.equal(clockOutAction.blocksCloseout, true, 'Missing clock-outs should keep closeout attention visible.');
assert.equal(clockOutAction.blocksReadiness, false, 'Missing clock-outs should not block start-of-shift readiness.');
assert.deepEqual(plain(clockOutAction.evidence), {
  type: 'missing_clock_out',
  count: 2,
  firstExceptionKey: '2026-06-26:missing_clock_out:w2',
  matchingExceptionKeys: [
    '2026-06-26:missing_clock_out:w2',
    '2026-06-26:missing_clock_out:w3',
  ],
  byType: { missing_clock_out: 2, recognition_review: 2 },
}, 'Missing clock-out evidence should preserve the exception type mix.');
const recognitionReviewAction = findAction(focusedExceptionActions, 'recognition-review');
assert.equal(recognitionReviewAction.description, '1 recognition exception needs supervisor review before closeout.');
assert.equal(recognitionReviewAction.href, '/exceptions?date=2026-06-26&status=open&type=recognition_review&exception_key=2026-06-26%3Arecognition_review%3Aa1', 'Recognition review actions should deep-link to the first filtered source exception.');
assert.equal(recognitionReviewAction.cta, 'Review recognition');
assert.equal(recognitionReviewAction.blocksCloseout, true, 'Recognition review should remain closeout work.');
assert.deepEqual(plain(recognitionReviewAction.evidence), {
  type: 'recognition_review',
  count: 1,
  firstExceptionKey: '2026-06-26:recognition_review:a1',
  matchingExceptionKeys: ['2026-06-26:recognition_review:a1'],
  byType: { missing_clock_out: 2, recognition_review: 2 },
}, 'Recognition review evidence should preserve the exact source exception key when available.');

const focusedViewerActions = buildProactiveActions({
  date: '2026-06-26',
  shiftExceptions: {
    date: '2026-06-26',
    exceptions: [
      { key: '2026-06-26:missing_clock_out:w2', type: 'missing_clock_out', status: 'open' },
      { key: '2026-06-26:recognition_review:a1', type: 'recognition_review', status: 'open' },
    ],
    summary: {
      total: 2,
      open: 2,
      critical: 0,
      warning: 2,
      info: 0,
      by_type: { missing_clock_out: 1, recognition_review: 1 },
      by_status: { open: 2 },
    },
  },
  currentRole: 'viewer',
});
assert.equal(findAction(focusedViewerActions, 'missing-clock-outs').cta, 'Review clock-outs', 'Viewer clock-out actions should keep the focused CTA.');
assert.equal(findAction(focusedViewerActions, 'missing-clock-outs').href, '/exceptions?date=2026-06-26&status=open&type=missing_clock_out&exception_key=2026-06-26%3Amissing_clock_out%3Aw2', 'Viewer clock-out actions should keep exact row context without write intent.');
assert.equal(findAction(focusedViewerActions, 'recognition-review').cta, 'Review recognition', 'Viewer recognition actions should keep the focused CTA.');
assert.equal(findAction(focusedViewerActions, 'recognition-review').href, '/exceptions?date=2026-06-26&status=open&type=recognition_review&exception_key=2026-06-26%3Arecognition_review%3Aa1', 'Viewer recognition actions should keep exact source exception context.');

const resolvedTypeOnlyActions = buildProactiveActions({
  date: '2026-06-26',
  shiftExceptions: {
    date: '2026-06-26',
    exceptions: [
      { type: 'missing_clock_out', status: 'resolved' },
      { type: 'recognition_review', status: 'ignored' },
      { type: 'scan_sequence', status: 'open' },
    ],
    summary: {
      total: 3,
      open: 1,
      critical: 0,
      warning: 1,
      info: 0,
      by_type: { missing_clock_out: 1, recognition_review: 1, scan_sequence: 1 },
      by_status: { open: 1, resolved: 1, ignored: 1 },
    },
  },
});

assert.deepEqual(actionKeys(resolvedTypeOnlyActions), [
  'shift-exceptions',
], 'Resolved or ignored exception types must not keep focused proactive actions alive.');

const allOpenTypeSummaryActions = buildProactiveActions({
  date: '2026-06-26',
  shiftExceptions: {
    date: '2026-06-26',
    summary: {
      total: 2,
      open: 2,
      critical: 0,
      warning: 2,
      info: 0,
      by_type: { missing_clock_out: 1, recognition_review: 1 },
      by_status: { open: 2 },
    },
  },
});

assert.deepEqual(actionKeys(allOpenTypeSummaryActions), [
  'missing-clock-outs',
  'recognition-review',
  'shift-exceptions',
], 'When every summarized exception is open, by_type should be safe to use as the fallback focused action source.');
const fallbackRecognitionReviewAction = findAction(allOpenTypeSummaryActions, 'recognition-review');
assert.equal(fallbackRecognitionReviewAction.href, '/exceptions?date=2026-06-26&status=open&type=recognition_review', 'Summary-only recognition actions should not invent an exact exception key.');
assert.equal(fallbackRecognitionReviewAction.evidence.firstExceptionKey, null, 'Summary-only recognition evidence should keep exact source absence explicit.');
assert.deepEqual(plain(fallbackRecognitionReviewAction.evidence.matchingExceptionKeys), [], 'Summary-only recognition evidence should keep exact matching-row absence explicit.');

const staleFreshnessPayload = {
  stats: {
    lastSuccessAt: '2026-06-26T13:50:00.000Z',
    failed: true,
    current: true,
    message: 'Stats signal failed now',
  },
  workers: {
    lastSuccessAt: '2026-06-26T13:50:00.000Z',
    failed: true,
    current: true,
    message: 'Worker roster signal failed now',
  },
  attendance: {
    lastSuccessAt: '2026-06-26T13:50:00.000Z',
    failed: true,
    current: true,
    message: 'Attendance signal failed now',
  },
  'system-health': {
    lastSuccessAt: '2026-06-26T13:50:00.000Z',
    failed: true,
    current: true,
    message: 'System health signal failed now',
  },
  'shift-exceptions': {
    lastSuccessAt: '2026-06-26T13:50:00.000Z',
    failed: true,
    current: true,
    message: 'Shift exceptions signal failed now',
  },
  'shift-closeout': {
    lastSuccessAt: '2026-06-26T13:50:00.000Z',
    failed: true,
    current: true,
    message: 'Shift closeout signal failed now',
  },
};

const staleFreshnessActions = buildProactiveActions({
  ...mixedRiskPayload,
  signalFreshness: staleFreshnessPayload,
});

assert.deepEqual(actionKeys(staleFreshnessActions), actionKeys(rankedActions), 'Freshness metadata must not change proactive action ranking.');
assertCurrentSignalFailure(findAction(staleFreshnessActions, 'system-health-0'), ['system-health', 'kiosk'], 'System health signal failed now');
assertCurrentSignalFailure(findAction(staleFreshnessActions, 'shift-exceptions'), ['shift-exceptions', 'exceptions'], 'Shift exceptions signal failed now');
assertCurrentSignalFailure(findAction(staleFreshnessActions, 'shift-closeout-pending'), ['shift-closeout', 'closeout'], 'Shift closeout signal failed now');
assertCurrentSignalFailure(findAction(staleFreshnessActions, 'invalid-face'), ['workers', 'enrollment'], 'Worker roster signal failed now');
assertCurrentSignalFailure(findAction(staleFreshnessActions, 'not-arrived'), ['attendance'], 'Attendance signal failed now');
assertCurrentSignalFailure(findAction(staleFreshnessActions, 'schedule-warning'), ['stats', 'schedule'], 'Stats signal failed now');
assert.equal(getProactiveActionFreshnessLabel(findAction(staleFreshnessActions, 'system-health-0').freshness), 'Cached health evidence', 'Shared freshness labels should name cached health evidence for action cards.');
assert.equal(getProactiveActionFreshnessLabel(findAction(staleFreshnessActions, 'invalid-face').freshness), 'Cached roster evidence', 'Shared freshness labels should name cached roster evidence for action cards.');
assert.equal(getProactiveActionFreshnessLabel(findAction(staleFreshnessActions, 'not-arrived').freshness), 'Cached attendance evidence', 'Shared freshness labels should name cached attendance evidence for action cards.');
assert.equal(
  buildProactiveShiftTrustPlan(staleFreshnessActions).description,
  'Main Entry kiosk is offline. Cached health evidence.',
  'Shift trust plan should disclose which cached source evidence supports the recommendation.',
);
assert.equal(buildProactiveShiftTrustPlan(staleFreshnessActions).staleLabel, 'Cached health evidence', 'Shift trust plan should distinguish source-specific cached evidence from unavailable evidence.');

const unavailableTrustPlan = buildProactiveShiftTrustPlan(buildProactiveActions({
  signalFailures: [
    {
      key: 'system-health',
      label: 'Kiosk and system health',
      href: '/kiosks',
      message: 'Kiosk and system health could not refresh: 503 Service Unavailable',
    },
  ],
}));
assert.equal(unavailableTrustPlan.description, 'Kiosk and system health could not refresh: 503 Service Unavailable. Health signal unavailable.', 'Shift trust plan should avoid claiming cached evidence when no last success exists.');
assert.equal(unavailableTrustPlan.staleLabel, 'Health signal unavailable', 'Shift trust plan should label no-cache failures by unavailable source signal.');
assert.deepEqual(
  plain(unavailableTrustPlan.evidenceChips),
  ['Health signal'],
  'Unavailable source trust plans should show which source signal failed.',
);
const unknownCachedTrustPlan = buildProactiveShiftTrustPlan(buildProactiveActions({
  signalFailures: [{
    key: 'vendor-feed',
    label: 'Vendor feed',
    href: '/reports',
    message: 'Vendor feed could not refresh',
  }],
  signalFreshness: {
    'vendor-feed': {
      lastSuccessAt: '2026-06-26T13:50:00.000Z',
      failed: true,
      current: true,
      message: 'Vendor feed failed now',
    },
  },
}));
assert.equal(unknownCachedTrustPlan.description, 'Vendor feed could not refresh. Cached evidence.', 'Unknown stale sources should preserve the generic cached-evidence fallback.');
assert.equal(unknownCachedTrustPlan.staleLabel, 'Cached evidence', 'Unknown stale sources should keep the generic cached stale badge.');
const unknownUnavailableTrustPlan = buildProactiveShiftTrustPlan(buildProactiveActions({
  signalFailures: [{
    key: 'vendor-feed',
    label: 'Vendor feed',
    href: '/reports',
    message: 'Vendor feed could not refresh',
  }],
}));
assert.equal(unknownUnavailableTrustPlan.description, 'Vendor feed could not refresh. Source unavailable.', 'Unknown unavailable sources should preserve the generic source-unavailable fallback.');
assert.equal(unknownUnavailableTrustPlan.staleLabel, 'Source unavailable', 'Unknown unavailable sources should keep the generic unavailable stale badge.');
assert.equal(getProactiveActionFreshnessLabel(findAction(buildProactiveActions({
  signalFailures: [{
    key: 'vendor-feed',
    label: 'Vendor feed',
    href: '/reports',
    message: 'Vendor feed could not refresh',
  }],
}), 'signal-failure-vendor-feed').freshness), 'Source unavailable', 'Unknown action-card freshness labels should preserve the generic unavailable fallback.');

const adminActions = buildProactiveActions({ ...mixedRiskPayload, currentRole: 'admin' });
assert.deepEqual(actionKeys(adminActions), actionKeys(rankedActions), 'Admin role must not change proactive action ranking.');
assert.equal(findAction(adminActions, 'shift-closeout-pending').cta, 'Review closeout', 'Admins should review closeout until the shift can complete.');
assert.deepEqual(
  plain(findAction(adminActions, 'system-health-0').actionability),
  { access: 'operate', canOperate: true, role: 'admin' },
  'Admin actionability should allow operations across proactive sources.',
);
assert.equal(findAction(adminActions, 'invalid-face').href, '/enroll?worker_id=w2', 'Admins should land on the exact invalid-face worker enrollment flow.');

const enrollmentActions = buildProactiveActions({ ...mixedRiskPayload, currentRole: 'enrollment' });
assert.deepEqual(actionKeys(enrollmentActions), actionKeys(rankedActions), 'Enrollment role must not change proactive action ranking.');
assert.equal(findAction(enrollmentActions, 'shift-closeout-pending').cta, 'Review closeout', 'Enrollment users should review closeout until the shift can complete.');
assert.deepEqual(
  plain(findAction(enrollmentActions, 'shift-exceptions').actionability),
  { access: 'operate', canOperate: true, role: 'enrollment' },
  'Enrollment users should retain exception-review actionability.',
);
assert.deepEqual(
  plain(findAction(enrollmentActions, 'invalid-face').actionability),
  { access: 'operate', canOperate: true, role: 'enrollment' },
  'Enrollment users should retain face-enrollment actionability.',
);
assert.equal(findAction(enrollmentActions, 'invalid-face').cta, 'Enroll face', 'Enrollment users should be sent to the enrollment workflow.');
assert.equal(findAction(enrollmentActions, 'invalid-face').href, '/enroll?worker_id=w2', 'Enrollment users should not be sent to the admin-heavy workers page or a generic enrollment flow when exact worker evidence exists.');
assert.equal(findAction(enrollmentActions, 'missing-face').href, '/enroll?worker_id=w3', 'Enrollment users should land on the exact missing-face worker enrollment flow.');
assert.equal(findAction(enrollmentActions, 'system-health-0').cta, 'Inspect readiness', 'Enrollment users should inspect admin-only kiosk readiness instead of being sent to operate it.');
assert.equal(findAction(enrollmentActions, 'system-health-0').href, '/briefing?date=2026-06-26', 'Enrollment users should keep dated briefing context when kiosk readiness is review-only.');
assert.equal(findAction(enrollmentActions, 'schedule-warning').href, '/briefing?date=2026-06-26', 'Enrollment users should keep dated briefing context when schedule actions are review-only.');
assert.deepEqual(
  plain(findAction(enrollmentActions, 'system-health-0').actionability),
  { access: 'review', canOperate: false, role: 'enrollment' },
  'Enrollment actionability should mark kiosk actions as review-only.',
);
const enrollmentRosterFailureActions = buildProactiveActions({
  date: '2026-06-26',
  signalFailures: [{
    key: 'workers',
    label: 'Worker roster',
    href: '/workers',
    message: 'Worker roster could not refresh: upstream timeout',
  }],
  currentRole: 'enrollment',
});
const enrollmentRosterFailure = findAction(enrollmentRosterFailureActions, 'signal-failure-workers');
assert.equal(enrollmentRosterFailure.href, '/briefing?date=2026-06-26', 'Enrollment users should not be sent to generic enrollment when the worker roster signal has no exact worker target.');
assert.equal(enrollmentRosterFailure.cta, 'Inspect briefing', 'Enrollment worker-roster failures should use review-safe CTA copy.');
assert.deepEqual(
  plain(enrollmentRosterFailure.actionability),
  { access: 'review', canOperate: false, role: 'enrollment' },
  'Enrollment users can operate exact enrollment handoffs, but not non-targeted worker-roster failures.',
);
assert.deepEqual(
  plain(getProactiveActionEvidenceChips(enrollmentRosterFailure)),
  ['Roster signal'],
  'Worker-roster source failures should name the roster signal without implying an exact worker handoff.',
);
const enrollmentRosterFailurePlan = buildProactiveShiftTrustPlan(enrollmentRosterFailureActions);
assert.equal(enrollmentRosterFailurePlan.label, 'Review this first: Worker roster unavailable', 'Worker-roster failure trust plans should use review-safe lead copy for enrollment users.');
assert.equal(enrollmentRosterFailurePlan.description, 'Worker roster could not refresh: upstream timeout. Roster signal unavailable.', 'Worker-roster failure trust plans should name the unavailable roster signal.');
assert.equal(enrollmentRosterFailurePlan.staleLabel, 'Roster signal unavailable', 'Worker-roster failure trust plans should badge the unavailable roster signal.');

const viewerActions = buildProactiveActions({ ...mixedRiskPayload, currentRole: 'viewer' });
assert.deepEqual(actionKeys(viewerActions), actionKeys(rankedActions), 'Viewer role must not change proactive action ranking.');
assert.equal(findAction(viewerActions, 'shift-closeout-pending').cta, 'Review closeout', 'Viewers should review closeout state instead of being told to close the shift.');
assert.equal(findAction(viewerActions, 'shift-closeout-pending').href, '/closeout?date=2026-06-26', 'Viewers can inspect closeout state on the dated read route.');
assert.equal(findAction(viewerActions, 'shift-exceptions').cta, 'Review exceptions', 'Viewers should review exceptions instead of operating them.');
assert.equal(findAction(viewerActions, 'shift-exceptions').href, '/exceptions?date=2026-06-26&status=open&severity=critical', 'Viewers should keep the exact exception filter context.');
assert.equal(findAction(viewerActions, 'invalid-face').cta, 'Inspect briefing', 'Viewers should inspect enrollment issues from a read-oriented surface.');
assert.equal(findAction(viewerActions, 'invalid-face').href, '/briefing?date=2026-06-26', 'Viewers should keep dated briefing context for enrollment issues.');
assert.deepEqual(
  plain(getProactiveActionEvidenceChips(findAction(viewerActions, 'invalid-face'))),
  ['1 worker', 'Worker identified'],
  'Shared evidence chips should avoid exact-worker-ready copy when the visible enrollment action is review-only.',
);
assert.equal(findAction(viewerActions, 'system-health-0').cta, 'Inspect readiness', 'Viewers should inspect kiosk readiness instead of operating it.');
assert.equal(findAction(viewerActions, 'system-health-0').href, '/briefing?date=2026-06-26', 'Viewers should keep dated briefing context for kiosk readiness.');
assert.equal(findAction(viewerActions, 'schedule-warning').href, '/briefing?date=2026-06-26', 'Viewers should keep dated briefing context for schedule warnings.');
assert.equal(findAction(viewerActions, 'not-arrived').cta, 'Review missing', 'Viewers should get read-safe missing-worker copy.');
assert.equal(findAction(viewerActions, 'not-arrived').href, '/briefing?date=2026-06-26&status=missing', 'Viewer attendance actions should keep the dated missing-worker briefing filter.');
assert.deepEqual(
  plain(findAction(viewerActions, 'shift-closeout-pending').actionability),
  { access: 'review', canOperate: false, role: 'viewer' },
  'Viewer actionability should mark write workflows as review-only.',
);
const viewerTrustPlan = buildProactiveShiftTrustPlan(viewerActions);
assert.equal(viewerTrustPlan.label, 'Review this first: Kiosk sync warning', 'Viewer shift trust plan should use review-safe language.');
assert.equal(viewerTrustPlan.href, '/briefing?date=2026-06-26', 'Viewer shift trust plan should inherit the dated role-safe review href.');
assert.equal(viewerTrustPlan.cta, 'Inspect readiness', 'Viewer shift trust plan should inherit the role-safe review CTA.');
assert.equal(viewerTrustPlan.access, 'review', 'Viewer shift trust plan should expose review access.');
assert.equal(viewerTrustPlan.impactLabel, 'Review focus: Shift readiness + Closeout trust', 'Viewer shift trust plan should not use unblock copy for review-only users.');
assert.deepEqual(
  plain(viewerTrustPlan.outcomeChips),
  ['Review shift readiness', 'Review closeout trust'],
  'Viewer shift trust plan should use review-safe outcome copy instead of unlock/clear language.',
);
assert.deepEqual(
  plain(getProactiveActionOutcomeChips(findAction(adminActions, 'system-health-0'))),
  ['Clears shift readiness', 'Clears closeout trust'],
  'Operating users should see the outcomes an action clears.',
);
assert.deepEqual(
  plain(getProactiveActionOutcomeChips(findAction(viewerActions, 'system-health-0'))),
  ['Review shift readiness', 'Review closeout trust'],
  'Review-only users should not see copy implying they can clear readiness or closeout trust.',
);
assert.deepEqual(
  plain(getProactiveActionOutcomeChips(findAction(adminActions, 'shift-closeout-pending'))),
  ['Clears closeout trust'],
  'Blocked closeout actions should emphasize closeout trust before signoff.',
);

const dashboardSource = read('src/app/page.tsx');
const middlewareSource = read('src/proxy.ts');
assert.match(dashboardSource, /usePortalRole|portalMembers\.current/, 'Dashboard should resolve role through the shared Convex portal role hook.');
assert.match(dashboardSource, /const dashboardRole = currentRole \|\| 'viewer'/, 'Dashboard should default unresolved portal roles to review-safe actionability until role lookup confirms operator access.');
assert.match(dashboardSource, /currentRole:\s*dashboardRole/, 'Dashboard proactive actions should use the review-safe role fallback instead of raw unresolved role state.');
assert.match(dashboardSource, /\/api\/workers\?scope=dashboard/, 'Dashboard should use the read-scoped worker roster endpoint so review-only roles do not see artificial roster failures.');
assert.match(dashboardSource, /\/api\/shift-briefing\?date=\$\{today\}/, 'Dashboard should fetch the Morning Readiness Brief so home can lead with shared shift trust status.');
assert.match(dashboardSource, /setShiftBriefing\(json\)/, 'Dashboard should store the shared briefing payload for the command inbox.');
assert.match(dashboardSource, /if \(json\?\.backend_unavailable\)[\s\S]*key:\s*signal\.key,[\s\S]*label:\s*signal\.label,[\s\S]*href:\s*signal\.href,[\s\S]*Morning readiness brief is unavailable[\s\S]*successfulKeys\.add\(signal\.key\)/, 'Dashboard should treat backend-unavailable briefing fallbacks as unavailable signals instead of fresh shift-trust evidence.');
assert.match(dashboardSource, /const trustBrief = shiftBriefing && !shiftBriefing\.backend_unavailable \? shiftBriefing\.shift_trust_brief : null/, 'Dashboard should derive command status from the server-backed shift trust brief only when the briefing signal is available.');
assert.match(dashboardSource, /const trustSummary = trustBrief\?\.summary_sentence \|\| readinessCopy\.description/, 'Dashboard should render deterministic shift trust copy with a local readiness fallback.');
assert.match(dashboardSource, /buildLiveShiftSentinelItems/, 'Dashboard should derive the Live Shift Sentinel strip from the deterministic proactive action model.');
assert.doesNotMatch(dashboardSource, /Next best action/, 'Dashboard must ship one ranked action queue (the Sentinel), not a competing next-best-action summary.');
assert.doesNotMatch(dashboardSource, /commandGroups/, 'Dashboard must not re-render ranked actions as parallel command groups.');
assert.match(dashboardSource, /aria-label=\{`\$\{item\.label\} Sentinel evidence`\}/, 'Sentinel evidence chips should be labelled for assistive technology.');
assert.match(dashboardSource, /item\.proofLink && \([\s\S]*href=\{item\.proofLink\.href\}[\s\S]*\{item\.proofLink\.label\}/, 'Sentinel cards should render the secondary proof link when exact source proof exists.');
assert.match(dashboardSource, /fw-gatekeeper:live-shift-sentinel:v1:seen/, 'Dashboard Sentinel seen state should stay scoped to client session storage.');
assert.match(dashboardSource, /Live Shift Sentinel/, 'Dashboard command inbox should render the Live Shift Sentinel surface.');
assert.match(dashboardSource, /Urgent live changes and current risk/, 'Dashboard Sentinel should name urgent live changes and current risk explicitly.');
assert.match(dashboardSource, /Mark Sentinel seen/, 'Dashboard Sentinel should support lightweight in-app acknowledgement without server persistence.');
assert.match(dashboardSource, /markSentinelSeen\(sentinelItems,\s*true\)/, 'Dashboard bulk Sentinel acknowledgement should explicitly establish the full current baseline.');
assert.match(dashboardSource, /sentinelItems\.every\(\(item\) => Boolean\(next\[item\.key\]\)\)/, 'Dashboard per-card Sentinel acknowledgement should only establish a full baseline once all current cards are covered.');
assert.match(dashboardSource, /const activeSentinelKeySignature = sentinelItems\.map\(\(item\) => item\.key\)\.sort\(\)\.join\('\|'\)/, 'Dashboard Sentinel pruning should track the active current-risk key set.');
assert.match(dashboardSource, /if \(loading \|\| !sentinelStorageReady\) return;[\s\S]*Object\.fromEntries\(Object\.entries\(previous\)\.filter\(\(\[key\]\) => activeKeys\.has\(key\)\)\)/, 'Dashboard Sentinel seen-state pruning should wait until loaded storage and live data are ready, then drop cleared risks.');
assert.match(dashboardSource, /writeSentinelState\(next,\s*sentinelHasSeenBaseline\)/, 'Dashboard Sentinel pruning should preserve the persisted full-baseline flag while dropping cleared risk signatures.');
assert.match(dashboardSource, /hasFullBaseline:\s*parsed\.hasFullBaseline === true/, 'Dashboard Sentinel storage should persist the full-baseline flag separately from per-card seen signatures.');
assert.match(dashboardSource, /setSentinelHasSeenBaseline\(storedSentinel\.hasFullBaseline\)/, 'Dashboard Sentinel reloads should restore only the persisted full-baseline flag.');
assert.doesNotMatch(dashboardSource, /setSentinelHasSeenBaseline\(Boolean\(storedSnapshot\)\)/, 'Dashboard Sentinel reloads must not infer a full baseline from any stored per-card snapshot.');
assert.match(dashboardSource, /function readSentinelState\(\)[\s\S]*try \{[\s\S]*window\.sessionStorage\.getItem\(SENTINEL_SEEN_STORAGE_KEY\)[\s\S]*catch \{[\s\S]*return null/, 'Dashboard Sentinel should treat blocked session storage reads as optional seen-state loss.');
assert.match(dashboardSource, /function writeSentinelState[\s\S]*try \{[\s\S]*window\.sessionStorage\.setItem[\s\S]*catch \{[\s\S]*Sentinel seen state is optional client-local UI state/, 'Dashboard Sentinel should not crash when optional seen-state writes are blocked.');
assert.match(dashboardSource, /No urgent Sentinel items from loaded signals[\s\S]*Source gaps will appear here/, 'Dashboard Sentinel empty state should avoid false all-clear when source signals are unavailable.');
assert.match(dashboardSource, /Shift Command <span className="text-gold">Inbox<\/span>/, 'Dashboard home should present the command inbox as the first mental model.');
assert.match(dashboardSource, /Open Morning Readiness Brief/, 'Dashboard command inbox should link naturally to the full Morning Readiness Brief.');
assert.match(dashboardSource, /No readiness, kiosk, exception, closeout, enrollment, schedule, or arrival issues need review right now\./, 'Dashboard Action Center empty state should name the full shift-trust scope.');
assert.doesNotMatch(dashboardSource, />Stale data</, 'Dashboard action cards should not render generic stale-data badges.');
assert.match(dashboardSource, /const opsKioskHref = canOpenAdminOps \? '\/kiosks' : `\/briefing\?date=\$\{actionDate\}`/, 'Today Ops kiosk CTA should keep non-admin users in dated briefing review context.');
assert.match(dashboardSource, /const morningBriefHref = `\/briefing\?date=\$\{actionDate\}`/, 'Dashboard should derive a dated Morning Readiness Brief href.');
assert.match(dashboardSource, /const canOpenAdminOps = dashboardRole === 'admin'/, 'Dashboard admin-only CTAs should use the review-safe dashboard role fallback.');
assert.match(dashboardSource, /const canOpenEnrollmentOps = dashboardRole === 'admin' \|\| dashboardRole === 'enrollment'/, 'Dashboard should distinguish enrollment-capable users from review-only users after applying the safe role fallback.');
assert.match(dashboardSource, /const opsEnrollmentHref = canOpenEnrollmentOps \? '\/enroll' : `\/briefing\?date=\$\{actionDate\}`/, 'Face-service warning links should keep review-only users in dated briefing context.');
assert.match(dashboardSource, /const opsExceptionsHref = `\/exceptions\?date=\$\{actionDate\}&status=open`/, 'Today Ops exceptions CTA should preserve dated open-exception context.');
assert.match(dashboardSource, /const systemHealthCta = canOpenAdminOps \? 'Manage kiosks' : 'Review readiness'/, 'System Health CTA copy should distinguish admin operations from review mode.');
assert.match(dashboardSource, /const rosterFailureHref = canOpenAdminOps \? '\/workers' : `\/briefing\?date=\$\{actionDate\}`/, 'Worker roster failure links should avoid sending enrollment users into a generic enrollment flow without worker context.');
assert.match(dashboardSource, /const signalFailureHrefs: Partial<Record<SignalFailureKey, string>> = \{[\s\S]*workers: rosterFailureHref,[\s\S]*'system-health': opsKioskHref,[\s\S]*'shift-briefing': morningBriefHref,[\s\S]*\}/, 'Live data gap links should downgrade worker, system-health, and briefing failures to role-safe review targets.');
assert.match(dashboardSource, /href=\{opsExceptionsHref\}[\s\S]*Review open exceptions/, 'Command inbox should render the dated open-exception CTA.');
assert.match(dashboardSource, /href=\{`\/closeout\?date=\$\{actionDate\}`\}[\s\S]*Check closeout/, 'Command inbox should keep closeout review one click away.');
assert.match(dashboardSource, /function isFaceServiceWarning\(warning: string\)[\s\S]*toLowerCase\(\)\.includes\('face service'\)/, 'Dashboard face-service warning classification should be case-insensitive.');
assert.match(dashboardSource, /function isCriticalSystemWarning\(warning: string\)[\s\S]*normalized\.includes\('offline'\)[\s\S]*normalized\.includes\('unavailable'\)/, 'Dashboard system-warning severity should use case-insensitive critical warning semantics.');
assert.match(dashboardSource, /tone: isCriticalSystemWarning\(warning\) \? 'red' as const : 'amber' as const/, 'Recent Events system warning tone should reuse critical warning semantics.');
assert.match(dashboardSource, /const faceServiceWarning = isFaceServiceWarning\(warning\)[\s\S]*href: faceServiceWarning \? opsEnrollmentHref : opsKioskHref/, 'Recent Events system warnings should reuse role-safe kiosk and enrollment review targets.');
assert.match(dashboardSource, /href=\{signalFailureHrefs\[failure\.key\] \|\| failure\.href\}/, 'Live data gap cards should render role-safe href overrides when available.');
assert.match(dashboardSource, /href=\{opsKioskHref\}[\s\S]*\{systemHealthCta\}/, 'System Health header CTA should reuse the role-safe kiosk review target and copy.');
assert.match(dashboardSource, /Open exception work/, 'Dashboard should surface open exception work before supporting health and roster evidence.');
assert.match(dashboardSource, /Suggested resolutions/, 'Dashboard exception work should foreground server-backed suggested resolutions.');
assert.match(dashboardSource, /exception\.suggested_resolution/, 'Dashboard exception cards should consume server-backed suggested_resolution data.');
assert.match(dashboardSource, /const exceptionSignalUnavailable = isSignalStale\(signalFreshness, 'shift-exceptions'\)[\s\S]*Boolean\(shiftExceptions\?\.backend_unavailable\)[\s\S]*!shiftExceptions/, 'Dashboard exception work should detect failed, backend-unavailable, and missing exception signals.');
assert.match(dashboardSource, /const openExceptionMetric = exceptionSignalUnavailable[\s\S]*\? '—'[\s\S]*trustBrief\?\.source_counts\.open_exceptions \?\? shiftExceptions\.summary\.open/, 'Dashboard command metrics should show an unavailable placeholder instead of zero when exception data cannot be trusted.');
assert.match(dashboardSource, /const openExceptionMetricLabel = exceptionSignalUnavailable \? 'queue unavailable' : 'need disposition'/, 'Dashboard open-exceptions metric should label unavailable exception signals.');
assert.match(dashboardSource, /\{openExceptionMetric\}[\s\S]*\{openExceptionMetricLabel\}/, 'Dashboard command inbox should render the guarded open-exception metric and caption.');
assert.match(dashboardSource, /const closeoutSignalUnavailable = isSignalStale\(signalFreshness, 'shift-closeout'\)[\s\S]*Boolean\(shiftCloseout\?\.backend_unavailable\)[\s\S]*!shiftCloseout/, 'Dashboard command metrics should detect failed, backend-unavailable, and missing closeout signals.');
assert.match(dashboardSource, /const closeoutRiskMetric = closeoutSignalUnavailable && !trustBrief[\s\S]*\? '—'[\s\S]*trustBrief\?\.closeout_risks\.length \?\? shiftCloseout\?\.blockers\.length \?\? 0/, 'Dashboard closeout risk metric should show an unavailable placeholder when no closeout source can be trusted.');
assert.match(dashboardSource, /const closeoutRiskMetricLabel = closeoutSignalUnavailable && !trustBrief \? 'closeout unavailable' : 'blockers \/ risks'/, 'Dashboard closeout risk metric should label unavailable closeout signals.');
assert.match(dashboardSource, /\{closeoutRiskMetric\}[\s\S]*\{closeoutRiskMetricLabel\}/, 'Dashboard command inbox should render the guarded closeout risk metric and caption.');
assert.match(dashboardSource, /exceptionSignalUnavailable \? \([\s\S]*role="status"[\s\S]*exceptionUnavailableCopy[\s\S]*\) : openExceptionRows\.length > 0/, 'Dashboard exception work should show an unavailable/cached state before any all-clear copy.');
assert.match(dashboardSource, /Shift exceptions are unavailable, so exception work cannot be treated as clear yet\./, 'Dashboard exception unavailable copy should avoid false all-clear reassurance.');
assert.match(dashboardSource, /const shouldOpenCorrectionIntent = canOperate && resolution\.can_apply && isCorrectionResolution\(resolution\.action\)/, 'Dashboard exception CTAs should carry correction intent only for operating roles and correctable suggestions.');
assert.match(dashboardSource, /if \(canOperate && resolution\.href && !shouldOpenCorrectionIntent\)[\s\S]*return resolution\.href/, 'Dashboard exception CTAs should use server-provided suggested-resolution hrefs for non-correction operator actions.');
assert.match(dashboardSource, /const canApplyResolution = canOperateExceptionWork && resolution\.can_apply[\s\S]*const primaryExceptionCta = canApplyResolution \? resolution\.cta : 'Review source'[\s\S]*\{primaryExceptionCta\} →/, 'Dashboard exception CTAs should avoid correction-action copy when the server disables a suggested resolution.');
assert.match(dashboardSource, /getRoleSafeExceptionSourceHref\(exception, canOperateExceptionWork\)/, 'Dashboard exception source links should be role-safe.');
assert.match(dashboardSource, /System Health[\s\S]*Recent Events[\s\S]*Attendance roster/, 'Dashboard should keep health, events, and roster as supporting evidence below command work.');
assert.match(source, /action\.source === 'enrollment'[\s\S]*evidence\.firstWorkerId[\s\S]*action\.actionability\.canOperate && action\.href\.startsWith\('\/enroll\?worker_id='\) \? 'Exact worker ready' : 'Worker identified'/, 'Enrollment evidence chips should disclose exact worker handoffs only when the visible action can open the exact enrollment target.');
assert.match(source, /action\.key === 'recognition-review'[\s\S]*evidence\.firstExceptionKey[\s\S]*Exact row ready/, 'Recognition review evidence chips should disclose exact exception-row handoffs.');
assert.match(source, /action\.source === 'closeout'[\s\S]*evidence\.firstBlockerProof[\s\S]*Exact source ready/, 'Closeout evidence chips should disclose exact closeout proof handoffs when available.');
assert.doesNotMatch(dashboardSource, /from 'convex\/react'/, 'Dashboard should not add a Convex client query just to resolve action roles.');
assert.doesNotMatch(middlewareSource, /portal[-]role/, 'Middleware must not keep an allowlist entry for the removed portal role API route.');
assert.match(middlewareSource, /pathname === '\/api\/workers' && method === 'GET' && searchParams\.get\('scope'\) === 'dashboard'[\s\S]*\['admin', 'enrollment', 'viewer'\]/, 'Middleware should allow dashboard-scoped worker reads for all dashboard portal roles.');
assert.match(middlewareSource, /pathname === '\/api\/stats' \|\| pathname === '\/api\/attendance' \|\| pathname === '\/api\/system-health'[\s\S]*\['admin', 'enrollment', 'viewer'\]/, 'Middleware should allow dashboard read signals for all dashboard portal roles without broadening write APIs.');
const workersRoute = read('src/app/api/workers/route.ts');
const systemHealthRoute = read('src/app/api/system-health/route.ts');
assert.match(workersRoute, /requireDashboardWorkerRead\s*\(/, 'Workers API should separate dashboard roster reads from admin-only worker management.');
assert.match(workersRoute, /scope'\) === 'dashboard'[\s\S]*requireDashboardWorkerRead\(req\)[\s\S]*includeEncodings: false/, 'Dashboard worker reads should allow safe roster fields without raw face encodings.');
assert.match(systemHealthRoute, /hasValidPortalSession\(req,\s*\['admin',\s*'enrollment',\s*'viewer'\]\)/, 'System health read API should allow dashboard roles to see real readiness signals.');

const backendUnavailableActions = buildProactiveActions({
  shiftExceptions: {
    date: '2026-06-26',
    backend_unavailable: true,
    warning: 'Shift exception storage is waiting for the Convex functions to deploy.',
    summary: { total: 0, open: 0, critical: 0, warning: 0, info: 0 },
  },
  shiftCloseout: {
    date: '2026-06-26',
    backend_unavailable: true,
    warning: 'Shift closeout is waiting for the Convex functions to deploy.',
    closeout: null,
    blockers: [],
    can_complete: false,
  },
});

assert.deepEqual(actionKeys(backendUnavailableActions), [
  'shift-exceptions-unavailable',
  'shift-closeout-unavailable',
  'shift-closeout-pending',
], 'Deployment-pending shift storage must be visible instead of looking all clear.');
assert.equal(backendUnavailableActions[0].blocksCloseout, true, 'Unavailable exception storage blocks closeout trust.');
assert.equal(backendUnavailableActions[0].href, '/exceptions?date=2026-06-26&status=open', 'Unavailable exception storage should still link to the dated exception view.');
assert.deepEqual(
  plain(getProactiveActionEvidenceChips(backendUnavailableActions[0])),
  ['Exception signal'],
  'Unavailable exception storage should name the failed exception signal.',
);
assert.equal(buildProactiveShiftTrustPlan(backendUnavailableActions).staleLabel, 'Exception signal unavailable', 'Deployment-pending exception storage should name the unavailable source in the next-best stale badge.');
assert.equal(backendUnavailableActions[1].description, 'Shift closeout is waiting for the Convex functions to deploy.');
assert.equal(backendUnavailableActions[1].href, '/closeout?date=2026-06-26', 'Unavailable closeout storage should still link to the dated closeout view.');
assert.deepEqual(
  plain(getProactiveActionEvidenceChips(backendUnavailableActions[1])),
  ['Closeout signal'],
  'Unavailable closeout storage should name the failed closeout signal.',
);

const completedCloseout = buildProactiveActions({
  workers: [],
  stats: { notArrived: 0 },
  shiftExceptions: { summary: { open: 0, critical: 0, warning: 0, info: 0 } },
  shiftCloseout: {
    closeout: {
      status: 'completed',
      completed_at: '2026-06-26T20:30:00.000Z',
    },
  },
});

assert.deepEqual(actionKeys(completedCloseout), ['shift-closeout-complete'], 'Completed closeout should be the only informational action in a clean closeout payload.');
assert.match(completedCloseout[0].description, /^Today's supervisor closeout was completed at /, 'Completed closeout description should include a display time.');
assert.equal(completedCloseout[0].blocksCloseout, false, 'Completed closeout must not block closeout.');
assert.deepEqual(
  plain(getProactiveActionEvidenceChips(completedCloseout[0])),
  ['Signoff complete'],
  'Completed closeout actions should expose a compact signoff evidence chip.',
);

const noActions = buildProactiveActions({
  signalFailures: [],
  workers: [
    { id: 'w1', name: 'Ava', department: 'Dock', encoding_status: 'valid', has_face_encoding: true, status: 'in' },
  ],
  systemHealth: {
    checked_at: '2026-06-26T14:00:00.000Z',
    kiosks: { total: 1, counts: { online: 1, stale: 0, offline: 0, never_synced: 0 } },
    warnings: [],
  },
  stats: { totalWorkers: 1, notArrived: 0 },
  shiftExceptions: { summary: { open: 0, critical: 0, warning: 0, info: 0 } },
});

assert.deepEqual(JSON.parse(JSON.stringify(noActions)), [], 'Clean payloads without closeout work should return no proactive actions.');
assert.equal(buildProactiveShiftTrustPlan(noActions), null, 'Clean payloads should not invent a next-best action.');

const inactiveWorkerScanActions = buildProactiveActions({
  date: '2026-06-26',
  shiftExceptions: {
    date: '2026-06-26',
    exceptions: [
      { key: '2026-06-26:inactive_worker_scan:w9:a9', type: 'inactive_worker_scan', severity: 'critical', status: 'open' },
    ],
    summary: {
      total: 1,
      open: 1,
      critical: 1,
      warning: 0,
      info: 0,
      by_type: { inactive_worker_scan: 1 },
      by_status: { open: 1 },
    },
  },
});
assert.equal(findAction(inactiveWorkerScanActions, 'shift-exceptions').priority, 'critical', 'An open deactivated-worker scan should raise a critical exception action.');
assert.equal(findAction(inactiveWorkerScanActions, 'shift-exceptions').severity, 'critical', 'An open deactivated-worker scan should be a critical exception action.');
assert.deepEqual(plain(findAction(inactiveWorkerScanActions, 'shift-exceptions').evidence.criticalExceptionKeys), ['2026-06-26:inactive_worker_scan:w9:a9'], 'Critical exception evidence should keep the deactivated-worker scan key.');

console.log('Proactive actions contract passed');
