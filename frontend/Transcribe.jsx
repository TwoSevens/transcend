import { useState, useEffect, useRef, useCallback } from 'react';
import socket from './socket';
import { LANGUAGES } from './languages';

const CHUNK_MS = 3000;

function timestamp() {
  return new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export default function Transcribe({ onBack }) {
  const [recording, setRecording] = useState(false);
  const [segments, setSegments] = useState([]);
  const [status, setStatus] = useState('idle');
  const [connected, setConnected] = useState(socket.connected);
  const [error, setError] = useState('');
  const [targetLang, setTargetLang] = useState('AR');
  const [bars, setBars] = useState(Array(10).fill(3));

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const waveRef = useRef(null);
  const transcriptEnd = useRef(null);
  const translationEnd = useRef(null);
  const idRef = useRef(0);
  const targetLangRef = useRef(targetLang);

  // Keep ref in sync so the recorder callback always sees the current language.
  useEffect(() => { targetLangRef.current = targetLang; }, [targetLang]);

  const stopWave = useCallback(() => {
    clearInterval(waveRef.current);
    setBars(Array(10).fill(3));
  }, []);

  const stopRecording = useCallback(() => {
    clearInterval(timerRef.current);
    try { recorderRef.current?.stop(); } catch { /* already stopped */ }
    streamRef.current?.getTracks().forEach(t => t.stop());
    setRecording(false);
    setStatus('idle');
    stopWave();
  }, [stopWave]);

  /* ── socket events ── */
  useEffect(() => {
    const onConnect    = () => { setConnected(true);  setError(''); };
    const onDisconnect = () => { setConnected(false); stopRecording(); };
    const onConnectErr = () => setError('Backend unreachable — is the server running?');
    const onResult = ({ transcript, translation }) => {
      idRef.current += 1;
      setSegments(prev => [...prev, {
        id: idRef.current,
        transcript: transcript || '—',
        translation: translation || '—',
        time: timestamp(),
      }]);
      setStatus('recording');
    };
    const onError = ({ message }) => setError(message);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectErr);
    socket.on('transcription_result', onResult);
    socket.on('transcription_error', onError);

    if (socket.connected) setConnected(true);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectErr);
      socket.off('transcription_result', onResult);
      socket.off('transcription_error', onError);
    };
  }, [stopRecording]);

  /* ── auto-scroll ── */
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: 'smooth' });
    translationEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [segments]);

  /* ── cleanup on unmount ── */
  useEffect(() => () => stopRecording(), [stopRecording]);

  /* ── waveform ── */
  const startWave = () => {
    waveRef.current = setInterval(() => {
      setBars(Array(10).fill(0).map(() => Math.floor(3 + Math.random() * 22)));
    }, 110);
  };

  /* ── send blob to server ── */
  const sendChunk = useCallback(async (blob) => {
    if (!blob || blob.size === 0) return;
    setStatus('processing…');
    try {
      const buffer = await blob.arrayBuffer();
      socket.emit('audio_chunk', {
        audio: buffer,
        mimeType: blob.type,
        targetLang: targetLangRef.current,
      });
    } catch (err) {
      setError('Failed to send audio chunk.');
    }
  }, []);

  /* ── start ── */
  const startRecording = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => sendChunk(e.data);
      recorder.start();

      timerRef.current = setInterval(() => {
        if (recorder.state === 'recording') {
          recorder.stop();
          recorder.start();
        }
      }, CHUNK_MS);

      setRecording(true);
      setStatus('recording');
      startWave();
    } catch {
      setError('Microphone access denied.');
    }
  };

  const clearAll = () => {
    stopRecording();
    setSegments([]);
    idRef.current = 0;
    setError('');
  };

  const targetLabel = LANGUAGES.find(l => l.code === targetLang)?.label || targetLang;

  return (
    <div className="app">
      <header className="header">
        <button className="logo logo-btn" onClick={onBack} aria-label="back to home">
          <div className="logo-mark">
            <svg viewBox="0 0 16 16" fill="none"><path d="M3 8 Q8 2 13 8 Q8 14 3 8Z" fill="white"/></svg>
          </div>
          <span className="logo-name">TRAN<span>SCEND</span></span>
        </button>

        <div className="lang-controls">
          <span className="lang-label">translate to</span>
          <select
            className="lang-select"
            value={targetLang}
            onChange={e => setTargetLang(e.target.value)}
          >
            {LANGUAGES.map(l => (
              <option key={l.code} value={l.code}>{l.code} — {l.label}</option>
            ))}
          </select>
        </div>
      </header>

      {error && <div className="error-bar">{error}</div>}

      <main className="panels">
        <div className="panel">
          <div className="panel-header">
            <span className="panel-label">Transcript</span>
            <span className="lang-badge">auto</span>
          </div>
          <div className="panel-scroll">
            {segments.length === 0
              ? <p className="empty">waiting for audio…</p>
              : segments.map(s => (
                <div className="segment" key={s.id}>
                  <span className="seg-time">{s.time} <em>#{s.id}</em></span>
                  <p className="seg-text">{s.transcript}</p>
                </div>
              ))
            }
            <div ref={transcriptEnd} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <span className="panel-label">Translation</span>
            <span className="lang-badge translated" title={targetLabel}>{targetLang}</span>
          </div>
          <div className="panel-scroll">
            {segments.length === 0
              ? <p className="empty">waiting for audio…</p>
              : segments.map(s => (
                <div className="segment" key={s.id}>
                  <span className="seg-time">{s.time} <em>#{s.id}</em></span>
                  <p className="seg-text">{s.translation}</p>
                </div>
              ))
            }
            <div ref={translationEnd} />
          </div>
        </div>
      </main>

      <footer className="footer">
        <div className="footer-left">
          <div className={`dot ${recording ? 'recording' : connected ? 'connected' : ''}`} />
          <span className="status-text">
            {!connected ? 'disconnected' : status}
          </span>
          <div className="waveform">
            {bars.map((h, i) => (
              <div
                key={i}
                className={`bar ${recording ? 'rec' : ''}`}
                style={{ height: h + 'px' }}
              />
            ))}
          </div>
        </div>

        <div className="footer-right">
          <button className="btn btn-clear" onClick={clearAll}>Clear</button>
          <button
            className={`btn ${recording ? 'btn-stop' : 'btn-start'}`}
            onClick={recording ? stopRecording : startRecording}
            disabled={!connected}
          >
            {recording ? 'Stop' : 'Start Recording'}
          </button>
        </div>
      </footer>
    </div>
  );
}
