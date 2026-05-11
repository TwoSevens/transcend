# Transcend: Live Transcription and Translation

Transcend is a streamlined web application designed to provide near real-time subtitles for spoken audio. It leverages the OpenAI Whisper API for speech-to-text conversion and the DeepL API for high-fidelity translation, delivering a dual-language output to a React-based interface.

## System Architecture

The application operates as a continuous loop between the client and the server to minimize processing overhead:

1.  **Client-Side Capture:** The browser utilizes the MediaRecorder API to segment microphone input into discrete 3-second audio blobs.
2.  **Stream Transmission:** These blobs are emitted to the backend via WebSockets (Socket.io) to maintain a persistent, low-latency connection.
3.  **Transcription (Whisper):** The Node.js server forwards the audio data to the OpenAI Whisper transcription endpoint.
4.  **Translation (DeepL):** The resulting transcript is sent to the DeepL API for translation into the target language.
5.  **UI Update:** The server broadcasts both the original transcript and the translated text back to the frontend for immediate rendering.

## Technology Stack

*   **Frontend:** React (State management and UI)
*   **Backend:** Node.js with Express (API orchestration and WebSocket handling)
*   **Real-time Communication:** Socket.io
*   **External APIs:** OpenAI (Whisper) and DeepL

## Project Structure
```text
transcend/
├── backend/
│   ├── server.js        # WebSocket logic and API integration
│   ├── .env             # API credentials
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.js       # Audio recording and UI display
│   │   └── socket.js    # Client-side WebSocket configuration
│   └── package.json
└── README.md
