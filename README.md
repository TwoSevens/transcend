# Transcend: Live Transcription and Translation

Transcend is a streamlined web application designed to provide near real-time subtitles for spoken audio. It leverages the **Hugging Face Inference API** (Whisper) for speech-to-text and the **DeepL API** for high-fidelity translation, delivering a dual-language output to a React-based interface.

## System Architecture

The application operates as a continuous loop between the client and the server to minimize processing overhead:

1. **Client-Side Capture:** The browser uses the MediaRecorder API to segment microphone input into 3-second audio blobs.
2. **Stream Transmission:** Each blob is shipped to the backend as a raw `ArrayBuffer` over a Socket.io WebSocket.
3. **Transcription (Whisper via Hugging Face):** The Node.js server forwards the chunk to `@huggingface/inference` (`automaticSpeechRecognition`).
4. **Translation (DeepL):** The transcript is translated into the user-selected target language.
5. **UI Update:** The server emits `transcription_result` (`{ transcript, translation }`); the frontend renders both side-by-side.

## Technology Stack

- **Frontend:** React 19 + Vite
- **Backend:** Node.js + Express 5
- **Real-time:** Socket.io
- **APIs:** Hugging Face Inference (Whisper) and DeepL

## Project Structure

```text
transcend/
├── backend/
│   ├── server.js        # WebSocket logic and API integration
│   ├── .env.example     # API credential template
│   └── package.json
├── frontend/
│   ├── App.jsx          # View router (home ↔ transcribe)
│   ├── Home.jsx         # Landing page
│   ├── Transcribe.jsx   # Recording + transcript UI
│   ├── languages.js     # Shared language list
│   ├── socket.js        # Client-side WebSocket
│   ├── .env.example
│   └── package.json
└── README.md
```

## Getting Started

```bash
# 1. Backend
cd backend
cp .env.example .env       # fill in HF_TOKEN and DEEPL_KEY
npm install
npm start

# 2. Frontend (in a second terminal)
cd frontend
cp .env.example .env
npm install
npm run dev
```

Open the printed Vite URL, click **Start transcribing**, and grant microphone access.

## Environment Variables

**backend/.env**
- `HF_TOKEN` — Hugging Face Inference API token
- `DEEPL_KEY` — DeepL API key
- `WHISPER_MODEL` *(optional)* — defaults to `openai/whisper-large-v3-turbo`
- `PORT` *(optional)* — defaults to `5000`

**frontend/.env**
- `VITE_BACKEND_URL` — defaults to `http://localhost:5000`
