require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const deepl = require('deepl-node');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 5000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPL_KEY = process.env.DEEPL_KEY;
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'openai/whisper-large-v3-turbo';

if (!GROQ_API_KEY) console.warn('[warn] GROQ_API_KEY not set — transcription will fail.');
if (!DEEPL_KEY) console.warn('[warn] DEEPL_KEY not set — translation will fail.');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    maxHttpBufferSize: 5 * 1024 * 1024,
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const distPath = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.use((req, res, next) => {
        if (req.method !== 'GET') return next();
        res.sendFile(path.join(distPath, 'index.html'));
    });
}

const translator = new deepl.Translator(DEEPL_KEY || 'missing');

const DEEPL_TARGET = {
    EN: 'en-US',
    PT: 'pt-PT',
    AR: 'ar',
    FR: 'fr',
    DE: 'de',
    ES: 'es',
    JA: 'ja',
    ZH: 'zh',
    IT: 'it',
    RU: 'ru',
};

function resolveTarget(code) {
    if (!code) return 'en-US';
    return DEEPL_TARGET[code.toUpperCase()] || code.toLowerCase();
}

/**
 * Returns true when the accumulated text ends with sentence-terminating
 * punctuation, optionally followed by closing quotes/brackets.
 * This is the trigger for immediate translation — no need to wait for the
 * client's 2-second silence timer.
 */
function hasSentenceEnd(text) {
    return /[.!?]['")\]]*\s*$/.test(text.trim());
}

/**
 * Transcribe an audio buffer via Groq Whisper.
 * `prompt` is the tail of the accumulated transcript — it seeds Whisper's
 * decoder so it doesn't hallucinate or break on short mid-sentence chunks.
 */
async function transcribe(buffer, prompt = '') {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', WHISPER_MODEL);
    if (prompt) form.append('prompt', prompt.slice(-500));

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        body: form,
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Groq API error ${response.status}: ${err}`);
    }

    return ((await response.json()).text || '').trim();
}

async function translate(text, target) {
    if (!text) return '';
    const result = await translator.translateText(text, null, target);
    return result.text;
}

// ─── Socket handlers ─────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log('client connected:', socket.id);

    /**
     * audio_chunk
     *
     * Two-phase pipeline:
     *
     * Phase 1 — Transcription (fast, ~1-2 s):
     *   Whisper returns the new chunk text. We emit `transcription_result`
     *   immediately so the client can render it in the left panel right away,
     *   shown dimmed since there's no translation yet.
     *
     * Phase 2 — Translation (triggered by sentence boundary):
     *   If the accumulated text ends with . ! or ?, we translate the full
     *   sentence and emit `translation_result`. The client uses this to fill
     *   the right panel and bring the left panel to full opacity.
     *   Sentences without terminal punctuation are handled by `finalize_segment`.
     */
    socket.on('audio_chunk', async (payload) => {
        try {
            const {
                audio,
                targetLang,
                fullTranscript = '', // everything transcribed for this segment so far
                prompt = '',         // last ~30 words for Whisper context
                segmentId,
            } = payload || {};

            if (!audio) return;

            const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
            if (buffer.length < 1024) return;

            // ── Phase 1 ──────────────────────────────────────────────────────
            const chunkTranscript = await transcribe(buffer, prompt || fullTranscript);
            if (!chunkTranscript) return;

            const combined = fullTranscript
                ? `${fullTranscript} ${chunkTranscript}`.trim()
                : chunkTranscript;

            const sentenceComplete = hasSentenceEnd(combined);

            // Emit transcript immediately — client shows it dimmed.
            socket.emit('transcription_result', {
                transcript: chunkTranscript,
                segmentId,
                sentenceComplete, // client seals the segment & opens new line if true
            });

            // ── Phase 2 ──────────────────────────────────────────────────────
            if (sentenceComplete) {
                const target = resolveTarget(targetLang);
                let translation = '';
                try {
                    translation = await translate(combined, target);
                } catch (err) {
                    console.error('translate error:', err.message);
                    translation = '(translation failed)';
                }
                socket.emit('translation_result', { translation, segmentId });
            }
        } catch (err) {
            console.error('processing error:', err.message);
            socket.emit('transcription_error', { message: err.message || 'processing failed' });
        }
    });

    /**
     * finalize_segment
     *
     * The client fires this when its 2-second silence timer expires and the
     * active segment still has no translation (speaker trailed off without a
     * period / question mark).  We translate whatever text we're given.
     */
    socket.on('finalize_segment', async (payload) => {
        try {
            const { segmentId, fullTranscript, targetLang } = payload || {};
            if (!segmentId || !fullTranscript) return;

            const target = resolveTarget(targetLang);
            let translation = '';
            try {
                translation = await translate(fullTranscript, target);
            } catch (err) {
                console.error('finalize translate error:', err.message);
                translation = '(translation failed)';
            }
            socket.emit('translation_result', { translation, segmentId });
        } catch (err) {
            console.error('finalize error:', err.message);
        }
    });

    socket.on('disconnect', () => console.log('client disconnected:', socket.id));
});

server.listen(PORT, () => console.log(`server active on port ${PORT}`));
