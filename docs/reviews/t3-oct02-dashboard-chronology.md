# Show presence from absolute attendance chronology

Rank20; high attendance trust benefit is an engineering estimate. The dashboard ignored original instants and compared factory wall-time strings. An exit at01:10CST incorrectly lost to an earlier arrival at01:50CDT during DST fallback. Dashboard presence now reuses the canonical attendance clock, including timestamp_utc, and uses stable event IDs for equal instants. Invalid legacy timestamps cannot become the latest confirmed event.

Acceptance: fallback later exits and identical wall times show the latest absolute evidence; input order does not change results; corrections and ordinary legacy factory timestamps remain supported. Regression tests cover both input orders, fall-back instants, same-instant stable IDs and corrupt legacy timestamps. Historical57 fixed other consumers; this dashboard defect is distinct, and89–108 are not recounted.

Source-only: exact tests/types/lint/build, normal viewer/supervisor synthetic runtime acceptance, CI and combined integration gates remain pending serialized admission. No deployment, physical camera or production acceptance claimed.
