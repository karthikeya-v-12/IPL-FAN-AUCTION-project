# TEST B: Participant Tab Switching

## This test requires a browser. Follow these steps:

### Setup
1. Start the server: `node server.js`
2. Open two browser windows (or private/incognito windows)
3. In both, navigate to `http://localhost:3333`

### Test Procedure

#### Window 1 (Host):
1. Click "Host Login", enter: `ipl2027owner`
2. Create a Mega auction (2-5 second timer)
3. Start the auction

#### Window 2 (Participant A):
1. Join as CSK team owner
2. Verify you can see the auction floor

#### Window 3 (Participant B):
1. Open a third window
2. Join as MI team owner
3. Verify you can see the auction floor

### Critical Tests:

#### Test B1: Participant switches tabs during active bidding
1. Note the current player and timer
2. **In Window 2 (CSK):** Switch to a different browser tab (e.g., open a new tab)
3. **In Window 3 (MI):** Place a bid
4. **In Window 1 (Host):** Verify the bid was accepted and timer extended
5. **In Window 2 (CSK):** Switch back to the auction tab
6. **Expected:** CSK should see the updated state (MI's bid) without being logged out
7. **Expected:** Timer should NOT have reset
8. **Expected:** CSK can still place bids

#### Test B2: Participant switches tabs during celebration
1. Let a player sell (wait for timer to expire or manually settle)
2. Celebration should start
3. **In Window 2 (CSK):** Switch to a different tab during celebration
4. Wait 5-10 seconds
5. **In Window 2 (CSK):** Switch back
6. **Expected:** Celebration may have ended, next player is active
7. **Expected:** CSK is still logged in with correct team
8. **Expected:** CSK can place bids on the new player

#### Test B3: Host switches tabs
1. **In Window 1 (Host):** Switch to a different browser tab
2. **In Window 2 (CSK):** Place a bid
3. Wait for timer to expire (2-5 seconds)
4. **In Window 3 (MI):** Verify the player was marked SOLD/UNSOLD
5. **In Window 1 (Host):** Switch back to auction tab
6. **Expected:** Host sees the settled result
7. **Expected:** Next player is active (if using auto-advance)
8. **Expected:** Auction continued running while host tab was hidden

### Success Criteria

? Participants remain logged in after switching tabs
? Auction state updates correctly when returning to tab
? Timer does NOT reset when switching tabs
? Participants can still bid after returning
? Server continues processing bids and settlements while clients are hidden
? Host tab switching does NOT pause the auction for participants

### Failure Indicators

? Participant logged out after tab switch
? Participant redirected to join screen
? Timer reset to full value after returning
? Stale state shown (old player, old bids)
? Cannot place bids after returning
? Auction paused while host tab was hidden

---

## Automated Simulation (Partial)

While full tab-switching requires a browser, you can simulate connection loss with this script:

```javascript
// This tests that polling failures don't cause logout
// Run while server is running, then temporarily stop server, then restart
```

For full validation, manual browser testing is REQUIRED.
