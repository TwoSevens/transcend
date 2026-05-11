require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { InferenceClient } = require('@huggingface/inference');
const deepl = require('deepl-node');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 5000;
const HF_TOKEN = process.env.HF_TOKEN;
const DEEPL_KEY = process.env.DEEPL_KEY;
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'openai/whisper-large-v3-turbo';

if (!HF_TOKEN) console.warn('[warn] HF_TOKEN not set — transcription will fail.');
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
    // Express 5 routing — use middleware for the SPA fallback.
    app.use((req, res, next) => {
        if (req.method !== 'GET') return next();
        res.sendFile(path.join(distPath, 'index.html'));
    });
}

const hf = new InferenceClient(HF_TOKEN);
const translator = new deepl.Translator(DEEPL_KEY || 'missing');

// DeepL accepts these target codes; map the simple UI codes to DeepL's expected form.
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

async function transcribe(buffer) {
    const out = await hf.automaticSpeechRecognition({
        data: buffer,
        model: WHISPER_MODEL,
        provider: 'auto',
    });
    return (out && out.text ? out.text : '').trim();
}

async function translate(text, target) {
    if (!text) return '';
    const result = await translator.translateText(text, null, target);
    return result.text;
}

io.on('connection', (socket) => {
    console.log('client connected:', socket.id);

    socket.on('audio_chunk', async (payload) => {
        try {
            const { audio, targetLang } = payload || {};
            if (!audio) return;

            // socket.io delivers ArrayBuffer; coerce to Node Buffer.
            const buffer = Buffer.isBuffer(audio)
                ? audio
                : Buffer.from(audio);

            if (buffer.length < 1024) return; // skip empty/near-silent chunks

            const transcript = await transcribe(buffer);
            if (!transcript) return;

            const target = resolveTarget(targetLang);
            let translation = '';
            try {
                translation = await translate(transcript, target);
            } catch (err) {
                console.error('translate error:', err.message);
                translation = '(translation failed)';
            }

            socket.emit('transcription_result', { transcript, translation });
        } catch (err) {
            console.error('processing error:', err.message);
            socket.emit('transcription_error', { message: err.message || 'processing failed' });
        }
    });

    socket.on('disconnect', () => console.log('client disconnected:', socket.id));
});

server.listen(PORT, () => console.log(`server active on port ${PORT}`));
