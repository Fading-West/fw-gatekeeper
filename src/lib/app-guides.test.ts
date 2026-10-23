import { describe, expect, it } from 'vitest';
import { appGuides, canRoleUseGuide, getGuideSteps, searchAppGuides } from './app-guides';

function guide(path: string) {
  const match = appGuides.find((item) => item.path === path);
  if (!match) throw new Error(`Missing guide ${path}`);
  return match;
}

describe('role-aware application guides', () => {
  it('gives viewers review and handoff steps instead of mutation instructions', () => {
    const workerSteps = getGuideSteps(guide('/workers'), 'viewer').join(' ');
    const exceptionSteps = getGuideSteps(guide('/exceptions'), 'viewer').join(' ');

    expect(workerSteps).not.toContain('Use Enroll Face');
    expect(workerSteps).toContain('enrollment operator or administrator');
    expect(exceptionSteps).not.toContain('save the correction');
    expect(exceptionSteps).toContain('authorized supervisor');
  });

  it('keeps operator instructions actionable for authorized roles', () => {
    expect(getGuideSteps(guide('/workers'), 'enrollment').join(' ')).toContain('Use Enroll Face');
    expect(getGuideSteps(guide('/briefing'), 'enrollment').join(' ')).toContain('work attendance exceptions');
    expect(getGuideSteps(guide('/briefing'), 'enrollment').join(' ')).not.toContain('attendance changes to an administrator');
    expect(getGuideSteps(guide('/schedules'), 'admin').join(' ')).toContain('Set the days');
  });

  it('explains audited direct corrections on the Activity Log only to operators', () => {
    for (const role of ['admin', 'enrollment'] as const) {
      const steps = getGuideSteps(guide('/log'), role).join(' ');
      expect(steps).toContain('Add missing punch');
      expect(steps).toMatch(/audited, and can be reversed/);
      expect(steps).toMatch(/reassign[^.]*void it with Correct, then use Add missing punch/);
    }
    for (const role of ['viewer', undefined] as const) {
      expect(getGuideSteps(guide('/log'), role).join(' ')).not.toMatch(/Add missing punch|Use Correct|reverse a mistaken/);
    }
  });

  it('defaults unresolved roles to the least-privileged instructions', () => {
    const workerSteps = getGuideSteps(guide('/workers'), undefined).join(' ');

    expect(workerSteps).not.toContain('Use Enroll Face');
    expect(workerSteps).toContain('enrollment operator or administrator');
  });

  it('describes only controls and evidence available in the application', () => {
    const scheduleSteps = ['admin', 'enrollment', 'viewer'].flatMap((role) =>
      getGuideSteps(guide('/schedules'), role as 'admin' | 'enrollment' | 'viewer'),
    ).join(' ');
    const accountSteps = getGuideSteps(guide('/accounts'), 'admin').join(' ');
    const recognitionSteps = ['admin', 'enrollment', 'viewer'].flatMap((role) =>
      getGuideSteps(guide('/calibration/recognition'), role as 'admin' | 'enrollment' | 'viewer'),
    ).join(' ');

    expect(scheduleSteps).not.toMatch(/effective date/i);
    expect(accountSteps).not.toMatch(/deactivate/i);
    expect(accountSteps).toMatch(/reset its password|update its role/i);
    expect(recognitionSteps).not.toMatch(/second-best|choose the .*worker/i);
    expect(recognitionSteps).toMatch(/decision/i);
    expect(recognitionSteps).toMatch(/confidence/i);
    expect(recognitionSteps).toMatch(/kiosk/i);
    expect(recognitionSteps).toMatch(/margin/i);
  });

  it('keeps shared tips and related links safe for viewers', () => {
    const sharedViewerCopy = appGuides
      .filter((item) => canRoleUseGuide(item, 'viewer'))
      .flatMap((item) => [...item.tips, ...item.related.map((link) => link.label)])
      .join(' ');

    expect(sharedViewerCopy).not.toMatch(/save notes|reopen a closeout|resolve exceptions|correct an exception|re-enroll a worker|manage schedules/i);
  });

  it('points kiosk troubleshooting at visible evidence and named external configuration', () => {
    const kioskSteps = getGuideSteps(guide('/kiosks'), 'admin').join(' ');

    expect(kioskSteps).not.toContain('Open the affected kiosk');
    expect(kioskSteps).toContain('Registered kiosks');
    expect(kioskSteps).toContain('Render');
    expect(kioskSteps).toContain('Pi environment');
  });
});

describe('guide search', () => {
  it('finds task language and synonyms, not only page titles', () => {
    expect(searchAppGuides('missed clock-out', 'admin').map((item) => item.path)).toContain('/exceptions');
    expect(searchAppGuides('low confidence', 'enrollment').map((item) => item.path)).toContain('/calibration/recognition');
  });

  it('never returns guides unavailable to the current role', () => {
    expect(searchAppGuides('camera', 'viewer').map((item) => item.path)).not.toContain('/enroll');
    expect(searchAppGuides('', 'viewer').map((item) => item.path)).not.toContain('/kiosks');
    expect(searchAppGuides('', 'viewer').map((item) => item.path)).not.toContain('/accounts');
  });

  it('searches the current role-specific steps', () => {
    expect(searchAppGuides('authorized supervisor', 'viewer').map((item) => item.path)).toContain('/exceptions');
  });
});
