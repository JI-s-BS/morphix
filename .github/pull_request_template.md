## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How it was checked

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] Tried it: <!-- in the browser / on which printer / with which slicer -->

## Printer safety (if this touches drivers, printing or temperatures)

- [ ] Nothing heats, moves or starts without the user confirming, and only when the printer state allows it
- [ ] Temperatures stay within the catalog model's limits
- [ ] Hardware status is honest: `verified: "protocol"` unless it ran on a real printer (which one?)
- [ ] No secrets in logs, errors, URLs or the browser
