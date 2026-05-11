import { useState, useEffect, useRef } from 'react';
import { useMicVAD, utils } from "@ricky0123/vad-react";
import socket from './socket';
import { LANGUAGES } from './languages';

const getTimestamp = () =>
  new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export default function Transcribe({ onBack }) {
  const [segments, setSegments] = useState([]);
  const [status, setStatus] = useState('idle');

  const targetLangRef = useRef('AR');

  // Buffer consecutive speech chunks
  const speechBufferRef = useRef([]);
  const silenceTimeoutRef = useRef(null);

  const sendBufferedAudio = () => {
    if (speechBufferRef.current.length === 0) return;

    setStatus('transcribing sentence...');

    // Merge Float32Arrays
    const totalLength = speechBufferRef.current.reduce(
      (sum, chunk) => sum + chunk.length,
      0
    );

    const merged = new Float32Array(totalLength);

    let offset = 0;

    for (const chunk of speechBufferRef.current) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    speechBufferRef.current = [];

    const wavBuffer = utils.encodeWAV(merged);

    socket.emit('audio_chunk', {
      audio: wavBuffer,
      mimeType: 'audio/wav',
      targetLang: targetLangRef.current,
    });
  };

  // Initialize the VAD hook
  const vad = useMicVAD({
    onnxWASMBasePath:
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/",

    baseAssetPath:
      "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.27/dist/",

    startOnRealize: false,

    // Make VAD less aggressive
    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.35,
    redemptionFrames: 12,
    preSpeechPadFrames: 8,
    minSpeechFrames: 3,

    onSpeechStart: () => {
      setStatus('listening...');
    },

    onSpeechEnd: (audio) => {
      setStatus('detecting sentence end...');

      // Store chunk
      speechBufferRef.current.push(audio);

      // Reset silence timer
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current);
      }

      // Wait for possible continuation
      silenceTimeoutRef.current = setTimeout(() => {
        sendBufferedAudio();
      }, 1400);
    },

    onVADMisfire: () => {
      setStatus('waiting for speech...');
    }
  });

  const startTranscription = () => {
    vad.start();
    setStatus('waiting for speech...');
  };

  const stopTranscription = () => {
    vad.pause();

    // Flush remaining speech
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
    }

    sendBufferedAudio();

    setStatus('idle');
  };

  /* ── Socket & Cleanup ── */

  useEffect(() => {
    const onResult = ({ transcript, translation }) => {
      setSegments(prev => [
        ...prev,
        {
          id: Date.now(),
          transcript,
          translation,
          time: getTimestamp(),
        }
      ]);

      setStatus('waiting for speech...');
    };

    socket.on('transcription_result', onResult);

    return () => {
      socket.off('transcription_result', onResult);

      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="app">
      <header className="header">
        <button className="logo logo-btn" onClick={onBack}>
          <span className="logo-name">
            TRAN<span>SCEND</span>
          </span>
        </button>

        <select
          className="lang-select"
          onChange={(e) => (targetLangRef.current = e.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </header>

      <main className="panels">
        <div className="panel">
          <div className="panel-header">Transcript</div>

          <div className="panel-scroll">
            {segments.map((s) => (
              <div className="segment" key={s.id}>
                <span className="seg-time">{s.time}</span>
                <p>{s.transcript}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">Translation</div>

          <div className="panel-scroll">
            {segments.map((s) => (
              <div className="segment" key={s.id}>
                <span className="seg-time">{s.time}</span>
                <p>{s.translation}</p>
              </div>
            ))}
          </div>
        </div>
      </main>

      <footer className="footer">
        <div className="footer-left">
          <span className="status-text">
            {vad.loading
              ? "Loading models..."
              : vad.errored
              ? "Error loading VAD"
              : status}
          </span>

          <div className="waveform">
            {Array(10)
              .fill(0)
              .map((_, i) => (
                <div
                  key={i}
                  className="bar"
                  style={{
                    height: vad.userSpeaking
                      ? `${15 + Math.random() * 20}px`
                      : '3px',

                    backgroundColor: vad.userSpeaking
                      ? '#4ade80'
                      : '#ccc',

                    transition: 'height 0.1s ease',
                  }}
                />
              ))}
          </div>
        </div>

        <button
          className={`btn ${
            vad.listening ? 'btn-stop' : 'btn-start'
          }`}
          onClick={
            vad.listening
              ? stopTranscription
              : startTranscription
          }
          disabled={vad.loading}
        >
          {vad.listening
            ? 'Stop'
            : 'Start Recording'}
        </button>
      </footer>
    </div>
  );
}
