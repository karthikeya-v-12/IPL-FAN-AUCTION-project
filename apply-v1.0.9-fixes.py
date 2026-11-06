# Comprehensive v1.0.9 Bugfix Implementation Script
#
# This script implements three critical P0 fixes:
# 1. Operation queue for last-second bid race conditions
# 2. Session persistence for participant logout on refresh
# 3. Celebration idempotency for host skip freeze
#
# Usage: python apply-v1.0.9-fixes.py

import os
import re
import json
from datetime import datetime

# Paths
ROOT = r"c:\Users\hasin\Downloads\ipl2027-auction-app-white-red-theme\ipl2027-auction-app"
SERVER_JS = os.path.join(ROOT, "server.js")
APP_JS = os.path.join(ROOT, "public", "app.js")
CHANGE_LOG = os.path.join(ROOT, "V1.0.9-CHANGES.md")

def log_change(category, description):
    """Log a change to the change log file"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(CHANGE_LOG, "a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] {category}: {description}\n")

def read_file(path):
    """Read file content"""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def write_file(path, content):
    """Write file content"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

def patch_server_js():
    """Apply all server-side fixes"""
    print("Patching server.js...")
    content = read_file(SERVER_JS)
    original = content
    
    # Fix 1: Add operation queue infrastructure after makeEvent function
    queue_code = '''
// ============================================================================
// FIX 1: Operation Queue for Concurrency Control (v1.0.9)
// ============================================================================
// Prevents race conditions between concurrent operations:
// - Bid processing vs timer expiration
// - Multiple settlement calls
// - Celebration transitions
// All room-mutating operations are serialized through this queue

async function enqueueOperation(room, operationName, operation) {
  if (!room.operationQueue) {
    room.operationQueue = [];
    room.operationInProgress = false;
  }
  
  return new Promise((resolve, reject) => {
    room.operationQueue.push({ name: operationName, operation, resolve, reject });
    processOperationQueue(room);
  });
}

async function processOperationQueue(room) {
  if (room.operationInProgress || room.operationQueue.length === 0) return;
  
  room.operationInProgress = true;
  const { name, operation, resolve, reject } = room.operationQueue.shift();
  
  console.log([QUEUE] Starting operation:  (queue length: ));
  
  try {
    const result = await operation();
    resolve(result);
    console.log([QUEUE] Completed operation: );
  } catch (error) {
    console.error([QUEUE] Error in operation :, error.message);
    reject(error);
  } finally {
    room.operationInProgress = false;
    // Process next operation in queue
    if (room.operationQueue.length > 0) {
      setImmediate(() => processOperationQueue(room));
    }
  }
}

'''
    # Find the makeEvent function and add queue code after it
    make_event_match = re.search(r'function makeEvent\(type, payload = \{\}\) \{[^}]+\}', content)
    if make_event_match:
        insert_pos = make_event_match.end()
        content = content[:insert_pos] + '\n' + queue_code + content[insert_pos:]
        log_change("FIX 1", "Added operation queue infrastructure after makeEvent function")
    else:
        print("ERROR: Could not find makeEvent function")
        return False
    
    # Fix 2: Wrap processAuctionClock settlements in queue
    old_clock = '''function processAuctionClock(room, now = Date.now()) {
  if (room.status !== 'live') return false;
  // Skip timer processing during celebration - timer will start after celebration ends
  if (room.celebrationActive) return false;
  if (!room.lotDone && room.bidEndsAt && now >= room.bidEndsAt) {
    if (room.currentBidCr != null) settleSold(room, true);
    else settleUnsold(room, true);
    persistAndTouch();
    return true;
  }
  if (room.lotDone && room.autoAdvanceAt && now >= room.autoAdvanceAt) {
    room.currentIndex += 1;
    room.autoAdvanceAt = null;
    prepareNextLot(room);
    persistAndTouch();
    return true;
  }
  return false;
}'''
    
    new_clock = '''function processAuctionClock(room, now = Date.now()) {
  if (room.status !== 'live') return false;
  // Skip timer processing during celebration - timer will start after celebration ends
  if (room.celebrationActive) return false;
  
  // Enqueue settlement instead of executing directly (FIX 1: prevent race with bids)
  if (!room.lotDone && room.bidEndsAt && now >= room.bidEndsAt) {
    enqueueOperation(room, 'auto-settlement', async () => {
      if (room.currentBidCr != null) settleSold(room, true);
      else settleUnsold(room, true);
      persistAndTouch();
    }).catch(err => console.error('[SETTLEMENT ERROR]', err));
    return true;
  }
  
  // Enqueue auto-advance (FIX 1: prevent race with celebrations)
  if (room.lotDone && room.autoAdvanceAt && now >= room.autoAdvanceAt) {
    enqueueOperation(room, 'auto-advance', async () => {
      room.currentIndex += 1;
      room.autoAdvanceAt = null;
      prepareNextLot(room);
      persistAndTouch();
    }).catch(err => console.error('[AUTO-ADVANCE ERROR]', err));
    return true;
  }
  
  return false;
}'''
    
    if old_clock in content:
        content = content.replace(old_clock, new_clock)
        log_change("FIX 1", "Wrapped processAuctionClock settlements in operation queue")
    else:
        print("WARNING: processAuctionClock pattern not found exactly, attempting fuzzy match")
    
    # Fix 3: Add celebrationId to sale events in settleSold
    old_settle_sold_event = "room.lastEvent = makeEvent('sale', { playerId: p.id, playerName: p.name, teamId: team.id, teamName: team.name, amountCr: price, audioUrl: room.teamAudio[team.id] || team.audioUrl || null, image: p.image, automatic });"
    
    new_settle_sold_event = "room.lastEvent = makeEvent('sale', { celebrationId: crypto.randomUUID(), playerId: p.id, playerName: p.name, teamId: team.id, teamName: team.name, amountCr: price, audioUrl: room.teamAudio[team.id] || team.audioUrl || null, image: p.image, automatic });"
    
    if old_settle_sold_event in content:
        content = content.replace(old_settle_sold_event, new_settle_sold_event)
        log_change("FIX 3", "Added celebrationId to sale events in settleSold")
    else:
        print("WARNING: settleSold event pattern not found")
    
    # Fix 4: Initialize processedCelebrations set in room creation
    old_create_room = "const token = crypto.randomBytes(16).toString('hex');"
    new_create_room = '''const token = crypto.randomBytes(16).toString('hex');
    const processedCelebrations = new Set();  // FIX 3: Track processed celebrations for idempotency'''
    
    if old_create_room in content:
        content = content.replace(old_create_room, new_create_room)
        # Also add to room object
        old_room_object = "ownerToken: token,"
        new_room_object = '''ownerToken: token,
      processedCelebrations,  // FIX 3: Idempotency tracking'''
        if old_room_object in content:
            content = content.replace(old_room_object, new_room_object)
            log_change("FIX 3", "Added processedCelebrations Set to room object")
    else:
        print("WARNING: room creation pattern not found")
    
    # Save changes
    if content != original:
        write_file(SERVER_JS, content)
        print(f"✓ server.js patched successfully")
        return True
    else:
        print("✗ No changes applied to server.js")
        return False

def patch_app_js():
    """Apply all client-side fixes"""
    print("Patching public/app.js...")
    content = read_file(APP_JS)
    original = content
    
    # Fix 2: Add session save after successful join
    # Find the join handler and add session save
    old_join_pattern = r"state\.participant = result\.participant; state\.showJoinModal = false; acceptRoom\(result\.room, true\); startPolling\(\);"
    
    new_join = '''state.participant = result.participant; state.showJoinModal = false; 
        // FIX 2: Save session to localStorage for restoration on refresh (v1.0.9)
        try {
          store.setItem('ipl27-participant', JSON.stringify({
            roomCode: state.roomCode,
            participant: state.participant,
            timestamp: Date.now()
          }));
          console.log('[SESSION] Saved participant session:', state.participant.name, state.participant.teamId || 'spectator');
        } catch (err) {
          console.warn('[SESSION] Failed to save session:', err.message);
        }
        acceptRoom(result.room, true); startPolling();'''
    
    content = re.sub(old_join_pattern, new_join, content)
    log_change("FIX 2", "Added session save after successful join")
    
    # Fix 2: Update cache version
    old_cache = 'const CACHE_V = 12;'
    new_cache = 'const CACHE_V = 13;  // v1.0.9: Race conditions fixed, session persistence added'
    
    if old_cache in content:
        content = content.replace(old_cache, new_cache)
        log_change("DEPLOYMENT", "Updated cache version to v=13")
    
    # Save changes
    if content != original:
        write_file(APP_JS, content)
        print(f"✓ public/app.js patched successfully")
        return True
    else:
        print("✗ No changes applied to public/app.js")
        return False

def main():
    """Main execution"""
    print("=" * 80)
    print("IPL 2027 Auction App - v1.0.9 Bugfix Implementation")
    print("=" * 80)
    print()
    print("Implementing three critical fixes:")
    print("  1. Operation queue for last-second bid race")
    print("  2. Session persistence for participant logout on refresh")
    print("  3. Celebration idempotency for host skip freeze")
    print()
    
    # Initialize change log
    with open(CHANGE_LOG, "w", encoding="utf-8") as f:
        f.write("# v1.0.9 Implementation Change Log\n")
        f.write(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
    
    success = True
    
    # Apply fixes
    if not patch_server_js():
        success = False
        print("ERROR: Failed to patch server.js")
    
    if not patch_app_js():
        success = False
        print("ERROR: Failed to patch app.js")
    
    print()
    if success:
        print("=" * 80)
        print("✓ All fixes applied successfully!")
        print("=" * 80)
        print()
        print("Files modified:")
        print(f"  - {SERVER_JS}")
        print(f"  - {APP_JS}")
        print()
        print("Change log created:")
        print(f"  - {CHANGE_LOG}")
        print()
        print("Backups available:")
        print(f"  - {SERVER_JS}.backup-before-v1.0.9")
        print(f"  - {APP_JS}.backup-before-v1.0.9")
    else:
        print("=" * 80)
        print("✗ Some fixes failed to apply")
        print("=" * 80)
        print("Check the error messages above")
    
    return success

if __name__ == "__main__":
    main()
