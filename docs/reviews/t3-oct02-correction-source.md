# Exception correction evidence at commit

A missing-clock-out draft can remain open while a kiosk uploads the actual departure. A first correction commit now rechecks that the source exception still exists for the same date, worker and correctable action. Voids must identify that source's original raw event. A conflict returns HTTP 409, refreshes the exception queue and retains the draft for inspection without allowing another stale save. Explicit manual corrections remain available.

Existing request-ID receipts are checked before live source validation: a lost-response retry returns its committed correction even after that correction resolves the exception or is reversed. Authorization still precedes every replay. No raw attendance is rewritten.

Base: master `0ab3795986cb0bad446a644f7b91394a83f2cff8`. This change is outside PR101's single-active-void insertion; complete PR101 remains an integration prerequisite for its independent behavior.

Regression source: `convex/t3-correction-source.test.ts`; frontend conflict test accompanies the normal Exceptions path. All runtime/test/type/lint/build gates remain **pending** serialized host admission. Source implementation is not review-ready. Synthetic fixtures only; physical kiosk, deployed backend and production acceptance remain pending.
