# Get Together — synchronized media MVP

A runnable starter for a real-time watch/listen room. Includes room codes, host/collaborative permissions, Socket.IO playback-state broadcasts, shared queue, participant list, chat, YouTube IFrame player and per-device local media playback.

## Stack
- Web/PWA MVP: React + Vite
- Realtime backend: Node.js + Express + Socket.IO
- YouTube: YouTube IFrame Player API
- Local files: browser File API (currently local to the device selecting the file)
- Deployment: any Node host for server + static frontend host, or serve the built frontend separately.

## Important limits
- This is an MVP starter, not a production-grade service.
- YouTube playback must comply with YouTube's terms, autoplay rules, embedding availability, and regional/content restrictions. A URL cannot guarantee that embedding is allowed.
- Browser-selected local files are **not automatically shared** with other users. The current local-player mode syncs commands/timestamps only; each participant must select the same file. For real remote local-file streaming, add authenticated object storage (e.g. S3-compatible storage) and signed URLs, or a media server. WebRTC data channels are not suitable for sending large media files without chunking, congestion control, and transfer-resume logic.
- ±200 ms is a target, not a guarantee across the public internet. Device decoding, buffering, browser throttling, and network conditions affect drift.
- Add authentication, rate limiting, room expiry, abuse controls, HTTPS/WSS, logging, and durable storage before public deployment.

## Run locally
Requirements: Node.js 20+ and npm.

### 1. Start server
```bash
cd server
npm install
npm run dev
```
Server listens on `http://localhost:4000`.

### 2. Start frontend in another terminal
```bash
cd client
npm install
npm run dev
```
Open the Vite URL (normally `http://localhost:5173`) in two browser windows/devices. To test on a phone on the same Wi-Fi, set `VITE_SERVER_URL` to your computer's LAN IP in `client/.env.local` and open the Vite dev server using `npm run dev -- --host 0.0.0.0`. Your firewall must allow the ports.

### 3. Test
1. Enter a display name and click **Create room**.
2. Copy the six-character code and join from another window/device.
3. Paste a YouTube video URL or select Local file mode.
4. Test play, pause, and seeking. Set control policy to collaborative to let everyone control playback.
5. Use queue and chat to test room broadcasts.

## Environment
`server/.env` (optional):
```env
PORT=4000
CLIENT_ORIGIN=http://localhost:5173
```
`client/.env.local` (optional):
```env
VITE_SERVER_URL=http://localhost:4000
```

## Sync approach
The server is authoritative for room state. Clients send intent events; the server validates room membership and permissions, updates state, stamps it with server time, then broadcasts it. Clients estimate server/client clock offset with periodic ping/pong. A play event includes a future `startAt` (roughly 350 ms ahead) to let clients schedule together. For active playback, clients periodically compare expected position to their player position and gently correct small drift; larger drift uses a seek. This is best-effort synchronization, not frame-perfect synchronization.

## Production next steps
- Add user accounts or short-lived signed guest tokens.
- Use Redis adapter for Socket.IO if horizontally scaling.
- Use PostgreSQL/Redis for durable rooms if required; current rooms live in memory.
- Implement upload-to-object-store with size/type limits, signed URLs, cleanup/expiry, and access control.
- Add automated tests and metrics for drift, reconnections, room lifecycle, and event ordering.


## Build an Android APK (GitHub Actions)

This repository includes a Capacitor Android wrapper and a workflow that builds a **debug APK**. The current environment does not include the Android SDK/Gradle toolchain, so the APK must be built using GitHub Actions or Android Studio.

### Before building
1. Deploy the `server` folder to a public Node.js host that supports WebSockets/Socket.IO. Use HTTPS, and configure the host's start command as `npm start` (or its equivalent). Set `CLIENT_ORIGIN` to the frontend/app origin as appropriate.
2. Copy the public backend URL, e.g. `https://your-api.example.com`. Do not use `localhost` for an APK installed on your phone.
3. Push this project to a GitHub repository.

### Run the APK build
1. Open the repository's **Actions** tab.
2. Select **Build Get Together Android APK** and click **Run workflow**.
3. Paste the public HTTPS backend URL into `server_url` and run it.
4. When the workflow finishes, open the run and download the `get-together-debug-apk` artifact. Extract it to get `app-debug.apk`, then transfer it to your Android phone and install it. Android may ask you to allow installs from that source.

If the workflow is triggered by a push instead, set the repository variable `VITE_SERVER_URL` under **Settings → Secrets and variables → Actions → Variables** before building.

**Important:** A successful APK build does not deploy the backend. Without a reachable backend URL, room creation, room codes, chat, and synchronized playback across devices will not work. This is a debug APK for preview, not a Play Store-signed release.
