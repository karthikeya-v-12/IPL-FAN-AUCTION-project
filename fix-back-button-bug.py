import re

print("=== FIXING 'BACK TO AUCTION FLOOR' BUTTON BUG ===\n")

# Read app.js
with open(r"c:\Users\hasin\Downloads\ipl2027-auction-app-white-red-theme\ipl2027-auction-app\public\app.js", "r", encoding="utf-8") as f:
    app_content = f.read()

# FIX 1: dismissCelebration() must STOP the audio
old_dismiss = """async function dismissCelebration() {
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

new_dismiss = """async function dismissCelebration() {
  // Idempotency guard - clear celebration first to prevent re-entry
  if (!state.celebration) return;
  
  const celebrationId = state.celebration.id;  // Save ID for validation
  state.celebration = null;
  
  // CRITICAL: Stop audio immediately to prevent background playback
  if (state.currentAudio) {
    try {
      state.currentAudio.pause();
      state.currentAudio.currentTime = 0;  // Reset to start
      state.currentAudio = null;
    } catch (err) {
      console.warn('Failed to stop celebration audio:', err);
    }
  }
  
  // Clear all pending timeouts
  if (state.celebrationTimeout) { 
    clearTimeout(state.celebrationTimeout); 
    state.celebrationTimeout = null; 
  }
  
  // Call end-celebration API which advances to next player and starts their timer
  if (state.roomCode) {
    try {
      await api(`/api/room/${state.roomCode}/action`, { 
        method: 'POST', 
        body: { action: 'end-celebration', celebrationId } 
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

# FIX 2: audio.addEventListener('ended') must check if celebration already dismissed
old_audio_ended = """    const audio = new Audio(audioUrl); audio.volume = 0.8; state.currentAudio = audio;
    // Dismiss celebration ONLY when audio ends naturally - idempotency guard inside dismissCelebration()
    audio.addEventListener('ended', () => {
      // Double-check celebration still exists (guards against duplicate ended events)
      if (state.celebration) {
        dismissCelebration();
      }
    });"""

new_audio_ended = """    const audio = new Audio(audioUrl); audio.volume = 0.8; state.currentAudio = audio;
    const celebrationId = state.celebration?.id;  // Capture ID at audio start
    
    // Dismiss celebration ONLY when audio ends naturally - idempotency guard inside dismissCelebration()
    audio.addEventListener('ended', () => {
      // Double-check celebration still exists AND ID matches (guards against stale callbacks)
      if (state.celebration && state.celebration.id === celebrationId) {
        dismissCelebration();
      }
    });"""

app_content = app_content.replace(old_audio_ended, new_audio_ended)

# FIX 3: Error handlers must also check celebration ID
old_error_handler = """    // Handle audio errors - if audio fails to play, dismiss after 5s
    audio.addEventListener('error', () => {
      state.celebrationAudioError = true;
      state.celebrationTimeout = setTimeout(() => dismissCelebration(), 5000);
    });"""

new_error_handler = """    // Handle audio errors - if audio fails to play, dismiss after 5s
    audio.addEventListener('error', () => {
      // Only set fallback if celebration still active and ID matches
      if (state.celebration && state.celebration.id === celebrationId) {
        state.celebrationAudioError = true;
        if (state.celebrationTimeout) clearTimeout(state.celebrationTimeout);
        state.celebrationTimeout = setTimeout(() => {
          // Final check before dismissing
          if (state.celebration && state.celebration.id === celebrationId) {
            dismissCelebration();
          }
        }, 5000);
      }
    });"""

app_content = app_content.replace(old_error_handler, new_error_handler)

# FIX 4: Play promise handlers must also check ID
old_promise_handlers = """    const promise = audio.play();
    if (promise?.catch) promise.catch(() => { 
      state.celebrationAudioError = true; 
      state.celebrationTimeout = setTimeout(() => dismissCelebration(), 5000);
    });"""

new_promise_handlers = """    const promise = audio.play();
    if (promise?.catch) promise.catch(() => { 
      // Only set fallback if celebration still active and ID matches
      if (state.celebration && state.celebration.id === celebrationId) {
        state.celebrationAudioError = true;
        if (state.celebrationTimeout) clearTimeout(state.celebrationTimeout);
        state.celebrationTimeout = setTimeout(() => {
          if (state.celebration && state.celebration.id === celebrationId) {
            dismissCelebration();
          }
        }, 5000);
      }
    });"""

app_content = app_content.replace(old_promise_handlers, new_promise_handlers)

# Write app.js
with open(r"c:\Users\hasin\Downloads\ipl2027-auction-app-white-red-theme\ipl2027-auction-app\public\app.js", "w", encoding="utf-8", newline="\n") as f:
    f.write(app_content)

print("✓ app.js updated - audio now stops on button click")

# Read server.js
with open(r"c:\Users\hasin\Downloads\ipl2027-auction-app-white-red-theme\ipl2027-auction-app\server.js", "r", encoding="utf-8") as f:
    server_content = f.read()

# FIX 5: end-celebration endpoint must be idempotent
old_end_celebration = """      } else if (action === 'end-celebration') {
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
        room.lastEvent = makeEvent('celebration-ended', { nextPlayerId: currentPlayer(room)?.id });"""

new_end_celebration = """      } else if (action === 'end-celebration') {
        // Called when celebration audio ends naturally OR when host clicks "Back to Auction Floor"
        // IDEMPOTENT: If celebration already ended, this is a no-op
        if (!room.celebrationActive || !room.lotDone) {
          // Already ended or no celebration active - return success to avoid client errors
          return sendJson(res, 200, { ok: true, alreadyEnded: true, room: publicRoom(room) });
        }
        
        // Atomically complete the celebration
        room.celebrationActive = false;
        room.currentIndex += 1;
        prepareNextLot(room);
        
        // ONE authoritative timer start for next player
        const nextPlayer = currentPlayer(room);
        if (nextPlayer) {
          room.bidEndsAt = Date.now() + room.timerSeconds * 1000;
          room.lotDone = false;  // Ensure new lot is open for bidding
        }
        
        room.lastEvent = makeEvent('celebration-ended', { 
          nextPlayerId: nextPlayer?.id, 
          celebrationId: body.celebrationId || null 
        });"""

server_content = server_content.replace(old_end_celebration, new_end_celebration)

# FIX 6: skip-celebration must also be idempotent
old_skip_celebration = """      } else if (action === 'skip-celebration') {
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

new_skip_celebration = """      } else if (action === 'skip-celebration') {
        // Called when host clicks Skip Celebration button (host-only control)
        // IDEMPOTENT: If celebration already ended, this is a no-op
        if (!room.celebrationActive || !room.lotDone) {
          // Already ended or no celebration active - return success
          return sendJson(res, 200, { ok: true, alreadyEnded: true, room: publicRoom(room) });
        }
        
        // Atomically complete the celebration (same as end-celebration)
        room.celebrationActive = false;
        room.currentIndex += 1;
        prepareNextLot(room);
        
        // ONE authoritative timer start for next player
        const nextPlayer = currentPlayer(room);
        if (nextPlayer) {
          room.bidEndsAt = Date.now() + room.timerSeconds * 1000;
          room.lotDone = false;  // Ensure new lot is open for bidding
        }
        
        room.lastEvent = makeEvent('celebration-skipped', { nextPlayerId: nextPlayer?.id });"""

server_content = server_content.replace(old_skip_celebration, new_skip_celebration)

# Write server.js
with open(r"c:\Users\hasin\Downloads\ipl2027-auction-app-white-red-theme\ipl2027-auction-app\server.js", "w", encoding="utf-8", newline="\n") as f:
    f.write(server_content)

print("✓ server.js updated - end-celebration is now idempotent")
print("\n=== ALL FIXES APPLIED SUCCESSFULLY ===")
print("\nChanges made:")
print("1. dismissCelebration() now stops audio immediately (pause + reset)")
print("2. All audio callbacks check celebration ID to prevent stale events")
print("3. end-celebration endpoint is idempotent (returns success if already ended)")
print("4. skip-celebration endpoint is idempotent")
print("5. Next player's lotDone is explicitly set to false to enable bidding")
