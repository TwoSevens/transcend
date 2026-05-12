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
    AR: 'ar',
    BG: 'bg',
    ZH: 'zh',
    CS: 'cs',
    DA: 'da',
    NL: 'nl',
    EN: 'en-US',
    ET: 'et',
    FI: 'fi',
    FR: 'fr',
    DE: 'de',
    EL: 'el',
    HU: 'hu',
    ID: 'id',
    IT: 'it',
    JA: 'ja',
    KO: 'ko',
    LV: 'lv',
    LT: 'lt',
    NB: 'nb',
    PL: 'pl',
    PT: 'pt-PT',
    RO: 'ro',
    RU: 'ru',
    SK: 'sk',
    SL: 'sl',
    ES: 'es',
    SV: 'sv',
    TR: 'tr',
    UK: 'uk',
};

function resolveTarget(code) {
    if (!code) return 'en-US';
    return DEEPL_TARGET[code.toUpperCase()] || code.toLowerCase();
}

/**
 * Transcribe an audio buffer via Groq Whisper.
 * `prompt` seeds Whisper's decoder with the tail of the current sentence so
 * it doesn't hallucinate or mis-capitalise mid-sentence chunks.
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
     * audio_chunk — Phase 1 only: transcribe and return.
     *
     * Sentence detection and translation are now handled entirely on the
     * client side.  When the client detects a sentence boundary in the
     * accumulated text it calls `finalize_segment` directly.  This handler
     * just runs Whisper and emits the new chunk text as fast as possible.
     */
    socket.on('audio_chunk', async (payload) => {
        try {
            const {
                audio,
                fullTranscript = '', // accumulated text so far (for Whisper context)
                prompt = '',         // last ~30 words for Whisper decoder seeding
                segmentId,
            } = payload || {};

            if (!audio) return;

            const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
            if (buffer.length < 1024) return;

            const chunkTranscript = await transcribe(buffer, prompt || fullTranscript);
            if (!chunkTranscript) return;

            socket.emit('transcription_result', {
                transcript: chunkTranscript,
                segmentId,
            });
        } catch (err) {
            console.error('processing error:', err.message);
            socket.emit('transcription_error', { message: err.message || 'processing failed' });
        }
    });

    /**
     * finalize_segment — translate a completed sentence (or a trailing
     * fragment sealed by the silence timer) and emit the result.
     *
     * Called by the client in two situations:
     *   1. A sentence boundary (. ! ?) was detected in the accumulated text.
     *   2. The 2-second silence timer fired and there is still un-translated text.
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
