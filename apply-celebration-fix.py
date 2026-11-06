import re

# Read server.js
with open(r"c:\Users\hasin\Downloads\ipl2027-auction-app-white-red-theme\ipl2027-auction-app\server.js", "r", encoding="utf-8") as f:
    server_content = f.read()

# Task 3.1: Add safeguard to processAuctionClock()
server_content = server_content.replace(
    "function processAuctionClock(room, now = Date.now()) {\n  if (room.status !== 'live') return false;",
    "function processAuctionClock(room, now = Date.now()) {\n  if (room.status !== 'live') return false;\n  // Skip timer processing during celebration - timer will start after celebration ends\n  if (room.celebrationActive) return false;"
)

# Task 3.2-3.4: Replace start-bidding with end-celebration and fix skip-celebration
old_actions = """      } else if (action === 'start-bidding') {
        if (room.status !== 'live') return sendJson(res, 409, { error: 'Auction is not live.' });
        if (room.bidEndsAt != null) return sendJson(res, 409, { error: 'Timer has already started for this lot.' });
        const p = currentPlayer(room);
        if (!p) return sendJson(res, 409, { error: 'No active player to start bidding for.' });
        room.bidEndsAt = Date.now() + room.timerSeconds * 1000;
        room.celebrationActive = false;
        room.lastEvent = makeEvent('bidding-started', { playerId: p.id });
      } else if (action === 'skip-celebration') {
        if (!room.celebrationActive) return sendJson(res, 409, { error: 'No celebration is active.' });
        room.celebrationActive = false;
        room.lastEvent = makeEvent('celebration-skipped');"""

new_actions = """      } else if (action === 'end-celebration') {
        // Called when celebration audio ends naturally
        if (!room.celebrationActive || !room.lotDone) {
          return sendJson(res, 409, { error: 'No active celebration to end.' });
        }
        room.celebrationActive = false;
        room.currentIndex += 1;
        prepareNextLot(room);
        // ONE authoritative timer start for next player
        if (currentPlayer(room)) {
          room.bidEndsAt = Date.now() + room.timerSeconds * 1000;
        }
        room.lastEvent = makeEvent('celebration-ended', { nextPlayerId: currentPlayer(room)?.id });
      } else if (action === 'skip-celebration') {
        // Called when host clicks Skip Celebration button
        if (!room.celebrationActive || !room.lotDone) {
          return sendJson(res, 409, { error: 'No active celebration to skip.' });
        }
        room.celebrationActive = false;
        room.currentIndex += 1;
        prepareNextLot(room);
        // ONE authoritative timer start for next player
        if (currentPlayer(room)) {
          room.bidEndsAt = Date.now() + room.timerSeconds * 1000;
        }
        room.lastEvent = makeEvent('celebration-skipped', { nextPlayerId: currentPlayer(room)?.id });"""

server_content = server_content.replace(old_actions, new_actions)

# Task 3.5: Update comment in prepareNextLot()
server_content = server_content.replace(
    '  // Timer will start via the "start-bidding" action after celebration completes\n  room.bidEndsAt = null;',
    '  // Timer will be started by end-celebration or skip-celebration endpoint after this function completes\n  // Do NOT set bidEndsAt here - ensures ONE authoritative timer-start location\n  room.bidEndsAt = null;'
)

# Write server.js
with open(r"c:\Users\hasin\Downloads\ipl2027-auction-app-white-red-theme\ipl2027-auction-app\server.js", "w", encoding="utf-8", newline="\n") as f:
    f.write(server_content)

print("✓ server.js updated")

# Read app.js
with open(r"c:\Users\hasin\Downloads\ipl2027-auction-app-white-red-theme\ipl2027-auction-app\public\app.js", "r", encoding="utf-8") as f:
    app_content = f.read()

# Task 3.6: Update dismissCelebration()
old_dismiss = """async function dismissCelebration() {
  state.celebration = null;
  if (state.celebrationTimeout) { clearTimeout(state.celebrationTimeout); state.celebrationTimeout = null; }
  
  // Call start-bidding API to unblock room updates and prepare for next lot
  if (state.roomCode) {
    try {
      await api(`/api/room/${state.roomCode}/action`, { method: 'POST', body: { action: 'start-bidding' } });
      // Fetch latest room state after start-bidding
      const s = await api(`/api/room/${state.roomCode}/state`);
      acceptRoom(s.room, false);
      return;
    } catch (err) {
      console.warn('Failed to start bidding after celebration:', err);
    }
  }
  renderRoom();
}"""

new_dismiss = """async function dismissCelebration() {
  // Idempotency guard - clear celebration first to prevent re-entry
  if (!state.celebration) return;
  state.celebration = null;
  
  if (state.celebrationTimeout) { 
    clearTimeout(state.celebrationTimeout); 
    state.celebrationTimeout = null; 
  }
  
  // Call end-celebration API which advances to next player and starts their timer
  if (state.roomCode) {
    try {
      await api(`/api/room/${state.roomCode}/action`, { 
        method: 'POST', 
        body: { action: 'end-celebration' } 
      });
      // Fetch latest room state after celebration ends
      const s = await api(`/api/room/${state.roomCode}/state`);
      acceptRoom(s.room, false);
      return;
    } catch (err) {
      console.warn('Failed to end celebration:', err);
    }
  }
  renderRoom();
}"""

app_content = app_content.replace(old_dismiss, new_dismiss)

# Task 3.7: Remove blocking in acceptRoom()
old_accept = """function acceptRoom(room, initial = false) {
  if (!room) return;
  
  // BLOCK ALL updates while celebration is showing
  if (state.celebration && !initial) {
    // Don't update room, don't re-render, don't touch anything
    // The celebration is in full control
    return;
  }
  """

new_accept = """function acceptRoom(room, initial = false) {
  if (!room) return;
  
  // Server now properly blocks timer during celebration, so no client-side blocking needed
  """

app_content = app_content.replace(old_accept, new_accept)

# Task 3.8: Remove blocking in updateTimerText()
old_timer = """function updateTimerText() {
  // Don't update timer while celebration is showing
  if (state.celebration) return;
  
  const room = state.room;"""

new_timer = """function updateTimerText() {
  // Server guarantees no timer during celebration, so no client blocking needed
  const room = state.room;"""

app_content = app_content.replace(old_timer, new_timer)

# Task 3.9: Add idempotency to playCelebrationAudio()
old_play = """function playCelebrationAudio(audioUrl) {
  if (state.muteAudio || !audioUrl) {
    // No audio or muted — dismiss celebration after 5 seconds
    state.celebrationTimeout = setTimeout(() => dismissCelebration(), 5000);
    return;
  }
  try {
    if (state.currentAudio) { state.currentAudio.pause(); state.currentAudio = null; }
    const audio = new Audio(audioUrl); audio.volume = 0.8; state.currentAudio = audio;
    // Dismiss celebration ONLY when audio ends naturally
    audio.addEventListener('ended', () => {
      if (state.celebration) {
        dismissCelebration();
      }
    });"""

new_play = """function playCelebrationAudio(audioUrl) {
  if (state.muteAudio || !audioUrl) {
    // No audio or muted — dismiss celebration after 5 seconds (fallback only)
    if (state.celebrationTimeout) clearTimeout(state.celebrationTimeout);
    state.celebrationTimeout = setTimeout(() => dismissCelebration(), 5000);
    return;
  }
  try {
    // Clear any existing audio and timeout
    if (state.currentAudio) { state.currentAudio.pause(); state.currentAudio = null; }
    if (state.celebrationTimeout) { clearTimeout(state.celebrationTimeout); state.celebrationTimeout = null; }
    
    const audio = new Audio(audioUrl); audio.volume = 0.8; state.currentAudio = audio;
    // Dismiss celebration ONLY when audio ends naturally - idempotency guard inside dismissCelebration()
    audio.addEventListener('ended', () => {
      // Double-check celebration still exists (guards against duplicate ended events)
      if (state.celebration) {
        dismissCelebration();
      }
    });"""

app_content = app_content.replace(old_play, new_play)

# Write app.js
with open(r"c:\Users\hasin\Downloads\ipl2027-auction-app-white-red-theme\ipl2027-auction-app\public\app.js", "w", encoding="utf-8", newline="\n") as f:
    f.write(app_content)

print("✓ app.js updated")

# Update index.html cache version
with open(r"c:\Users\hasin\Downloads\ipl2027-auction-app-white-red-theme\ipl2027-auction-app\public\index.html", "r", encoding="utf-8") as f:
    html_content = f.read()

html_content = html_content.replace('?v=7', '?v=8')

with open(r"c:\Users\hasin\Downloads\ipl2027-auction-app-white-red-theme\ipl2027-auction-app\public\index.html", "w", encoding="utf-8", newline="\n") as f:
    f.write(html_content)

print("✓ index.html cache version updated to v=8")
print("\n=== All fixes applied successfully ===")
