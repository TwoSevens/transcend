const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { OpenAI } = require('openai');
const deepl = require('deepl-node');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve built frontend (if present) for production deployments
const distPath = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
    });
}

// Use process.env (passed via terminal)
const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });
const translator = new deepl.Translator(process.env.DEEPL_KEY);

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('audio_chunk', async (data) => {
        const tempPath = path.join(os.tmpdir(), `audio_${socket.id}.webm`);
        
        try {
            // 1. Save buffer to temporary file
            fs.writeFileSync(tempPath, Buffer.from(data));

            // 2. Transcribe with Whisper
            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(tempPath),
                model: "whisper-1",
            });

            if (transcription.text.trim()) {
                // 3. Translate with DeepL
                const translation = await translator.translateText(transcription.text, null, 'es');

                // 4. Send back to user
                socket.emit('results', {
                    original: transcription.text,
                    translated: translation.text
                });
            }
        } catch (err) {
            console.error('Processing error:', err.message);
        } finally {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }
    });
});

server.listen(5000, () => console.log('Server active on port 5000'));