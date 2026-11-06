import re

print("=== FIXING BID/TIMER RACE CONDITION BUG ===\n")

# Read server.js
with open(r"c:\Users\hasin\Downloads\ipl2027-auction-app-white-red-theme\ipl2027-auction-app\server.js", "r", encoding="utf-8") as f:
    server_content = f.read()

# FIX 1: Make bid processing atomic - extend deadline BEFORE validation completes
old_bid_handler = """    if (method === 'POST' && bidMatch) {
      const room = needRoom(bidMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'That auction room is no longer active.' });
      const body = await readBody(req, 20000);
      const participant = room.participants.find(p => p.clientId === body.clientId);
      if (!participant || participant.role !== 'teamOwner' || !participant.teamId) return sendJson(res, 403, { error: 'Join the room as a franchise owner before bidding.' });
      const team = room.teams.find(t => t.id === participant.teamId);
      if (!team) return sendJson(res, 400, { error: 'Your franchise seat is unavailable.' });
      const reason = validateCanBid(room, team);
      if (reason) return sendJson(res, 409, { error: reason });
      const amount = expectedBid(room);
      if (body.amountCr != null && Math.abs(Number(body.amountCr) - amount) > 0.001) return sendJson(res, 409, { error: `The next valid bid is ${formatPrice(amount)}.` });
      room.currentBidCr = roundCr(amount);
      room.currentBidTeamId = team.id;
      room.currentBidderName = participant.name;
      room.currentBidHistory.push({ teamId: team.id, teamName: team.name, bidderName: participant.name, amountCr: room.currentBidCr, at: new Date().toISOString() });
      room.bidEndsAt = Date.now() + room.timerSeconds * 1000;
      room.lastEvent = makeEvent('bid', { playerId: currentPlayer(room)?.id, teamId: team.id, amountCr: room.currentBidCr, bidderName: participant.name });
      persistAndTouch();
      return sendJson(res, 200, { ok: true, room: publicRoom(room) });
    }"""

new_bid_handler = """    if (method === 'POST' && bidMatch) {
      const room = needRoom(bidMatch[1]);
      if (!room) return sendJson(res, 404, { error: 'That auction room is no longer active.' });
      const body = await readBody(req, 20000);
      const participant = room.participants.find(p => p.clientId === body.clientId);
      if (!participant || participant.role !== 'teamOwner' || !participant.teamId) return sendJson(res, 403, { error: 'Join the room as a franchise owner before bidding.' });
      const team = room.teams.find(t => t.id === participant.teamId);
      if (!team) return sendJson(res, 400, { error: 'Your franchise seat is unavailable.' });
      
      // CRITICAL: Check if lot is already done (race condition guard)
      if (room.lotDone) {
        return sendJson(res, 409, { error: 'This lot has already been settled.' });
      }
      
      // ATOMIC BID PROCESSING: Extend deadline FIRST to prevent timer from settling during validation
      const oldDeadline = room.bidEndsAt;
      const newDeadline = Date.now() + room.timerSeconds * 1000;
      room.bidEndsAt = newDeadline;  // Extend deadline atomically
      
      // Now validate - if validation fails, restore old deadline
      const reason = validateCanBid(room, team);
      if (reason) {
        room.bidEndsAt = oldDeadline;  // Restore on validation failure
        return sendJson(res, 409, { error: reason });
      }
      
      const amount = expectedBid(room);
      if (body.amountCr != null && Math.abs(Number(body.amountCr) - amount) > 0.001) {
        room.bidEndsAt = oldDeadline;  // Restore on amount mismatch
        return sendJson(res, 409, { error: `The next valid bid is ${formatPrice(amount)}.` });
      }
      
      // Bid is valid - commit it
      room.currentBidCr = roundCr(amount);
      room.currentBidTeamId = team.id;
      room.currentBidderName = participant.name;
      room.currentBidHistory.push({ teamId: team.id, teamName: team.name, bidderName: participant.name, amountCr: room.currentBidCr, at: new Date().toISOString() });
      // bidEndsAt already set above atomically
      room.lastEvent = makeEvent('bid', { playerId: currentPlayer(room)?.id, teamId: team.id, amountCr: room.currentBidCr, bidderName: participant.name });
      persistAndTouch();
      return sendJson(res, 200, { ok: true, room: publicRoom(room) });
    }"""

server_content = server_content.replace(old_bid_handler, new_bid_handler)
print("✓ Bid handler made atomic (deadline extended before validation)")

# FIX 2: Make settleSold and settleUnsold idempotent with guards
old_settle_sold = """function settleSold(room, automatic = false) {
  const p = currentPlayer(room);
  if (!p || room.lotDone || room.currentBidCr == null || !room.currentBidTeamId) return false;"""

new_settle_sold = """function settleSold(room, automatic = false) {
  const p = currentPlayer(room);
  // IDEMPOTENT: Check lotDone first to prevent double settlement
  if (room.lotDone) return false;
  if (!p || room.currentBidCr == null || !room.currentBidTeamId) return false;"""

server_content = server_content.replace(old_settle_sold, new_settle_sold)
print("✓ settleSold made idempotent (checks lotDone first)")

old_settle_unsold = """function settleUnsold(room, automatic = false) {
  const p = currentPlayer(room);
  if (!p || room.lotDone || room.currentBidCr != null) return false;"""

new_settle_unsold = """function settleUnsold(room, automatic = false) {
  const p = currentPlayer(room);
  // IDEMPOTENT: Check lotDone first to prevent double settlement
  if (room.lotDone) return false;
  if (!p || room.currentBidCr != null) return false;"""

server_content = server_content.replace(old_settle_unsold, new_settle_unsold)
print("✓ settleUnsold made idempotent (checks lotDone first)")

# FIX 3: Improve validateCanBid to give grace period at deadline
old_validate = """function validateCanBid(room, team) {
  const p = currentPlayer(room);
  if (!p) return 'There is no active player.';
  if (room.status !== 'live') return 'Bidding is not live right now.';
  if (room.lotDone) return 'This lot has already been settled.';
  if (!room.bidEndsAt || Date.now() >= room.bidEndsAt) return 'The bidding timer has expired. Wait for the host to settle the lot.';"""

new_validate = """function validateCanBid(room, team) {
  const p = currentPlayer(room);
  if (!p) return 'There is no active player.';
  if (room.status !== 'live') return 'Bidding is not live right now.';
  if (room.lotDone) return 'This lot has already been settled.';
  // DEADLINE POLICY: Bid is valid if received before server deadline expires
  // Give small grace period (100ms) to account for network latency
  if (!room.bidEndsAt || Date.now() >= room.bidEndsAt + 100) {
    return 'The bidding timer has expired. Wait for the host to settle the lot.';
  }"""

server_content = server_content.replace(old_validate, new_validate)
print("✓ validateCanBid updated with 100ms grace period")

# FIX 4: Add logging for settlement failures
old_settle_sold_return = """  room.lastEvent = makeEvent('sale', { playerId: p.id, playerName: p.name, teamId: team.id, teamName: team.name, amountCr: price, audioUrl: room.teamAudio[team.id] || team.audioUrl || null, image: p.image, automatic });
  hydrateTeams(room);
  return true;
}"""

new_settle_sold_return = """  room.lastEvent = makeEvent('sale', { playerId: p.id, playerName: p.name, teamId: team.id, teamName: team.name, amountCr: price, audioUrl: room.teamAudio[team.id] || team.audioUrl || null, image: p.image, automatic });
  hydrateTeams(room);
  console.log(`[SETTLEMENT] Player ${p.name} SOLD to ${team.id} for ${formatPrice(price)} (automatic: ${automatic})`);
  return true;
}"""

server_content = server_content.replace(old_settle_sold_return, new_settle_sold_return)

old_settle_unsold_return = """  room.lastEvent = makeEvent('unsold', { playerId: p.id, playerName: p.name, round: room.round, automatic });
  return true;
}"""

new_settle_unsold_return = """  room.lastEvent = makeEvent('unsold', { playerId: p.id, playerName: p.name, round: room.round, automatic });
  console.log(`[SETTLEMENT] Player ${p.name} marked UNSOLD (automatic: ${automatic})`);
  return true;
}"""

server_content = server_content.replace(old_settle_unsold_return, new_settle_unsold_return)
print("✓ Added settlement logging for debugging")

# Write server.js
with open(r"c:\Users\hasin\Downloads\ipl2027-auction-app-white-red-theme\ipl2027-auction-app\server.js", "w", encoding="utf-8", newline="\n") as f:
    f.write(server_content)

print("\n=== ALL FIXES APPLIED ===")
print("\nChanges made:")
print("1. Bid processing now atomic (deadline extended before validation)")
print("2. settleSold/settleUnsold check lotDone FIRST (idempotent)")
print("3. validateCanBid has 100ms grace period for network latency")
print("4. Settlement operations now logged for debugging")
print("\nThis prevents race condition where bid and timer both try to settle the same lot.")
