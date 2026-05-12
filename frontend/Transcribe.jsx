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

// After this much silence, seal the trailing segment even without a period.
const SENTENCE_SEAL_MS = 2000;

/**
 * Split accumulated text into complete sentences and a trailing fragment.
 *
 * e.g. "Hello world. How are you doing"
 *   → { sentences: ["Hello world."], remaining: "How are you doing" }
 */
function extractSentences(text) {
  const regex = /[^.!?]*[.!?]['")\]]*/g;
  const sentences = [];
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const s = match[0].trim();
    if (s) sentences.push(s);
    lastIndex = match.index + match[0].length;
  }
  return { sentences, remaining: text.slice(lastIndex).trim() };
}

/**
 * Segment status lifecycle:
 *
 *   'pending'     — transcript arriving, no translation yet (shown dimmed)
 *   'translating' — sentence boundary detected or seal timer fired;
 *                   translation request in-flight (shown dimmed + spinner)
 *   'done'        — translation arrived (full opacity, right panel populated)
 *
 * Segment data shape:
 *   { id, sessionId, transcript, translation, time, status, isFirstInSession }
 *
 * One "session" = one continuous VAD speech period → one timestamp group.
 * Within a session, each completed sentence becomes its own sub-row.
 * The timestamp is shown only on the first sub-row of each session.
 */

export default function Transcribe({ onBack }) {
  const [segments, setSegments] = useState([]);
  const [status, setStatus]     = useState('idle');

  const targetLangRef = useRef('AR');

  // ── Session / segment tracking ────────────────────────────────────────────
  const activeSessionIdRef   = useRef(null); // current VAD session (new timestamp group)
  const trailingSegmentIdRef = useRef(null); // the accumulating sub-row
  const accumulatedTextRef   = useRef('');   // full text in the trailing sub-row

  const segmentsRef      = useRef([]);
  const sentenceTimerRef = useRef(null);

  // Keep segmentsRef in sync so event callbacks always see fresh data.
  useEffect(() => { segmentsRef.current = segments; }, [segments]);

  // ── Seal trailing segment (silence timeout or explicit stop) ─────────────
  const sealTrailingSegment = () => {
    const segmentId = trailingSegmentIdRef.current;

    if (segmentId) {
      const seg = segmentsRef.current.find(s => s.id === segmentId);
      if (seg && seg.transcript && seg.status !== 'done') {
        setSegments(prev =>
          prev.map(s => s.id === segmentId ? { ...s, status: 'translating' } : s)
        );
        socket.emit('finalize_segment', {
          segmentId,
          fullTranscript: seg.transcript,
          targetLang: targetLangRef.current,
        });
      }
    }

    // Reset all session state — next VAD start will open a fresh session.
    trailingSegmentIdRef.current = null;
    activeSessionIdRef.current   = null;
    accumulatedTextRef.current   = '';
  };

  // ── Sentence boundary processing ─────────────────────────────────────────
  /**
   * Called after every transcription chunk is appended to accumulatedTextRef.
   * If one or more complete sentences exist in the accumulated text:
   *   - Each sentence becomes its own sub-row (status: 'translating')
   *   - A translation is requested for each via finalize_segment
   *   - The leftover fragment (if any) stays as the new trailing sub-row
   */
  const processSentenceBoundaries = (trailingId) => {
    const { sentences, remaining } = extractSentences(accumulatedTextRef.current);
    if (sentences.length === 0) return; // nothing to seal yet

    const sessionId = activeSessionIdRef.current;
    const now       = Date.now();

    // Pre-generate all IDs before any state mutation so both setSegments
    // and socket.emit reference exactly the same values.
    const completedIds  = sentences.map((_, i) => i === 0 ? trailingId : `seg-${now}-c${i}`);
    const newTrailingId = remaining ? `seg-${now}-trail` : null;

    // Update refs synchronously — must happen before setSegments so that
    // any incoming transcription_result routes to the correct target.
    accumulatedTextRef.current   = remaining;
    trailingSegmentIdRef.current = newTrailingId;

    setSegments(prev => {
      const idx = prev.findIndex(s => s.id === trailingId);
      if (idx === -1) return prev;

      const origin = prev[idx]; // the trailing sub-row being split

      // One sub-row per completed sentence.
      const completedSegs = sentences.map((text, i) => ({
        ...origin,
        id: completedIds[i],
        transcript: text,
        translation: '',
        status: 'translating',
        // Only the very first sub-row of the session carries the timestamp.
        isFirstInSession: i === 0 ? origin.isFirstInSession : false,
      }));

      const insertions = [...completedSegs];

      // Append a fresh trailing sub-row for the remaining fragment.
      if (newTrailingId) {
        insertions.push({
          id: newTrailingId,
          sessionId,
          transcript: remaining,
          translation: '',
          time: getTimestamp(),
          status: 'pending',
          isFirstInSession: false,
        });
      }

      const next = [...prev];
      next.splice(idx, 1, ...insertions);
      return next;
    });

    // Request a translation for each sealed sentence.
    completedIds.forEach((segId, i) => {
      socket.emit('finalize_segment', {
        segmentId:    segId,
        fullTranscript: sentences[i],
        targetLang:   targetLangRef.current,
      });
    });
  };

  // ── Chunk sender (called by VAD onSpeechEnd) ─────────────────────────────
  const sendChunk = (audio) => {
    setStatus('transcribing...');

    // Ensure a session exists.
    const sessionId = activeSessionIdRef.current ?? `session-${Date.now()}`;
    activeSessionIdRef.current = sessionId;

    // Create a trailing sub-row if none exists for this session.
    if (!trailingSegmentIdRef.current) {
      const newId = `seg-${Date.now()}`;
      trailingSegmentIdRef.current = newId;

      setSegments(prev => [
        ...prev,
        {
          id: newId,
          sessionId,
          transcript: '',
          translation: '',
          time: getTimestamp(),
          status: 'pending',
          // First sub-row of this session if no prior segments share the sessionId.
          isFirstInSession: !prev.some(s => s.sessionId === sessionId),
        },
      ]);
    }

    const segmentId = trailingSegmentIdRef.current;
    const prompt    = accumulatedTextRef.current.split(' ').slice(-30).join(' ');

    socket.emit('audio_chunk', {
      audio:        utils.encodeWAV(audio),
      mimeType:     'audio/wav',
      targetLang:   targetLangRef.current,
      segmentId,
      fullTranscript: accumulatedTextRef.current,
      prompt,
    });

    // Silence timer: seal the trailing sub-row if no new speech arrives.
    clearTimeout(sentenceTimerRef.current);
    sentenceTimerRef.current = setTimeout(() => {
      sealTrailingSegment();
      setStatus('waiting for speech...');
    }, SENTENCE_SEAL_MS);
  };

  // ── VAD ──────────────────────────────────────────────────────────────────
  const vad = useMicVAD({
    onnxWASMBasePath: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',
    baseAssetPath:   'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.27/dist/',
    startOnRealize: false,

    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.35,
    redemptionFrames: 12,
    preSpeechPadFrames: 8,
    minSpeechFrames: 3,

    onSpeechStart: () => {
      // Open a new session on the first speech of a silence → speech transition.
      if (!activeSessionIdRef.current) {
        activeSessionIdRef.current = `session-${Date.now()}`;
      }
      setStatus('listening...');
    },
    onSpeechEnd:  (audio) => sendChunk(audio),
    onVADMisfire: () => setStatus('waiting for speech...'),
  });

  // ── Controls ─────────────────────────────────────────────────────────────
  const startTranscription = () => {
    vad.start();
    setStatus('waiting for speech...');
  };

  const stopTranscription = () => {
    vad.pause();
    clearTimeout(sentenceTimerRef.current);
    sealTrailingSegment();
    setStatus('idle');
  };

  // ── Socket events ─────────────────────────────────────────────────────────
  useEffect(() => {
    /**
     * transcription_result — a new text chunk from Whisper.
     *
     * The segmentId echoed back by the server may be stale if
     * processSentenceBoundaries already sealed that sub-row by the time
     * this response arrives.  In that case we re-route to the current
     * trailing sub-row (creating one if needed) rather than discarding.
     */
    const onTranscript = ({ transcript, segmentId }) => {
      const seg = segmentsRef.current.find(s => s.id === segmentId);
      const isCurrentTrailing =
        seg?.status === 'pending' && segmentId === trailingSegmentIdRef.current;

      let targetId = segmentId;

      if (!isCurrentTrailing) {
        // The segment is sealed or unknown — route to the current trailing.
        if (!trailingSegmentIdRef.current) {
          const sessionId = activeSessionIdRef.current;
          if (!sessionId) return; // session fully over; discard safely

          const newId = `seg-${Date.now()}-ov`;
          trailingSegmentIdRef.current = newId;

          setSegments(prev => [
            ...prev,
            {
              id: newId,
              sessionId,
              transcript: '',
              translation: '',
              time: getTimestamp(),
              status: 'pending',
              isFirstInSession: false,
            },
          ]);
        }
        targetId = trailingSegmentIdRef.current;
      }

      // Append chunk to accumulated text.
      const newAccumulated = accumulatedTextRef.current
        ? `${accumulatedTextRef.current} ${transcript}`.trim()
        : transcript;
      accumulatedTextRef.current = newAccumulated;

      // Show the updated text in the trailing sub-row (dimmed).
      setSegments(prev =>
        prev.map(s => s.id === targetId ? { ...s, transcript: newAccumulated } : s)
      );

      // Check if any complete sentences have appeared.
      processSentenceBoundaries(targetId);

      setStatus('listening...');
    };

    /**
     * translation_result — bring a sub-row to full opacity.
     */
    const onTranslation = ({ translation, segmentId }) => {
      setSegments(prev =>
        prev.map(s => s.id === segmentId ? { ...s, translation, status: 'done' } : s)
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
// Renders one sub-row in either panel.
//
// isFirstInSession → timestamp is visible; all continuation rows reserve the
// same space but hide it, keeping text alignment consistent across the panel.

function SegmentRow({ segment, field }) {
  const { status, time, isFirstInSession } = segment;
  const text = segment[field];

  const isDone        = status === 'done';
  const isTranslating = status === 'translating';

  // Right panel: show nothing while waiting for translation.
  const displayText = field === 'translation' && !isDone ? '' : text;

  return (
    <div className="segment" style={{ position: 'relative' }}>
      {/* Always rendered for layout; hidden on continuation rows. */}
      <span
        className="seg-time"
        style={{ visibility: isFirstInSession ? 'visible' : 'hidden' }}
      >
        {time}
      </span>

      <p style={{
        opacity:    isDone ? 1 : 0.35,
        transition: 'opacity 0.4s ease',
        margin:     0,
      }}>
        {displayText}

        {/* Blinking cursor on the trailing sub-row */}
        {field === 'transcript' && !isDone && (
          <span style={cursorStyle} aria-hidden="true" />
        )}
      </p>

      {/* Spinning dot on right panel while translation is in-flight */}
      {field === 'translation' && isTranslating && (
        <span style={spinnerStyle} aria-label="translating…" />
      )}
    </div>
  );
}

// ── Inline styles ─────────────────────────────────────────────────────────────

const cursorStyle = {
  display:       'inline-block',
  width:         '2px',
  height:        '1em',
  background:    'currentColor',
  marginLeft:    '3px',
  verticalAlign: 'text-bottom',
  animation:     'transcend-blink 1s step-end infinite',
};

const spinnerStyle = {
  display:       'inline-block',
  width:         '8px',
  height:        '8px',
  borderRadius:  '50%',
  background:    'currentColor',
  opacity:       0.5,
  animation:     'transcend-pulse 1s ease-in-out infinite',
  marginLeft:    '6px',
  verticalAlign: 'middle',
};

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
