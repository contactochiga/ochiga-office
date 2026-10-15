# `test-settings-providers-browser.js` intermittent failure — investigation (reported separately from S6.2)

**Symptom.** Three times during S6.1/S6.2 work the suite stopped with `Error: timeout waiting for: route settings/intelligence` (the step's 8 s budget): once during a full-suite run, and in two of three consecutive solo runs made while stale headless Chrome processes from earlier aborted runs were still alive. On the very next runs it passed. The product behaviour it asserts (provider cards, unknown/verified states, no controls) was correct every time it completed.

**What was tried (all against the same test, with richer diagnostics added: in-flight Chrome requests, failed requests, Office server connection count, page state):**
| Condition | Runs | Result |
|---|---|---|
| Idle machine, fresh Chrome profile each run | 8 | 8 pass (6–8 s) |
| Six busy-loop CPU hogs running | 8 | 8 pass (7–8 s) |
| A stale headless Chrome already holding the test's debugging port (9354) | 1 | pass (the test simply drove the stale browser) |
| Ten extra headless Chromes + eight CPU hogs, free memory near zero | 6 | 6 pass |
| Plain re-runs after the failures (before the diagnostics existed) | 9 | 9 pass |

**Conclusion.** Not reproducible on demand; it never failed in 32 runs after the three observed failures. The only consistent facts about the three failures: they occurred in the shortest per-step budget (8 s), on the first Intelligence navigation after Chrome had cold-started, on a busy host (a long full-suite run, or several orphaned Chrome instances and the 10-container Supabase fixture alive). That points to a **test-side timing sensitivity (cold Chrome + first load of the 17k-line `office.js` against an 8 s step budget)**, not to a Settings or Backend defect: the failing step is a plain navigation whose content the product serves correctly on every completed run, and no error or failed request was ever recorded by the application. I cannot rule out a rare environmental cause beyond that.

**Changes made.** The step wait was raised from 8 s to 15 s, and the failure message now carries the diagnostics (in-flight and failed requests, connection count, page state) so the next occurrence is attributable instead of a bare timeout. No product code was changed.

**Recommendations (not applied).** Launch test Chrome on a free port (`--remote-debugging-port=0`) with a unique profile and always reap it in `finally` (orphans accumulate when a run is killed by the shell timeout); give the first navigation of each suite a longer budget than later steps.
