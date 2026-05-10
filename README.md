# Transcend

Transcend is a live transcription + translation app that listens to spoken audio, transcribes it in near real time with Whisper, then translates the transcript into a user-selected language using DeepL.

## Concept

### Problem
Conversations, meetings, and media are hard to follow when spoken in a language the listener is not comfortable with.

### Solution
Transcend gives the user instant translated subtitles by:
1. Logging in and choosing a language of comfort.
2. Choosing an audio source (`microphone` or `OS/system audio`).
3. Continuously capturing audio and sending it for transcription.
4. Translating each transcript segment into the user's selected language.
5. Rendering live transcript + translation in a clean React interface.

### Core User Flow
1. User signs in.
2. User selects language of comfort.
3. User selects sound source.
4. User presses Start.
5. App streams live transcript + translated text.

## Tools and Stack

### Frontend
- React (UI rendering)
- TypeScript (recommended for safer contracts)
- Web Audio APIs (device/system audio capture)
- WebSocket or SSE client (real-time updates)

### Backend
- Node.js + Express/Fastify (API + streaming orchestration)
- Whisper (speech-to-text)
  - Local Whisper runtime or hosted inference endpoint
- DeepL API (text translation)
- Auth provider (Firebase Auth, Auth0, Clerk, or custom JWT)

### Infrastructure and DevOps
- Docker (consistent local/dev environment)
- Redis (optional: buffering, job queue, stream state)
- Logging/monitoring (e.g., OpenTelemetry + Grafana/Datadog)
- CI/CD (GitHub Actions)

### Security and Compliance
- DeepL API key management via environment variables/secrets manager
- Auth token validation on protected routes
- HTTPS in production
- Audio retention policy (prefer ephemeral processing)

## High-Level Architecture

1. Audio Ingest Layer
	- Captures mic or OS audio chunks.
2. Transcription Layer (Whisper)
	- Converts speech chunks into timestamped text segments.
3. Translation Layer (DeepL)
	- Translates transcript segments to target language.
4. Realtime Delivery Layer
	- Pushes transcript + translation updates to frontend.
5. UI Layer (React)
	- Displays source text, translated text, and session state.

## 3-Day MVP Development Checklist

This plan intentionally keeps scope minimal so a working MVP can ship in 3 days.

### Day 1: Core Setup + Capture
- [ ] Create React frontend with one screen: login, language selector, source selector, start/stop button.
- [ ] Implement basic login (email magic link or single social provider).
- [ ] Implement microphone capture first (required).
- [ ] Add OS/system audio as best-effort toggle (fallback: show "coming soon" if not supported on platform/browser).
- [ ] Send short audio chunks from frontend to backend.

### Day 2: Transcribe + Translate Pipeline
- [ ] Add backend endpoint/stream for receiving audio chunks.
- [ ] Integrate Whisper for near-real-time transcription.
- [ ] Integrate DeepL API for translation to selected comfort language.
- [ ] Return transcript + translated text events to frontend.
- [ ] Show rolling transcript feed in UI.

### Day 3: Stabilize + Ship
- [ ] Add basic error handling (API failure, no mic permission, empty audio).
- [ ] Add lightweight reconnect/retry behavior.
- [ ] Validate end-to-end flow: login -> select language/source -> start -> live output.
- [ ] Run smoke tests on at least one desktop browser.
- [ ] Deploy a demo environment with environment variables configured.

### MVP Definition of Done
- [ ] User can sign in.
- [ ] User can select language of comfort.
- [ ] User can choose at least microphone audio and start listening.
- [ ] App displays live transcript and translated text with acceptable delay.
- [ ] Demo URL is accessible and usable.

### After MVP (Out of 3-Day Scope)
- [ ] Full cross-platform OS audio capture support.
- [ ] Transcript history/export.
- [ ] Speaker diarization.
- [ ] Detailed analytics/observability dashboard.
- [ ] Comprehensive automated test suite.

## Suggested Environment Variables

```bash
DEEPL_API_KEY=
WHISPER_API_URL=
WHISPER_API_KEY=
AUTH_PROVIDER_CONFIG=
NODE_ENV=development
```

## Success Metrics

- Median end-to-end latency from spoken word to translated subtitle.
- Transcript accuracy by language/accent.
- Translation quality score (user feedback).
- Session stability (disconnects per hour).

## License

Add your preferred license (MIT, Apache-2.0, etc.) before release.