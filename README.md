# IPL 2027 Fan-Made Auction Simulator — Full Stability & Mega Auction Upgrade

A comprehensive, production-grade fan auction simulator for the Indian Premier League (IPL) 2027 season. Features a real-time authoritative auction engine, shared multiplayer rooms, franchise audio anthems, responsive mobile/desktop UI in a dark stadium theme with RCB-inspired red accents, and the official **IPL 2025–27 retention regulation reference framework** for Mega Auctions.

---

## What's New & Upgraded (Full Refactor Changelog)

### 1. Authoritative Timer & Concurrency Architecture
- **Single Server Deadline**: The server strictly owns `bidEndsAt` (absolute timestamp in milliseconds). The client frontend never decrements an independent counter or mutates deadlines; it computes remaining time directly from `Math.max(0, room.bidEndsAt - Date.now())`.
- **Zero Rerender Drift**: Rerendering components, polling requests, page refreshes, and network blips never restart or alter the countdown deadline.
- **Strict FIFO Serialization**: All mutating actions (`bid`, `sold`, `unsold`, `skip-celebration`, `end-celebration`, `start`, `pause`, `resume`) execute sequentially via a per-room promise queue (`enqueueRoomOperation`), eliminating race conditions between last-second bids and timer settlement.
- **Generation & Revision Protection**: Each lot receives a unique `lotId` UUID and monotonic `timerRevision`. Asynchronous callbacks verify they still belong to the active lot generation, preventing stale callbacks from advancing or settling subsequent players.
- **Live Visual Warning**: Real-time timer ring pulses with high-contrast red warning styling when remaining time drops to `≤ 3` seconds.

### 2. SOLD Celebration & Skip Celebration State Machine
- **Explicit State Transitions**: Centralized state machine: `BIDDING → SETTLING → CELEBRATION → NEXT_PLAYER_READY → BIDDING`.
- **Idempotent Skip Celebration**: Host skip requests and audio completion events are tracked via `processedCelebrations`. Repeated clicks or concurrent callbacks advance the lot exactly once.
- **Clean Audio Teardown**: On celebration skip or dismissal, all audio elements are immediately paused, reset (`currentTime = 0`), and event listeners (`ended`, `error`) removed across both host and participant browsers.
- **Stuck Button Elimination**: All control and bidding buttons derive their enabled/disabled state directly from authoritative server properties (`room.lotState`, `room.lotDone`, `room.bidEndsAt`). Controls automatically return to enabled states when a new player reaches `bidding`.

### 3. Mega Auction Retention Subsystem (IPL 2025–27 Reference Regulation)
- **Official Regulation Slabs**:
  - Maximum **6 combined** direct retentions and Right to Match (RTM) cards per franchise.
  - Maximum **5 capped** players (Indian or overseas).
  - Maximum **2 uncapped** players.
  - Capped retention cost slabs: **₹18 Cr, ₹14 Cr, ₹11 Cr, ₹18 Cr, and ₹14 Cr** for the 1st through 5th capped retention slots.
  - Uncapped retention cost: **₹4 Cr** per eligible uncapped retention.
- **Interactive Retention Review Screen**:
  - Displays each franchise's complete working squad with headshot, role, nationality, and capped status.
  - Indian domestic players feature a category toggle (`Capped` vs `Uncapped (₹4 Cr)`).
  - Live budget calculation: displays total retention spend, remaining auction purse, and remaining RTM cards (`6 - totalRetained`).
  - Strict validation against combination limits and available starting purse.
- **Candidate Pool Reconstruction**:
  - When the retention phase is finalized by the host, retained players remain in their respective franchise squads.
  - **All unretained squad players across all 10 franchises are released into the Mega Auction candidate pool**.
  - Released players are merged with the 182 candidates and deduplicated by canonical player ID.
  - **Invariant Guarantee**: Retained players never appear in the auction pool; zero duplicate candidates.
- **Right to Match (RTM) Workflow**:
  - Released candidates track their `originalTeamId`.
  - During live auction bidding, if competing bids are placed, the original franchise's RTM card can be exercised by the host to match the winning bid.
- **Mini Auction Preserved**: Mini mode retains its trade-adjusted starting purse model, pre-populated rosters, and standard 182-candidate pool without retention screens.

### 4. Franchise Audio Subsystem
- **10 Stable Franchise IDs**: Associated by standard team IDs (`CSK`, `DC`, `GT`, `KKR`, `LSG`, `MI`, `PBKS`, `RR`, `RCB`, `SRH`).
- **Full Media Controls**: UI includes a global volume slider (0–100%) and mute toggle, saved to local storage.
- **Host Audio Management**: Upload, preview/test, replace, and clear hook-line audio clips (MP3, WAV, M4A, AAC, OGG, FLAC, WebM up to 8 MB) saved to `public/audio/` and mapped in `data/team-audio.json`.
- **Playback Safety**: Bounded watchdogs (25s maximum fallback) ensure the auction never freezes if autoplay is blocked or client audio fails.

### 5. Mobile & Desktop Interaction & Styling
- **No Tap Glow**: Eliminated browser default blue tap-highlight boxes with `-webkit-tap-highlight-color: transparent;` and `touch-action: manipulation;`.
- **Semantic Buttons**: Replaced dummy anchors with semantic `<button type="button">` and `<button type="submit">` elements to prevent link navigation and accidental form submissions.
- **Tactile Feedback**: Responsive active states (`transform: translateY(1px)`) and keyboard `:focus-visible` styling with RCB red rings (`--accent: #D71920`).
- **Touch-Friendly Targets**: Minimum touch target heights (≥ 44px) on mobile viewports.

### 6. Full Player Image Audit & Verification
- **Current Squad Players (181 total)**:
  - 68 verified local HD portraits in `public/player-images/`.
  - 111 verified official franchise/IPL CDN portraits (HTTP 200).
  - 2 verified initials placeholders (Kartik Sharma, Urvil Patel) pending official photos.
  - **0 broken images**.
  - **Preserved local portraits**: Ishan Kishan, Abhishek Sharma, Aniket Verma, Umran Malik.
- **Candidate Pool (182 total)**:
  - 1 local portrait, 152 verified official URLs, 29 initials placeholders for unphotographed domestic registrations.
  - **0 broken images**.

---

## Getting Started

### Prerequisites
- Node.js 18 or newer (no external npm dependencies required).

### Installation & Launch
```bash
# 1. Navigate to the project directory
cd ipl2027-auction-app

# 2. Syntax check
npm run check

# 3. Run automated test suite
npm test

# 4. Start the server
npm start
```

Open `http://localhost:3333` in your web browser.

Default local host access code: `ipl2027owner` (configured via `HOST_ACCESS_CODE` environment variable).

---

## Automated Test Coverage

The project includes an automated test runner (`tests/test-runner.js`) that boots an ephemeral instance of the server and executes 3 comprehensive test suites:

1. **`tests/regression-suite.test.js` (7 Suites)**:
   - Simultaneous bids concurrency serialization (Bug A).
   - Last-second bids racing against deadline expiry (Bug A).
   - Late bid rejection after deadline expiry (Bug A).
   - Rapid repeated skip clicks idempotency (Bug C).
   - Participant session persistence and refresh restoration (Bug B).
   - 10 consecutive player transitions stress test.
   - Pause/resume, force-sell/unsold, and purse math verification.

2. **`tests/comprehensive-fix-verification.test.js` (4 Suites)**:
   - 20+ consecutive host skip transitions.
   - 20+ consecutive participant dismissals and audio hold simulations.
   - 30+ mixed transitions stress test (auto-advance sold, auto-advance unsold, pause/resume, skips).
   - Stale celebration callbacks and idempotency protection.

3. **`tests/mega-auction-retention.test.js` (10 Suites)**:
   - Room initialization in `retention` status for Mega mode.
   - Exact slabs math calculation (₹18, 14, 11, 18, 14 Cr capped; ₹4 Cr uncapped).
   - Maximum capped limit enforcement (> 5 rejected).
   - Maximum uncapped limit enforcement (> 2 rejected).
   - Maximum total retention limit enforcement (> 6 rejected).
   - Category restriction enforcement (overseas cannot be uncapped).
   - Duplicate retention draft rejection.
   - Retention cancellation and full purse restoration.
   - Multi-franchise confirmation, finalization, and candidate pool reconstruction (released squad players added to pool).
   - Invariant verification: zero retained players in candidate pool; zero duplicate candidates.
   - Mini Auction isolation: begins directly in `ready` status with pre-seeded rosters.

Run all test suites with a single command:
```bash
npm test
```

---

## Project Structure

```
ipl2027-auction-app/
├── data/
│   ├── candidates.json               # 182 candidate pool registrations
│   ├── initial-squads.json           # 181 current franchise squad rosters
│   ├── teams.json                    # 10 IPL franchise configurations
│   ├── team-audio.json               # Persistent franchise audio mappings
│   └── meta.json                     # Auction metadata & versioning
├── public/
│   ├── app.js                        # Unified frontend SPA application & timer loop
│   ├── index.html                    # HTML entry point (cache versioned)
│   ├── style.css                     # Dark stadium theme with RCB red accents
│   ├── audio/                        # Uploaded franchise hook-line audio clips
│   ├── player-images/                # Local HD player portraits
│   └── team-logos/                   # Official franchise crests & SVG/PNG logos
├── tests/
│   ├── test-runner.js                # Integrated test runner & server bootstrapper
│   ├── regression-suite.test.js      # Concurrency, session, and timer regression suite
│   ├── comprehensive-fix-verification.test.js # Transition & audio stress tests
│   └── mega-auction-retention.test.js # Mega Auction retention validation test suite
├── ipl_2027_current_squad_image_manifest.json # Verified squad player image audit manifest
├── server.js                         # Production Node.js HTTP server & state machine
├── package.json                      # NPM scripts & configuration
└── README.md                         # Documentation & deployment guide
```
