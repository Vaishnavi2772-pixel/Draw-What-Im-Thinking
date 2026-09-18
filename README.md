# Draw What I'm Thinking

A real-time multiplayer party drawing game built with plain browser JavaScript, Node.js, Express, and Socket.IO.

## What is included

- Room creation with a 5-character code
- 2-12 players with emoji avatars and a live lobby
- Three word modes: built-in random prompts, host-created words, and anonymous contributions from everyone
- Word categories, minimum pool size, host word editing, deleting, and clearing
- Rotating thinker each round
- Automatic random selection from an unused word, with pool reshuffling after exhaustion
- Private secret word that stays on the server and thinker client
- Exactly three required clues
- Touch and mouse drawing canvas with pencil, eraser, brush size, clear, undo, redo, and submit
- Anonymous randomized drawing reveal
- Thinker selection, funniest bonus, scoring, round results, and final leaderboard
- Timers and automatic handling when a player disconnects or a timer expires
- Shareable room links, native sharing, and QR-code joining
- 2-12 players with selectable emoji avatars and a live lobby
- Host-only player removal and room controls
- Synchronized final leaderboard pause followed by a dark winner reveal with trophy, confetti, sparkles, podium, awards, and reduced-motion support
- Room-based WebRTC voice chat with mic controls, push-to-talk, device settings, mic testing, speaking indicators, global mute, and per-player local mute
- Host-configurable game settings for hints, player limits, clue count, text limits, drawing time, rounds, scoring, and voice availability
- A synchronized end-of-game Memory Gallery with filters, lightbox viewing, individual downloads, bulk downloads, and PNG snapshots
- Responsive layout for phones, tablets, and laptops

## Install and run

Requirements: Node.js 18 or newer.

```bash
npm install
npm start
```

For deployment, set the public room origin before starting the server:

```powershell
$env:PUBLIC_GAME_URL = "https://your-deployed-domain.example"
npm.cmd start
```

When `PUBLIC_GAME_URL` is empty, the server derives the public origin from the incoming request, so Render's deployed URL is used automatically. Set `PUBLIC_GAME_URL` only when you need to force a specific public domain. Room links always use `/room/ROOM_CODE`, regardless of the internal server address.

`.env.example` contains the local environment values, and `render.yaml` provides a deployment template for a Node Web Service. Connect the repository to Render and deploy; the game server must remain running for Socket.IO multiplayer rooms and WebRTC signaling to work.

For local development with Node's file watcher, the developer can run:

```bash
npm run dev
```

Run the server-side multiplayer acceptance tests with:

```bash
npm test
```

The tests cover room sizes from 2 through 12 players, thinker rotation, private answers, configurable clue counts and timers, scoring, duplicate submissions, malicious drawing payload rejection, disconnect recovery, hints, and spectator isolation.

## Test with multiple devices

1. Start the server on the computer hosting the game.
2. Find that computer's local IPv4 address. On Windows, run `ipconfig` and look for the IPv4 Address on the active network.
3. Connect the phones or other computers to the same Wi-Fi network.
4. On every device, open `http://YOUR_IPV4_ADDRESS:7000`, such as `http://192.168.1.25:7000`.
5. Create a room on one device, share the five-character code, and join from the other devices.

The lobby's **Copy link** and **Share room** buttons use the configured production origin with `/room/ROOM_CODE`. The QR button contains that same URL. Scanning it opens the join form with the room code already filled in; the player still chooses a name and avatar before joining.

If Windows Firewall asks whether Node.js may communicate on the network, allow it for private networks. For players outside the local network, deploy the Node server to a host that supports WebSockets and share its HTTPS URL.

## Project map

- `server/index.js`: Express static hosting, Socket.IO events, room lookup, and broadcasting personalized state.
- `server/game-room.js`: Authoritative game rules, phases, timers, scoring, private answer handling, and disconnect recovery.
- `public/index.html`: Browser shell and Socket.IO client script loading.
- `public/styles.css`: Responsive party-game visual design.
- `public/app.js`: Screens, Socket.IO client behavior, countdowns, canvas tools, and animations.

## Game state privacy

The secret answer is selected and held in the `GameRoom` instance. It is only included in `getStateFor()` when the requesting socket is the current thinker during the round. In Everyone Contributes mode, the server stores contribution text without an author ID and only exposes the total count. The answer is shared with everyone only after the thinker has selected a drawing and the round has ended.

## Word modes

- **Random Words** uses the built-in collection and the selected category. Mixed combines the built-in categories.
- **Host Creates Words** gives the host an editable private list. The host must meet the minimum word count before starting.
- **Everyone Contributes** lets each player add a secret phrase. No player, including the host, can see who submitted any phrase.

The host chooses the mode, category, and minimum word count in the lobby. A selected word is removed from the available pool for that game; when all words have been used, that pool reshuffles.

## Memory Gallery

At the end of the game, the server sends the completed session's drawings as a private room-scoped gallery. Each memory includes its round, thought, clues, artist, and result only after the final reveal. Players can filter memories, open a lightbox, download individual PNGs, download all images locally, or create a combined PNG snapshot. Drawings are not published or stored outside the active room process.

## Voice chat

Voice uses browser WebRTC peer-to-peer audio. Socket.IO only relays signaling messages between sockets that are currently in the same room; microphone audio is not recorded, uploaded, or stored. Microphone permission is optional, so the drawing game remains playable when permission is denied.

Use the bottom voice dock for mic, local mute-everyone, and settings controls. Settings are stored only in the current browser session. Push-to-talk uses the Space key on desktop and a hold button on mobile. Speaker selection is applied when the browser supports `HTMLMediaElement.setSinkId`; some mobile browsers expose only the default output device.

For production deployment, serve the game over HTTPS. Browsers generally require a secure context for microphone access, except for local development on `localhost`.

## Game settings

The host configures the game in the lobby. Settings are grouped into hints, players, clue/text limits, drawing and rounds, scoring, and voice. The lobby shows a preview and disables Start Game until the configured minimum player count is present. The server validates every setting and locks fairness-sensitive values after the game begins.

The configured clue count is enforced by the server, drawing time controls the drawing phase timer, rounds can be a fixed count or one turn per player, and scoring uses the configured winner, thinker, and funniest-drawing points. Personal voice volume, push-to-talk, and local player mutes remain available after the host locks the game.
