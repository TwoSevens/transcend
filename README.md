# Transcend: Live Transcription and Translation

Transcend is a streamlined web application designed to provide near real-time subtitles for spoken audio. It uses the **Groq Cloud API** (Whisper) for speech-to-text and the **DeepL API** for high-fidelity translation, delivering a dual-language output to a React-based interface.

## System Architecture

The application operates as a continuous loop between the client and the server to minimize processing overhead:

1. **Client-Side Capture:** The browser runs an on-device VAD (`@ricky0123/vad-web`) to slice the microphone stream into per-utterance audio segments.
2. **Stream Transmission:** Each utterance is shipped to the backend as a raw `ArrayBuffer` over a Socket.io WebSocket.
3. **Transcription (Whisper via Groq):** The Node.js server forwards the chunk to Groq.
4. **Sentence detection (client):** The client accumulates transcripts and detects sentence boundaries (with abbreviation guards) or seals trailing fragments after a silence timeout.
5. **Translation (DeepL):** Each completed sentence is sent back to the server as `finalize_segment`, translated into the user-selected target language, and emitted back as `translation_result`.
6. **UI Update:** The frontend renders transcript and translation side-by-side.

The server is idempotent on `finalize_segment` (per socket), so client retries return the cached translation rather than re-billing DeepL.

## Technology Stack

- **Frontend:** React 19 + Vite + `@ricky0123/vad-react`
- **Backend:** Node.js (≥ 18) + Express 5
- **Real-time:** Socket.io
- **APIs:** Groq (Whisper) and DeepL

## Project Structure

```text
transcend/
├── backend/
│   ├── server.js        # WebSocket logic and API integration
│   ├── .env.example     # API credential template
│   └── package.json
├── frontend/
│   ├── App.jsx          # View router (home ↔ transcribe) + error boundary
│   ├── Home.jsx         # Landing page
│   ├── Transcribe.jsx   # Recording + transcript UI
│   ├── languages.js     # Shared language list
│   ├── socket.js        # Client-side WebSocket
│   ├── vite.config.js   # Includes socket.io dev proxy
│   ├── .env.example
│   └── package.json
└── README.md
```

## Getting Started

```bash
# 1. Backend
cd backend
cp .env.example .env       # fill in GROQ_API_KEY and DEEPL_KEY
npm install
npm run dev                # uses nodemon; or `npm start` for a one-shot run

# 2. Frontend (in a second terminal)
cd frontend
cp .env.example .env
npm install
npm run dev
```

Open the printed Vite URL, click **Start transcribing**, and grant microphone access.

## Environment Variables

**backend/.env**

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `GROQ_API_KEY` | yes | — | Groq Cloud key — https://console.groq.com/keys |
| `DEEPL_KEY` | yes | — | DeepL API key — https://www.deepl.com/account/summary |
| `WHISPER_MODEL` | no | `openai/whisper-large-v3-turbo` | Any Groq-hosted Whisper model. |
| `PORT` | no | `5000` | |
| `ALLOWED_ORIGIN` | no | `*` (dev) / refuse (prod) | Single origin, comma-separated list, or `*`. |
| `NODE_ENV` | no | `development` | `production` fails fast on missing keys and tightens CORS defaults. |

**frontend/.env**

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `VITE_BACKEND_URL` | no | `http://localhost:5000` | Override to point at a remote backend. When unset, the Vite dev server proxies `/socket.io` for you. |

## Production deployment

The backend optionally serves the built frontend from `../frontend/dist`:

```bash
cd frontend && npm run build           # produces frontend/dist/
cd ../backend && NODE_ENV=production \
  GROQ_API_KEY=... DEEPL_KEY=... ALLOWED_ORIGIN=https://your-domain \
  npm start
```

If you serve frontend and backend separately, the `dist/` directory simply won't exist and the static-serving block is a no-op.
