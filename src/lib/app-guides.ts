export type GuideRole = 'admin' | 'enrollment' | 'viewer';
export type GuideGroup = 'Shift' | 'Evidence' | 'Setup';

export type GuideLink = {
  href: string;
  label: string;
};

export type AppGuide = {
  path: string;
  group: GuideGroup;
  title: string;
  eyebrow: string;
  purpose: string;
  steps: string[];
  stepsByRole?: Partial<Record<GuideRole, string[]>>;
  tips: string[];
  keywords?: string[];
  related: GuideLink[];
  roles?: GuideRole[];
  roleNotes?: Partial<Record<GuideRole, string>>;
};

export const appGuides: AppGuide[] = [
  {
    path: '/',
    group: 'Shift',
    title: 'Dashboard',
    eyebrow: 'Your starting point',
    purpose: 'See whether today’s shift is healthy and identify the first item that needs attention.',
    steps: [
      'Check the readiness summary and system warnings first.',
      'Open the highest-priority action instead of scanning every page.',
      'Use recent activity to confirm attendance is arriving from the kiosks.',
    ],
    stepsByRole: {
      viewer: [
        'Check the readiness summary and system warnings first.',
        'Open the highest-priority item and review its supporting evidence.',
        'Share the worker, kiosk, or exception details with an authorized operator when action is required.',
      ],
    },
    tips: ['Refresh if the freshness time is old.', 'Red items need action; amber items need review; green items are on track.'],
    related: [{ href: '/briefing', label: 'Open shift briefing' }, { href: '/exceptions', label: 'Review exceptions' }],
  },
  {
    path: '/briefing',
    group: 'Shift',
    title: 'Shift Briefing',
    eyebrow: 'Before the shift',
    purpose: 'Compare scheduled coverage with attendance, enrollment readiness, and kiosk health before work begins.',
    steps: [
      'Choose the work date and confirm the expected headcount.',
      'Read First actions from top to bottom.',
      'Open any linked worker, exception, or kiosk issue and resolve it at the source.',
      'Refresh the briefing to confirm the warning cleared.',
    ],
    stepsByRole: {
      enrollment: [
        'Choose the work date and confirm the expected headcount.',
        'Read First actions from top to bottom.',
        'Handle face-enrollment items and work attendance exceptions; send schedule, kiosk, or worker-record changes to an administrator.',
        'Refresh the briefing to confirm the latest status.',
      ],
      viewer: [
        'Choose the work date and confirm the expected headcount.',
        'Read First actions from top to bottom and open the supporting evidence.',
        'Record the affected worker, department, or kiosk for the shift lead.',
        'Refresh after an authorized operator confirms the issue was handled.',
      ],
    },
    tips: ['Use department filters when a supervisor owns only one area.', 'Print or export when a durable handoff is needed.'],
    related: [{ href: '/schedules', label: 'Review schedules' }, { href: '/exceptions', label: 'Open exception queue' }],
  },
  {
    path: '/exceptions',
    group: 'Shift',
    title: 'Shift Exceptions',
    eyebrow: 'During the shift',
    purpose: 'Work attendance problems such as missing scans, late arrivals, bad sequences, and recognition reviews.',
    steps: [
      'Start with Critical, then work Warning items.',
      'Use the filters to narrow the queue without changing the underlying records.',
      'Open an item and compare its evidence before applying a correction.',
      'Add a clear reason, save the correction, and confirm the item resolves.',
    ],
    stepsByRole: {
      viewer: [
        'Start with Critical, then review Warning items.',
        'Use the filters to narrow the queue without changing any records.',
        'Open an item and confirm its worker, timestamps, and supporting evidence.',
        'Send the exception key and your findings to an authorized supervisor for correction.',
      ],
    },
    keywords: ['missed clock-out', 'late arrival', 'attendance correction', 'missing scan'],
    tips: ['Do not correct an event until the worker and timestamp are confirmed.', 'Export CSV for a supervisor handoff or audit.'],
    related: [{ href: '/log', label: 'Inspect activity evidence' }, { href: '/closeout', label: 'Review closeout' }],
    roleNotes: { viewer: 'Your account is review-only. Confirm the evidence, then hand the correction to an authorized supervisor.' },
  },
  {
    path: '/closeout',
    group: 'Shift',
    title: 'Shift Closeout',
    eyebrow: 'End of shift',
    purpose: 'Confirm the day is complete, record supervisor notes, and leave an auditable signoff.',
    steps: [
      'Review every checklist item and open any unresolved source link.',
      'Resolve open exceptions and workers who are still clocked in.',
      'Enter the supervisor name and useful handoff notes.',
      'Complete the closeout only after the readiness status is clear.',
    ],
    stepsByRole: {
      viewer: [
        'Review every checklist item and open any unresolved source link.',
        'Confirm which exceptions or clocked-in workers still need attention.',
        'Prepare the relevant details for the authorized shift supervisor.',
        'Return after signoff to verify the closeout status is complete.',
      ],
    },
    keywords: ['signoff', 'end of day', 'finish shift', 'supervisor notes'],
    tips: ['Keep useful handoff notes while work is in progress.', 'A signed-off closeout may need supervisor review after a correction.'],
    related: [{ href: '/exceptions', label: 'Review exceptions' }, { href: '/log', label: 'Review the day’s log' }],
    roleNotes: { viewer: 'Use this page to review closeout readiness. An authorized supervisor must save notes or complete signoff.' },
  },
  {
    path: '/log',
    group: 'Evidence',
    title: 'Activity Log',
    eyebrow: 'Attendance evidence',
    purpose: 'Inspect the effective clock-in and clock-out record and its correction history for a selected date.',
    steps: [
      'Choose the date or follow a source link from an exception.',
      'Confirm the worker, event type, time, and kiosk for the event in question.',
      'Review correction history to understand any supervisor changes.',
      'Export events or calculated hours when the record must be shared.',
    ],
    tips: ['A source-linked view highlights the relevant worker or event.', 'Create attendance corrections in Exceptions; authorized operators can reverse a recorded correction here with a reason.'],
    related: [{ href: '/exceptions', label: 'Review an exception' }, { href: '/closeout', label: 'Return to closeout' }],
  },
  {
    path: '/workers',
    group: 'Setup',
    title: 'Workers',
    eyebrow: 'People and recognition',
    purpose: 'Review worker records and see who is ready, missing face data, or needs re-enrollment.',
    steps: [
      'Check the recognition-ready, missing, and invalid totals.',
      'Find the person and confirm their name, employee ID, and department.',
      'Use Enroll Face for a new person or re-enroll for invalid face data.',
      'Administrators can edit worker details or deactivate old records.',
    ],
    stepsByRole: {
      enrollment: [
        'Check the recognition-ready, missing, and invalid totals.',
        'Find the person and confirm their name, employee ID, and department.',
        'Use Enroll Face for missing data or re-enroll an invalid face.',
        'Ask an administrator to correct worker details or deactivate an old record.',
      ],
      viewer: [
        'Check the recognition-ready, missing, and invalid totals.',
        'Find the person and confirm their name, employee ID, and department.',
        'Note whether their face data is ready, missing, or invalid.',
        'Send enrollment or record-change needs to an enrollment operator or administrator.',
      ],
    },
    keywords: ['employee', 'person', 'duplicate', 'missing face', 'invalid face', 're-enroll'],
    tips: ['Employee IDs should be unique.', 'Viewers can inspect records but cannot change them.'],
    related: [{ href: '/enroll', label: 'Enroll a face' }, { href: '/calibration/recognition', label: 'Open Recognition Lab' }],
    roleNotes: {
      viewer: 'Your account can review worker readiness but cannot edit records or enroll faces.',
      enrollment: 'You can enroll and re-enroll faces. Worker detail changes require an administrator.',
    },
  },
  {
    path: '/enroll',
    group: 'Setup',
    title: 'Face Enrollment',
    eyebrow: 'Recognition setup',
    purpose: 'Create reliable face data so a worker can be recognized at a gate kiosk.',
    steps: [
      'Find and select the correct worker before opening the camera.',
      'Confirm the employee ID and department to avoid duplicate records.',
      'Use even front lighting and remove hats, masks, and sunglasses.',
      'Keep the face inside the guide while the photos are captured.',
      'Confirm the saved result on Workers and allow the kiosk to sync.',
    ],
    stepsByRole: {
      enrollment: [
        'Find and select the correct worker before opening the camera.',
        'Confirm the employee ID and department; ask an administrator to fix incorrect worker details.',
        'Use even front lighting and remove hats, masks, and sunglasses.',
        'Keep the face inside the guide while the photos are captured.',
        'Confirm the saved result on Workers and allow the kiosk to sync.',
      ],
    },
    keywords: ['camera', 'face photo', 'recognition', 'new employee', 're-enroll'],
    tips: ['Re-enroll instead of creating a second record.', 'If recognition remains weak, capture again in better lighting.'],
    related: [{ href: '/workers', label: 'Check worker status' }, { href: '/kiosks', label: 'Check kiosk sync' }],
    roles: ['admin', 'enrollment'],
  },
  {
    path: '/schedules',
    group: 'Setup',
    title: 'Schedules',
    eyebrow: 'Expected coverage',
    purpose: 'Define when departments are expected to work so briefing and exception calculations have the right baseline.',
    steps: [
      'Review the active schedules before adding another one.',
      'Set the days, start and end time, and department.',
      'Avoid overlapping schedules for the same department unless intentional.',
      'Return to Briefing and confirm the expected coverage changed correctly.',
    ],
    stepsByRole: {
      enrollment: [
        'Review the active schedules and select the relevant department.',
        'Confirm the scheduled days, start time, end time, and department.',
        'Document any missing, overlapping, or incorrect coverage.',
        'Ask an administrator to make the change, then verify it in Briefing.',
      ],
      viewer: [
        'Review the active schedules and select the relevant department.',
        'Confirm the scheduled days, start time, end time, and department.',
        'Document any missing, overlapping, or incorrect coverage.',
        'Ask an administrator to make the change, then verify it in Briefing.',
      ],
    },
    keywords: ['shift time', 'coverage', 'department hours', 'work days'],
    tips: ['Viewers and enrollment users can review schedules; administrators manage them.', 'Use clear names that include the shift or department.'],
    related: [{ href: '/briefing', label: 'Verify shift coverage' }],
    roleNotes: {
      viewer: 'Your account can review schedules but cannot create or edit them.',
      enrollment: 'Your account can review schedules but cannot create or edit them.',
    },
  },
  {
    path: '/kiosks',
    group: 'Setup',
    title: 'Kiosks',
    eyebrow: 'Device readiness',
    purpose: 'Confirm gate devices are syncing workers and uploading attendance to the portal.',
    steps: [
      'Check the online, stale, offline, and never-synced totals.',
      'Find the affected device under Registered kiosks and compare the card’s last sync and attendance upload times.',
      'Match the card’s kiosk ID to the Pi, then verify the portal URL and KIOSK_API_KEY externally in Render and the Pi environment.',
      'Refresh after the device syncs and verify it returns online.',
    ],
    tips: ['Never paste the kiosk API key into notes or screenshots.', 'A newly enrolled worker appears after the kiosk’s next successful sync.'],
    related: [{ href: '/workers', label: 'Check ready workers' }, { href: '/', label: 'Return to dashboard' }],
    roles: ['admin'],
  },
  {
    path: '/accounts',
    group: 'Setup',
    title: 'Accounts',
    eyebrow: 'Portal access',
    purpose: 'Create named portal accounts and give each person only the permissions required for their job.',
    steps: [
      'Enter the person’s work email and choose the lowest sufficient role.',
      'Generate an initial password and create the account.',
      'Share credentials directly with the user, not in a public channel.',
      'Use an existing account’s email to reset its password or update its role when access changes.',
    ],
    tips: ['Viewer is read-only; Enrollment can capture faces; Admin can change system data.', 'Use named accounts instead of shared credentials.'],
    related: [{ href: '/guide', label: 'Compare role workflows' }],
    roles: ['admin'],
  },
  {
    path: '/calibration/recognition',
    group: 'Evidence',
    title: 'Recognition Lab',
    eyebrow: 'Recognition evidence',
    purpose: 'Investigate uncertain matches and recognition quality without changing attendance records.',
    steps: [
      'Filter attempts by date, decision, review status, confidence, or kiosk.',
      'Start with unreviewed, low-confidence, rejected, or low-margin attempts.',
      'Compare the candidate name, score, margin, decision, and kiosk evidence.',
      'Mark the attempt Confirmed or Ignored, then re-enroll the worker or inspect the kiosk if the pattern repeats.',
    ],
    stepsByRole: {
      viewer: [
        'Filter attempts by date, decision, review status, confidence, or kiosk.',
        'Start with unreviewed, low-confidence, rejected, or low-margin attempts.',
        'Compare the candidate name, score, margin, decision, and kiosk evidence.',
        'Share the attempt, candidate, and kiosk details with an enrollment operator or administrator when action is needed.',
      ],
    },
    keywords: ['low confidence', 'wrong match', 'face match', 'recognition score', 'ambiguous'],
    tips: ['Use Exceptions for attendance corrections.', 'One weak attempt may be environmental; repeated weak attempts need action.'],
    related: [{ href: '/workers', label: 'Review worker readiness' }, { href: '/exceptions', label: 'Review attendance exceptions' }],
  },
];

export function getGuideForPath(pathname: string) {
  return appGuides.find((guide) => guide.path === pathname) ?? null;
}

export function canRoleUseGuide(guide: AppGuide, role: GuideRole | undefined) {
  return !guide.roles || (role !== undefined && guide.roles.includes(role));
}

export function getGuideSteps(guide: AppGuide, role: GuideRole | undefined) {
  const effectiveRole = role ?? 'viewer';
  return guide.stepsByRole?.[effectiveRole] || guide.steps;
}

export function searchAppGuides(query: string, role: GuideRole | undefined) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const available = appGuides.filter((guide) => canRoleUseGuide(guide, role));
  if (!normalizedQuery) return available;

  return available.filter((guide) => {
    const searchable = [
      guide.title,
      guide.eyebrow,
      guide.purpose,
      guide.group,
      ...getGuideSteps(guide, role),
      ...guide.tips,
      ...(guide.keywords || []),
    ].join(' ').toLocaleLowerCase();
    return searchable.includes(normalizedQuery);
  });
}
