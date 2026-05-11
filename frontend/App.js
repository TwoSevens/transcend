import { useState, useEffect, useRef, useCallback } from 'react';
import socket from './socket';
import './App.css';

const CHUNK_MS = 3000;

const LANGUAGES = [
  { code: 'EN', label: 'English' },
  { code: 'AR', label: 'Arabic' },
  { code: 'FR', label: 'French' },
  { code: 'DE', label: 'German' },
  { code: 'ES', label: 'Spanish' },
  { code: 'JA', label: 'Japanese' },
  { code: 'ZH', label: 'Chinese' },
  { code: 'PT', label: 'Portuguese' },
  { code: 'IT', label: 'Italian' },
  { code: 'RU', label: 'Russian' },
];

function timestamp() {
  return new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export default function App() {
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

  /* ── socket events ── */
  useEffect(() => {
    socket.on('connect',    () => { setConnected(true);  setError(''); });
    socket.on('disconnect', () => { setConnected(false); stopRecording(); });
    socket.on('connect_error', () => setError('Backend unreachable — is the server running?'));

    socket.on('transcription_result', ({ transcript, translation }) => {
      idRef.current += 1;
      setSegments(prev => [...prev, {
        id: idRef.current,
        transcript: transcript || '—',
        translation: translation || '—',
        time: timestamp(),
      }]);
      setStatus('recording');
    });

    socket.on('transcription_error', ({ message }) => setError(message));

    return () => socket.removeAllListeners();
  }, []);

  /* ── auto-scroll ── */
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: 'smooth' });
    translationEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [segments]);

  /* ── waveform ── */
  const startWave = () => {
    waveRef.current = setInterval(() => {
      setBars(Array(10).fill(0).map(() => Math.floor(3 + Math.random() * 22)));
    }, 110);
  };
  const stopWave = () => {
    clearInterval(waveRef.current);
    setBars(Array(10).fill(3));
  };

  /* ── send blob to server ── */
  const sendChunk = useCallback((blob) => {
    if (!blob || blob.size === 0) return;
    setStatus('processing…');
    const reader = new FileReader();
    reader.onloadend = () => {
      socket.emit('audio_chunk', {
        audio: reader.result,
        mimeType: blob.type,
        targetLang,
      });
    };
    reader.readAsDataURL(blob);
  }, [targetLang]);

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
    } catch (err) {
      setError('Microphone access denied.');
    }
  };

  /* ── stop ── */
  const stopRecording = useCallback(() => {
    clearInterval(timerRef.current);
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    setRecording(false);
    setStatus('idle');
    stopWave();
  }, []);

  const clearAll = () => {
    stopRecording();
    setSegments([]);
    idRef.current = 0;
    setError('');
  };

  return (
    <div className="app">

      {/* ── header ── */}
      <header className="header">
        <div className="logo">
          <div className="logo-mark">
            <svg viewBox="0 0 16 16" fill="none"><path d="M3 8 Q8 2 13 8 Q8 14 3 8Z" fill="white"/></svg>
          </div>
          <span className="logo-name">TRAN<span>SCEND</span></span>
        </div>

        <div className="lang-controls">
          <span className="lang-label">translate to</span>
          <select
            className="lang-select"
            value={targetLang}
            onChange={e => setTargetLang(e.target.value)}
            disabled={recording}
          >
            {LANGUAGES.map(l => (
              <option key={l.code} value={l.code}>{l.code} — {l.label}</option>
            ))}
          </select>
        </div>
      </header>

      {/* ── error banner ── */}
      {error && <div className="error-bar">{error}</div>}

      {/* ── main panels ── */}
      <main className="panels">

        <div className="panel">
          <div className="panel-header">
            <span className="panel-label">Transcript</span>
            <span className="lang-badge">EN</span>
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
            <span className="lang-badge translated">{targetLang}</span>
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

      {/* ── footer ── */}
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
