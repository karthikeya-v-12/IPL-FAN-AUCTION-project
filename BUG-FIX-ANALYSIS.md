# BUG FIX ANALYSIS - IPL 2027 Auction App

## CRITICAL BUGS IDENTIFIED

### BUG #1: Celebration Double-Fetch Race Condition

**Location:** app.js lines 222-229 (`dismissCelebration`)

**Root Cause:**
1. `dismissCelebration()` calls `/action` with `end-celebration` (line 222-226)
2. Then immediately fetches `/state` again (line 227-228)
3. The second fetch can arrive BEFORE server has persisted the state from step 1
4. This causes clients to receive stale state
5. After 2-3 celebrations, state becomes corrupted

**Fix:** Use the room state returned by the `/action` endpoint instead of making a second fetch.

### BUG #2: Polling Failure Interpreted as Room Closure

**Location:** app.js lines 127-130 (`startPolling`)

**Root Cause:**
1. When tab is hidden, browsers throttle timers/network
2. Poll requests timeout or fail with network errors
3. Current code checks `if (/no longer active/i.test(err.message))` 
4. Network timeouts don't match this pattern, so they're silently ignored
5. BUT if a timeout/error occurs, participant might see stale state
6. On some errors, the code DOES clear state and logout (line 128)

**Fix:** 
- Distinguish between network/timeout errors vs actual room closure
- Preserve participant session during temporary network issues
- Only clear state on confirmed 404/room-closed responses

### BUG #3: Client State Not Properly Restored on Reconnect

**Location:** app.js `acceptRoom()` function (line 135+)

**Root Cause:**
1. When participant returns to tab, polling resumes
2. Server state is fetched correctly
3. BUT client doesn't validate that current celebration ID matches server state
4. Stale celebration callbacks can fire AFTER participant reconnects
5. This corrupts the newly-fetched state

**Fix:** Add revision/version checking to prevent accepting stale updates

### BUG #4: No Participant Session Persistence

**Root Cause:**
1. Participant identity is stored in memory (`state.participant`)
2. No localStorage persistence for participant sessions
3. On page reload or reconnect, participant loses identity
4. Must rejoin manually

**Fix:** Persist participant session to localStorage with expiry

---

## IMPLEMENTATION PLAN

1. Fix `dismissCelebration()` to use action response, not double-fetch
2. Add retry logic for network errors without clearing participant state
3. Add state revision/version checking to reject stale updates  
4. Persist participant sessions to localStorage
5. Add comprehensive logging for debugging
6. Test all scenarios

---
