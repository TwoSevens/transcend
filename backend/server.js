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
const NODE_ENV = process.env.NODE_ENV || 'development';

// ─── Fail fast in production if required keys are missing ───────────────────

const missingKeys = [];
if (!GROQ_API_KEY) missingKeys.push('GROQ_API_KEY');
if (!DEEPL_KEY) missingKeys.push('DEEPL_KEY');

if (missingKeys.length) {
    const msg = `Missing required env vars: ${missingKeys.join(', ')}`;
    if (NODE_ENV === 'production') {
        console.error(`[fatal] ${msg}`);
        process.exit(1);
    } else {
        console.warn(`[warn] ${msg} — related features will fail.`);
    }
}

// ─── Tunables ───────────────────────────────────────────────────────────────

const LIMITS = {
    MAX_AUDIO_BYTES: 5 * 1024 * 1024,   // 5 MB per chunk
    MIN_AUDIO_BYTES: 1024,              // skip tiny/silent chunks
    MAX_TRANSCRIPT_CHARS: 8000,         // cap accumulated text passed around
    MAX_PROMPT_CHARS: 500,              // Whisper decoder seed
    AUDIO_CHUNKS_PER_WINDOW: 20,        // rate limit: chunks per socket
    FINALIZE_PER_WINDOW: 10,            // rate limit: finalize calls per socket
    RATE_WINDOW_MS: 10_000,             // sliding window for rate limits
};

const RETRY = {
    MAX_ATTEMPTS: 3,
    BASE_DELAY_MS: 300,
    MAX_DELAY_MS: 2000,
    TIMEOUT_MS: 30_000,                 // per-attempt timeout
};

// ─── App / server setup ─────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    maxHttpBufferSize: LIMITS.MAX_AUDIO_BYTES + 64 * 1024, // headroom for envelope
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const distPath = path.join(__dirname, '../frontend/dist');
const indexPath = path.join(distPath, 'index.html');
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.use((req, res, next) => {
        if (req.method !== 'GET') return next();
        // Guard against a missing index.html instead of throwing
        fs.access(indexPath, fs.constants.R_OK, (err) => {
            if (err) return next();
            res.sendFile(indexPath);
        });
    });
}

const translator = new deepl.Translator(DEEPL_KEY || 'missing');

// ─── DeepL target resolution ────────────────────────────────────────────────

const DEEPL_TARGET = {
    AR: 'ar', BG: 'bg', ZH: 'zh', CS: 'cs', DA: 'da', NL: 'nl',
    EN: 'en-US', ET: 'et', FI: 'fi', FR: 'fr', DE: 'de', EL: 'el',
    HU: 'hu', ID: 'id', IT: 'it', JA: 'ja', KO: 'ko', LV: 'lv',
    LT: 'lt', NB: 'nb', PL: 'pl', PT: 'pt-PT', RO: 'ro', RU: 'ru',
    SK: 'sk', SL: 'sl', ES: 'es', SV: 'sv', TR: 'tr', UK: 'uk',
};

// Lazily-loaded set of valid DeepL target codes (lowercased) from the SDK.
// We fetch once and reuse; if the call fails we fall back to the static map.
let validDeepLTargets = null;
let validDeepLTargetsPromise = null;

async function getValidDeepLTargets() {
    if (validDeepLTargets) return validDeepLTargets;
    if (validDeepLTargetsPromise) return validDeepLTargetsPromise;

    validDeepLTargetsPromise = (async () => {
        try {
            const langs = await translator.getTargetLanguages();
            validDeepLTargets = new Set(langs.map((l) => l.code.toLowerCase()));
            return validDeepLTargets;
        } catch (err) {
            console.warn('[warn] Could not fetch DeepL target list:', err.message);
            // Fallback: trust the static map
            validDeepLTargets = new Set(Object.values(DEEPL_TARGET).map((v) => v.toLowerCase()));
            return validDeepLTargets;
        } finally {
            validDeepLTargetsPromise = null;
        }
    })();

    return validDeepLTargetsPromise;
}

async function resolveTarget(code) {
    const fallback = 'en-US';
    if (!code) return fallback;

    const mapped = DEEPL_TARGET[code.toUpperCase()] || code;
    const candidate = mapped.toLowerCase();

    const valid = await getValidDeepLTargets();
    if (valid.has(candidate)) return mapped;

    // Try a region-stripped variant (e.g. "pt-br" → "pt")
    const base = candidate.split('-')[0];
    for (const v of valid) {
        if (v === base || v.startsWith(`${base}-`)) return v;
    }

    throw new Error(`Unsupported target language: ${code}`);
}

// ─── Retry helper with timeout + exponential backoff ────────────────────────

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function isRetryableError(err) {
    // Network errors, 5xx, 429
    if (!err) return false;
    const msg = String(err.message || err);
    if (/timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(msg)) return true;
    if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
    // deepl-node sometimes exposes a statusCode
    if (err.statusCode && (err.statusCode === 429 || err.statusCode >= 500)) return true;
    return false;
}

async function withRetry(label, fn) {
    let lastErr;
    for (let attempt = 1; attempt <= RETRY.MAX_ATTEMPTS; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastErr = err;
            if (attempt === RETRY.MAX_ATTEMPTS || !isRetryableError(err)) throw err;
            const delay = Math.min(
                RETRY.MAX_DELAY_MS,
                RETRY.BASE_DELAY_MS * 2 ** (attempt - 1),
            ) + Math.floor(Math.random() * 100);
            console.warn(`[retry] ${label} attempt ${attempt} failed: ${err.message}. retrying in ${delay}ms`);
            await sleep(delay);
        }
    }
    throw lastErr;
}

function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

// ─── External calls ─────────────────────────────────────────────────────────

/**
 * Transcribe an audio buffer via Groq Whisper.
 * `prompt` seeds Whisper's decoder with the tail of the current sentence so
 * it doesn't hallucinate or mis-capitalise mid-sentence chunks.
 */
async function transcribe(buffer, prompt = '') {
    return withRetry('groq.transcribe', async () => {
        const form = new FormData();
        form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'audio.wav');
        form.append('model', WHISPER_MODEL);
        if (prompt) form.append('prompt', prompt.slice(-LIMITS.MAX_PROMPT_CHARS));

        const response = await fetchWithTimeout(
            'https://api.groq.com/openai/v1/audio/transcriptions',
            {
                method: 'POST',
                headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
                body: form,
            },
            RETRY.TIMEOUT_MS,
        );

        if (!response.ok) {
            const err = await response.text().catch(() => '');
            const e = new Error(`Groq API error ${response.status}: ${err}`);
            e.statusCode = response.status;
            throw e;
        }

        const json = await response.json();
        return (json.text || '').trim();
    });
}

async function translate(text, target) {
    if (!text) return '';
    return withRetry('deepl.translate', async () => {
        const result = await translator.translateText(text, null, target);
        return result.text;
    });
}

// ─── Per-socket rate limiter (sliding window) ───────────────────────────────

function makeRateLimiter(limit, windowMs) {
    const hits = [];
    return function allow() {
        const now = Date.now();
        while (hits.length && hits[0] <= now - windowMs) hits.shift();
        if (hits.length >= limit) return false;
        hits.push(now);
        return true;
    };
}

// ─── Validation helpers ─────────────────────────────────────────────────────

function clampString(value, max) {
    if (typeof value !== 'string') return '';
    return value.length > max ? value.slice(-max) : value;
}

function coerceBuffer(audio) {
    if (Buffer.isBuffer(audio)) return audio;
    if (audio instanceof ArrayBuffer) return Buffer.from(audio);
    if (ArrayBuffer.isView(audio)) return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
    if (typeof audio === 'string') {
        // Allow base64 fallback
        try { return Buffer.from(audio, 'base64'); } catch { return null; }
    }
    return null;
}

// ─── Socket handlers ─────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log('client connected:', socket.id);

    const allowAudio = makeRateLimiter(LIMITS.AUDIO_CHUNKS_PER_WINDOW, LIMITS.RATE_WINDOW_MS);
    const allowFinalize = makeRateLimiter(LIMITS.FINALIZE_PER_WINDOW, LIMITS.RATE_WINDOW_MS);

    /**
     * audio_chunk — Phase 1 only: transcribe and return.
     *
     * Sentence detection and translation are handled entirely on the client.
     * When the client detects a sentence boundary it calls `finalize_segment`.
     */
    socket.on('audio_chunk', async (payload) => {
        try {
            if (!allowAudio()) {
                socket.emit('transcription_error', {
                    message: 'Rate limit exceeded for audio_chunk',
                    code: 'RATE_LIMIT',
                });
                return;
            }

            const {
                audio,
                fullTranscript = '',
                prompt = '',
                segmentId,
            } = payload || {};

            if (!audio) return;

            const buffer = coerceBuffer(audio);
            if (!buffer) {
                socket.emit('transcription_error', {
                    message: 'Invalid audio payload',
                    code: 'BAD_PAYLOAD',
                    segmentId,
                });
                return;
            }
            if (buffer.length < LIMITS.MIN_AUDIO_BYTES) return;
            if (buffer.length > LIMITS.MAX_AUDIO_BYTES) {
                socket.emit('transcription_error', {
                    message: `Audio chunk too large (${buffer.length} bytes)`,
                    code: 'TOO_LARGE',
                    segmentId,
                });
                return;
            }

            const seed = clampString(prompt || fullTranscript, LIMITS.MAX_PROMPT_CHARS);
            const chunkTranscript = await transcribe(buffer, seed);
            if (!chunkTranscript) return;

            socket.emit('transcription_result', {
                transcript: chunkTranscript,
                segmentId,
            });
        } catch (err) {
            console.error('processing error:', err.message);
            socket.emit('transcription_error', {
                message: err.message || 'processing failed',
                code: 'TRANSCRIBE_FAILED',
                segmentId: payload?.segmentId,
            });
        }
    });

    /**
     * finalize_segment — translate a completed sentence (or trailing fragment
     * sealed by the silence timer) and emit the result.
     *
     * Errors are surfaced to the client with a code so it can decide whether
     * to retry, fall back, or show the user a message.
     */
    socket.on('finalize_segment', async (payload) => {
        const segmentId = payload?.segmentId;
        try {
            if (!allowFinalize()) {
                socket.emit('translation_error', {
                    message: 'Rate limit exceeded for finalize_segment',
                    code: 'RATE_LIMIT',
                    segmentId,
                });
                return;
            }

            const { fullTranscript, targetLang } = payload || {};
            if (!segmentId || !fullTranscript) return;

            const text = clampString(fullTranscript, LIMITS.MAX_TRANSCRIPT_CHARS);

            let target;
            try {
                target = await resolveTarget(targetLang);
            } catch (err) {
                socket.emit('translation_error', {
                    message: err.message,
                    code: 'BAD_TARGET_LANG',
                    segmentId,
                });
                return;
            }

            try {
                const translation = await translate(text, target);
                socket.emit('translation_result', { translation, segmentId });
            } catch (err) {
                console.error('finalize translate error:', err.message);
                socket.emit('translation_error', {
                    message: err.message || 'translation failed',
                    code: 'TRANSLATE_FAILED',
                    segmentId,
                });
            }
        } catch (err) {
            console.error('finalize error:', err.message);
            socket.emit('translation_error', {
                message: err.message || 'finalize failed',
                code: 'INTERNAL',
                segmentId,
            });
        }
    });

    socket.on('disconnect', () => console.log('client disconnected:', socket.id));
});

// ─── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown(signal) {
    console.log(`[${signal}] shutting down...`);
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, () => console.log(`server active on port ${PORT}`));
