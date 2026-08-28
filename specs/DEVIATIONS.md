# Specification Deviations

## D-001 2026-08-28 specs/config-parameters.md
Change: R18 prime-time block gained an opt-in retryable mode via the new
  per-model `primeTimeRetry` flag (Glossary and specs/v2/provider-model.md
  updated in the same change).
Was: a request whose model is inside an active prime-time window always
  failed before any network request and was never classified as retryable —
  a terminal message error.
Now: with `primeTimeRetry: true` on the merged model entry the same failure
  is retryable; the retry delay is the time remaining until the window ends
  (the first instant at which the R17 window predicate no longer matches)
  instead of exponential backoff, and the provider `options.retries` budget
  still caps total attempts. Default (absent or `false`) keeps the terminal
  behavior.
Code impact: `modelFields` config schema and runtime model propagation gain
  the optional `primeTimeRetry` boolean (V1 request path); the session retry
  policy must classify the prime-time gate failure as retryable when the flag
  is set and schedule the attempt at the computed window end; V2
  `ModelV2.Info` carries the optional plain field
  (specs/v2/provider-model.md).
Tests: the existing terminal prime-time gate test stays for the default;
  add flag-on cases — retryable classification, delay equal to remaining
  window time (cross-midnight and weekday-drop-at-midnight windows included),
  attempt cap still enforced, terminal surfacing after budget exhaustion.
Review focus: window-end computation must reuse the R17 predicate rules
  exactly (window timezone, weekday, seconds-of-day, inclusive bounds) rather
  than a parallel implementation; a retry firing inside a still-active window
  is rescheduled, and budget exhaustion surfaces the terminal prime-time
  error.
