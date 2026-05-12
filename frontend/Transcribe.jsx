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

// After this much silence, finalize the active segment even without a period.
const SENTENCE_SEAL_MS = 2000;

/**
 * Segment status lifecycle:
 *
 *   'pending'     — transcript arrived, no translation yet (shown dimmed)
 *   'translating' — sentence boundary detected or seal timer fired;
 *                   translation request in-flight (shown dimmed + spinner)
 *   'done'        — translation arrived (full opacity, right panel populated)
 */

export default function Transcribe({ onBack }) {
  const [segments, setSegments] = useState([]);
  const [status, setStatus]     = useState('idle');

  const targetLangRef = useRef('AR');

  // ── Sentence grouping refs ───────────────────────────────────────────────
  const activeSegmentIdRef = useRef(null); // ID of the line being built
  const segmentsRef        = useRef([]);   // mirror of state for VAD callbacks
  const sentenceTimerRef   = useRef(null); // seal timer

  // Keep segmentsRef current so VAD callbacks don't read stale state.
  useEffect(() => { segmentsRef.current = segments; }, [segments]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Read the accumulated transcript for a given segmentId from the ref. */
  const getAccumulated = (segmentId) => {
    const seg = segmentsRef.current.find(s => s.id === segmentId);
    return seg?.transcript ?? '';
  };

  /**
   * Seal the active segment:
   *   - If it still has no translation, fire `finalize_segment` so the server
   *     translates the hanging text (e.g. speaker stopped mid-sentence).
   *   - Clear activeSegmentIdRef so the next chunk opens a new line.
   */
  const sealSegment = (segmentId) => {
    const seg = segmentsRef.current.find(s => s.id === segmentId);
    if (!seg) return;

    if (seg.status !== 'done') {
      // Mark as translating in the UI so the user sees a spinner.
      setSegments(prev =>
        prev.map(s => s.id === segmentId ? { ...s, status: 'translating' } : s)
      );
      socket.emit('finalize_segment', {
        segmentId,
        fullTranscript: seg.transcript,
        targetLang: targetLangRef.current,
      });
    }

    activeSegmentIdRef.current = null;
  };

  // ── Chunk sender (called by VAD onSpeechEnd) ─────────────────────────────

  const sendChunk = (audio) => {
    setStatus('transcribing...');

    // Reuse or create the active segment.
    if (!activeSegmentIdRef.current) {
      activeSegmentIdRef.current = `seg-${Date.now()}`;
    }
    const segmentId   = activeSegmentIdRef.current;
    const accumulated = getAccumulated(segmentId);
    const prompt      = accumulated.split(' ').slice(-30).join(' ');

    socket.emit('audio_chunk', {
      audio: utils.encodeWAV(audio),
      mimeType: 'audio/wav',
      targetLang: targetLangRef.current,
      segmentId,
      fullTranscript: accumulated,
      prompt,
    });

    // Reset silence timer — each new chunk extends the current sentence.
    clearTimeout(sentenceTimerRef.current);
    sentenceTimerRef.current = setTimeout(() => {
      sealSegment(segmentId);
      setStatus('waiting for speech...');
    }, SENTENCE_SEAL_MS);
  };

  // ── VAD ──────────────────────────────────────────────────────────────────

  const vad = useMicVAD({
    onnxWASMBasePath: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/",
    baseAssetPath:   "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.27/dist/",
    startOnRealize: false,

    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.35,
    redemptionFrames: 12,
    preSpeechPadFrames: 8,
    minSpeechFrames: 3,

    onSpeechStart: () => setStatus('listening...'),
    onSpeechEnd:   (audio) => sendChunk(audio),
    onVADMisfire:  () => setStatus('waiting for speech...'),
  });

  // ── Controls ─────────────────────────────────────────────────────────────

  const startTranscription = () => {
    vad.start();
    setStatus('waiting for speech...');
  };

  const stopTranscription = () => {
    vad.pause();
    clearTimeout(sentenceTimerRef.current);
    if (activeSegmentIdRef.current) {
      sealSegment(activeSegmentIdRef.current);
    }
    setStatus('idle');
  };

  // ── Socket events ─────────────────────────────────────────────────────────

  useEffect(() => {
    /**
     * transcription_result — Phase 1.
     * Append the new chunk text to the segment. Show it immediately, dimmed.
     * If `sentenceComplete`, seal the segment right away (don't wait for the
     * 2s timer) — the next chunk will be a fresh line.
     */
    const onTranscript = ({ transcript, segmentId, sentenceComplete }) => {
      setSegments(prev => {
        const exists = prev.some(s => s.id === segmentId);

        if (exists) {
          return prev.map(s =>
            s.id === segmentId
              ? {
                  ...s,
                  transcript: `${s.transcript} ${transcript}`.trim(),
                  // If a sentence boundary was detected, move to 'translating'
                  // so the spinner shows while we wait for translation_result.
                  status: sentenceComplete ? 'translating' : s.status,
                }
              : s
          );
        }

        // First chunk for this segment.
        return [
          ...prev,
          {
            id: segmentId,
            transcript,
            translation: '',
            time: getTimestamp(),
            status: sentenceComplete ? 'translating' : 'pending',
          },
        ];
      });

      // Seal immediately on sentence boundary so next speech starts fresh.
      if (sentenceComplete) {
        clearTimeout(sentenceTimerRef.current);
        activeSegmentIdRef.current = null;
      }

      setStatus(sentenceComplete ? 'waiting for speech...' : 'listening...');
    };

    /**
     * translation_result — Phase 2.
     * The translation is ready — bring the segment to full opacity and
     * populate the right panel.
     */
    const onTranslation = ({ translation, segmentId }) => {
      setSegments(prev =>
        prev.map(s =>
          s.id === segmentId
            ? { ...s, translation, status: 'done' }
            : s
        )
      );
    };

    const onError = ({ message }) => {
      console.error('transcription error:', message);
      setStatus('waiting for speech...');
    };

    socket.on('transcription_result', onTranscript);
    socket.on('translation_result',   onTranslation);
    socket.on('transcription_error',  onError);

    return () => {
      socket.off('transcription_result', onTranscript);
      socket.off('translation_result',   onTranslation);
      socket.off('transcription_error',  onError);
      clearTimeout(sentenceTimerRef.current);
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <header className="header">
        <button className="logo logo-btn" onClick={onBack}>
          <span className="logo-name">TRAN<span>SCEND</span></span>
        </button>

        <select
          className="lang-select"
          onChange={(e) => (targetLangRef.current = e.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
      </header>

      <main className="panels">

        {/* ── Left: Transcript ── */}
        <div className="panel">
          <div className="panel-header">Transcript</div>
          <div className="panel-scroll">
            {segments.map((s) => (
              <SegmentRow key={s.id} segment={s} field="transcript" />
            ))}
          </div>
        </div>

        {/* ── Right: Translation ── */}
        <div className="panel">
          <div className="panel-header">Translation</div>
          <div className="panel-scroll">
            {segments.map((s) => (
              <SegmentRow key={s.id} segment={s} field="translation" />
            ))}
          </div>
        </div>

      </main>

      <footer className="footer">
        <div className="footer-left">
          <span className="status-text">
            {vad.loading  ? 'Loading models…'
           : vad.errored  ? 'Error loading VAD'
           : status}
          </span>

          <div className="waveform">
            {Array(10).fill(0).map((_, i) => (
              <div
                key={i}
                className="bar"
                style={{
                  height:          vad.userSpeaking ? `${15 + Math.random() * 20}px` : '3px',
                  backgroundColor: vad.userSpeaking ? '#4ade80' : '#ccc',
                  transition:      'height 0.1s ease',
                }}
              />
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className="btn btn-clear"
            onClick={() => setSegments([])}
            disabled={vad.loading || segments.length === 0}
          >
            Clear
          </button>
          <button
            className={`btn ${vad.listening ? 'btn-stop' : 'btn-start'}`}
            onClick={vad.listening ? stopTranscription : startTranscription}
            disabled={vad.loading}
          >
            {vad.listening ? 'Stop' : 'Start Recording'}
          </button>
        </div>
      </footer>
    </div>
  );
}

// ─── SegmentRow ───────────────────────────────────────────────────────────────
//
// Renders one line in either panel.
//
// Visual contract:
//   pending     → text at 35% opacity (transcript visible, no translation yet)
//   translating → text at 35% opacity + small spinning dot (translation in-flight)
//   done        → text at full opacity, translation visible
//
// The opacity lives on the <p> so the timestamp stays readable at all times.

function SegmentRow({ segment, field }) {
  const { status, time } = segment;
  const text = segment[field];

  const isPending     = status === 'pending';
  const isTranslating = status === 'translating';
  const isDone        = status === 'done';

  // Right panel: show a placeholder while translating so the row doesn't collapse.
  const displayText = field === 'translation' && !isDone
    ? ''
    : text;

  return (
    <div className="segment" style={{ position: 'relative' }}>
      <span className="seg-time">{time}</span>

      <p style={{
        opacity:    isDone ? 1 : 0.35,
        transition: 'opacity 0.4s ease',
        margin:     0,
      }}>
        {displayText}

        {/* Blinking cursor while new words may still arrive */}
        {field === 'transcript' && !isDone && (
          <span style={cursorStyle} aria-hidden="true" />
        )}
      </p>

      {/* Spinning dot on the right panel while translation is in-flight */}
      {field === 'translation' && isTranslating && (
        <span style={spinnerStyle} aria-label="translating…" />
      )}
    </div>
  );
}

// ── Inline style objects (avoids needing new CSS classes) ──────────────────

const cursorStyle = {
  display:         'inline-block',
  width:           '2px',
  height:          '1em',
  background:      'currentColor',
  marginLeft:      '3px',
  verticalAlign:   'text-bottom',
  animation:       'transcend-blink 1s step-end infinite',
};

const spinnerStyle = {
  display:      'inline-block',
  width:        '8px',
  height:       '8px',
  borderRadius: '50%',
  background:   'currentColor',
  opacity:      0.5,
  animation:    'transcend-pulse 1s ease-in-out infinite',
  marginLeft:   '6px',
  verticalAlign: 'middle',
};

// Inject the keyframes once into the document head.
// This keeps the component self-contained without touching the global CSS file.
if (typeof document !== 'undefined') {
  const styleId = 'transcend-keyframes';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes transcend-blink  { 50% { opacity: 0; } }
      @keyframes transcend-pulse  { 0%, 100% { opacity: 0.2; } 50% { opacity: 0.8; } }
    `;
    document.head.appendChild(style);
  }
}
