# IPL 2027 Auction App — Critical Bugfixes Change Log

## Date: 2026-10-23
## Release: v1.1.0 (Cache Version v=14)

---

## 1. Summary of Fixed Critical Bugs

### Bug 1 — Participant Skips Triumph, But Next Player's Bidding Starts While Audio Plays
* **Root Cause**:
  1. Previously, when a sale occurred, the participant's modal displayed the Triumph card and began playing the team hook-line audio.
  2. If the participant clicked "Back to auction floor" (or if the host skipped the celebration on the server), the modal closed, but the floor UI immediately rendered the next player with an active bidding countdown and an enabled bid button while the previous player's victory anthem was still actively playing through the participant's speakers.
* **Fix Implementation**:
  - **Decoupled Participant Audio State Machine**: Added `participantAudioPlaying` and `participantAudioSafetyTimer` to client state.
  - **Modal Dismissal Without Audio Cut-off**: In `dismissCelebration()`, when a participant clicks "Back to auction floor", only the visual modal is dismissed (`state.celebration = null; renderRoom();`). The victory audio continues playing to its natural conclusion in the background.
  - **Bidding and Countdown Hold**: While `state.participantAudioPlaying` is active:
    - `canUserBid(room)` returns `false`.
    - Bid button displays `VICTORY ANTHEM PLAYING…` with disabled state.
    - Timer ring displays `—`, progress bar is held at `0%`, and timer caption reads `Victory anthem playing · Bidding unlocks when audio completes`.
    - Stage label indicates `Celebrating previous sale…`.
  - **Authoritative Resynchronization**: When audio naturally ends (`audio.ended`), or on audio failure (`audio.error` / blocked autoplay), `finishParticipantAudio()` clears the flag and immediately synchronizes the floor UI with the server's authoritative player and remaining countdown.
  - **Safe Bounded Watchdog**: Added a 25-second bounded recovery timer (`participantAudioSafetyTimer`) to guarantee that if a browser stalls audio events or playback is interrupted, the participant is automatically unblocked and never trapped.
  - **Host Instant Skip**: When the host clicks "Skip celebration" or "Back to auction floor", host audio is immediately stopped (`pause()`, `currentTime = 0`), celebration transition completes exactly once, the next player activates globally with the full configured timer, and bids are accepted immediately.

---

### Bug 2 — Auction Freezes Completely After a Few Skips or Biddings
* **Root Causes**:
  1. **Unsold Auto-Advance Deadlock**: In `settleUnsold(room)`, the previous code explicitly set `room.autoAdvanceAt = null; // Don't auto-advance for unsold; host clicks Next`. When a player received no bids (such as Alzarri Joseph), the lot was marked `lotDone = true`, but because `autoAdvanceAt` was `null`, `processAuctionClock` had no deadline to trigger auto-advance. The timer froze permanently at `00`, the console displayed `Lot settled`, and the auction remained stuck until the host manually clicked pause/resume or force-sell.
  2. **Celebration Stalls Without Fallback**: In `settleSold(room)`, `room.celebrationActive = true; room.autoAdvanceAt = null;`. If the host client was backgrounded (causing browser tab throttling), disconnected, or experienced an audio playback error, the server never auto-advanced.
  3. **Poisoned `celebrationActive` State**: In host `action === 'next'`, the handler incremented `room.currentIndex += 1` but failed to clear `room.celebrationActive = false`. If invoked after a sale, `celebrationActive` remained `true` on the new lot, blocking subsequent auto-settlement.
  4. **Strict Skip ID Mismatches**: The skip celebration handler rejected requests as stale if the client's celebration ID did not match `currentCelebrationId`, causing valid host skip clicks to be silently ignored.
* **Fix Implementation**:
  - **Server-Authoritative Auto-Advance Deadlines**:
    - In `settleUnsold`: Set `room.autoAdvanceAt = Date.now() + 3500;` (3.5-second bounded transition window).
    - In `settleSold`: Set `room.autoAdvanceAt = Date.now() + 6500;` (6.5-second server-authoritative fallback).
  - **Autonomous Auto-Advance Watchdog**: In `processAuctionClock`, if `room.lotDone` is true and `autoAdvanceAt` is missing, the watchdog assigns `room.autoAdvanceAt = now + (room.celebrationActive ? 6500 : 3500)`. When the deadline expires, the server autonomously advances to the next player, marks celebration as processed, clears celebration flags, and starts the full configured timer for the incoming candidate.
  - **Queue Concurrency & Try/Finally Safety**: Wrapped `_advanceQueued` and `_settlementQueued` with `try / finally` blocks inside the FIFO queue so queue flags can never remain stuck if an unexpected error occurs.
  - **Idempotent Host Skip**: Host skip unconditionally terminates celebration on the active lot, advances index, and initializes the new player's timer window.
  - **Invalid Settlement Fallback**: If a winning bidder's purchase cannot complete at expiration (e.g. unexpected purse or squad limit race), the lot cleanly settles unsold instead of looping infinitely.

---

### Previous Fixes (v1.0.9 Baseline Preserved)
- **Bug A — Last-Second Bid Concurrency**: Strict FIFO per-room Promise-chain queue (`enqueueRoomOperation`), immediate request timestamping (`bidReceivedAt`), and serialized atomic deadline extension.
- **Bug B — Participant Refresh**: Persistent session storage in `localStorage` (`ipl27-participant`), seamless session restoration in `init()`, zero timer resets, zero candidate changes on refresh, and duplicate participant prevention.
- **Bug C — Idempotent Triumph Skips**: Correlation IDs via `celebrationId`, protection against duplicate rapid skip requests, and stale callback isolation.

---

## 2. Modified Files

| File | Changes Made |
|---|---|
| `server.js` | Added server-authoritative `autoAdvanceAt` deadlines to `settleSold` (6.5s) and `settleUnsold` (3.5s); added robust autonomous watchdog to `processAuctionClock`; added `try/finally` cleanup to queued clock operations; cleared celebration state on `action === 'next'`; updated `action === 'skip-celebration'` for unconditional advancement; added fallback settlement for failed sales. |
| `public/app.js` | Implemented participant victory audio decoupling; held countdown at `—` and disabled bids during participant anthem; preserved audio on modal dismiss; added 25-second bounded audio recovery watchdog; updated host dismiss to trigger `skip-celebration`; cleared stale celebration on `action === 'next-player'`; updated cache parameter. |
| `public/index.html` | Bumped asset cache version to `v=14` for `app.js` and `style.css`. |
| `tests/comprehensive-fix-verification.test.js` | Created end-to-end verification suite covering 20+ host skips, 20+ participant audio hold cycles, 30+ mixed auto-advance stress transitions, and stale callback idempotency. |

---

## 3. Comprehensive Verification Test Results

All test suites executed against the live server:

1. `npm run check`: **PASS** (exit code 0) — Syntax check passed for `server.js` and `public/app.js`.
2. `scripts/smoke-test.js`: **PASS** (exit code 0) — Mini/mega room flows, CSK purse baseline ₹23.50 Cr, auto-unsold, bid-to-sale, pause/resume.
3. `npm test` (`tests/regression-suite.test.js`): **PASS** (exit code 0) — 7/7 suites passed (simultaneous bids, last-second bid race, late bid rejection, skip idempotency, session refresh restoration, 10 consecutive player transitions, pause/resume/force-sell/purse math).
4. `tests/bug-1-bid-race.test.js`: **PASS** (exit code 0) — Last-second bid race and concurrent settlement race.
5. `test-celebration-back-button.js`: **PASS** (exit code 0) — 10 consecutive celebrations with Back button stress test.
6. `test-atomic-fix.js`: **PASS** (exit code 0) — Atomic bid deadline extension verification.
7. `test-race-condition.js`: **PASS** (exit code 0) — Deadline race condition test.
8. `tests/comprehensive-fix-verification.test.js`: **PASS** (exit code 0) — 20+ host skip transitions, 20+ participant dismissals & audio hold cycles, 30+ mixed transitions stress test, rapid duplicate request idempotency.
