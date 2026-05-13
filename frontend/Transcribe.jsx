import { useState, useEffect, useRef, memo } from 'react';
import { useMicVAD, utils } from '@ricky0123/vad-react';
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

// Soft cap on rendered segments so a long session doesn't grind to a halt.
// Older rows fall off the top once exceeded.
const MAX_SEGMENTS = 500;

// Words that, when immediately preceding a period, almost certainly do NOT
// end a sentence. Lowercased.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'sr', 'jr',
  'mt', 'rev', 'fr', 'gen', 'col', 'sgt', 'pres', 'capt', 'lt',
  'inc', 'ltd', 'co', 'corp',
  'vs', 'etc', 'eg', 'ie', 'al',
  'am', 'pm', 'no',
]);

/**
 * Split accumulated text into complete sentences and a trailing fragment.
 *
 *   "Hello world. How are you doing"
 *     → { sentences: ["Hello world."], remaining: "How are you doing" }
 *
 *   "Dr. Smith arrived. Then he left"
 *     → { sentences: ["Dr. Smith arrived."], remaining: "Then he left" }
 *
 * The regex-based version split on every '.', '!', '?', which broke on
 * abbreviations like "Dr.", "U.S.", "p.m.". This pass walks the string and
 * skips terminators that are either single-letter (initial) or in the
 * abbreviation list, and only seals at a terminator followed by EOF or
 * whitespace + capital/digit.
 */
function extractSentences(text) {
  const sentences = [];
  let start = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') {
      i++;
      continue;
    }

    // Consume trailing close-quotes / brackets that belong to this sentence.
    let end = i + 1;
    while (end < text.length && /['")\]]/.test(text[end])) end++;

    // Abbreviation / initial guard — only relevant for '.'.
    if (ch === '.') {
      const wordStart = Math.max(start, text.lastIndexOf(' ', i - 1) + 1);
      const word = text.slice(wordStart, i).toLowerCase();
      if (word.length === 1 || ABBREVIATIONS.has(word)) {
        i = end;
        continue;
      }
    }

    // Require end-of-string OR whitespace followed by a capital letter / digit.
    const rest = text.slice(end);
    if (rest === '' || /^\s+[A-Z0-9]/.test(rest)) {
      const s = text.slice(start, end).trim();
      if (s) sentences.push(s);
      start = end;
      i = end;
    } else {
      i = end;
    }
  }

  return { sentences, remaining: text.slice(start).trim() };
}

/**
 * Segment status lifecycle:
 *
 *   'pending'     — transcript arriving, no translation yet (shown dimmed)
 *   'translating' — sentence boundary detected or seal timer fired;
 *                   translation request in-flight (shown dimmed + spinner)
 *   'done'        — translation arrived (full opacity, right panel populated)
 *   'failed'      — translation request errored (red, no spinner)
 *
 * Segment shape:
 *   { id, sessionId, transcript, translation, time, status, isFirstInSession }
 *
 * One "session" = one continuous VAD speech period → one timestamp group.
 * Within a session, each completed sentence becomes its own sub-row.
 * The timestamp is shown only on the first sub-row of each session.
 */

export default function Transcribe({ onBack }) {
  const [segments, setSegments] = useState([]);
  const [status, setStatus]     = useState('idle');
  const [connected, setConnected] = useState(socket.connected);
  const [banner, setBanner]     = useState(null); // transient error string

  const targetLangRef = useRef('AR');

  // ── Panel scroll refs ─────────────────────────────────────────────────────
  const transcriptPanelRef  = useRef(null);
  const translationPanelRef = useRef(null);

  // ── Session / segment tracking ────────────────────────────────────────────
  const activeSessionIdRef   = useRef(null); // current VAD session (timestamp group)
  const trailingSegmentIdRef = useRef(null); // the accumulating sub-row
  const accumulatedTextRef   = useRef('');   // full text in the trailing sub-row

  const segmentsRef      = useRef([]);
  const sentenceTimerRef = useRef(null);
  const bannerTimerRef   = useRef(null);

  // Keep segmentsRef in sync so event callbacks always see fresh data.
  useEffect(() => { segmentsRef.current = segments; }, [segments]);

  // ── Auto-scroll both panels to the bottom on every segments update ────────
  useEffect(() => {
    if (transcriptPanelRef.current) {
      transcriptPanelRef.current.scrollTop = transcriptPanelRef.current.scrollHeight;
    }
    if (translationPanelRef.current) {
      translationPanelRef.current.scrollTop = translationPanelRef.current.scrollHeight;
    }
  }, [segments]);

  // ── Append a segment list update with soft cap enforcement ───────────────
  const updateSegments = (updater) => {
    setSegments((prev) => {
      const next = updater(prev);
      if (next.length > MAX_SEGMENTS) {
        return next.slice(next.length - MAX_SEGMENTS);
      }
      return next;
    });
  };

  // ── Transient banner ──────────────────────────────────────────────────────
  const flashBanner = (text, ms = 4000) => {
    setBanner(text);
    clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = setTimeout(() => setBanner(null), ms);
  };

  // ── Emit helper that warns when the socket is offline ────────────────────
  const safeEmit = (event, payload) => {
    if (!socket.connected) {
      flashBanner('Disconnected — chunk dropped');
      return false;
    }
    socket.emit(event, payload);
    return true;
  };

  // ── Seal trailing segment (silence timeout or explicit stop) ─────────────
  const sealTrailingSegment = () => {
    const segmentId = trailingSegmentIdRef.current;

    if (segmentId) {
      const seg = segmentsRef.current.find((s) => s.id === segmentId);
      if (seg && seg.transcript && seg.status !== 'done') {
        updateSegments((prev) =>
          prev.map((s) => (s.id === segmentId ? { ...s, status: 'translating' } : s)),
        );
        safeEmit('finalize_segment', {
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
   *   - The leftover fragment (if any) becomes the new trailing sub-row
   */
  const processSentenceBoundaries = (trailingId) => {
    const { sentences, remaining } = extractSentences(accumulatedTextRef.current);
    if (sentences.length === 0) return;

    const sessionId = activeSessionIdRef.current;
    const now       = Date.now();

    // Pre-generate all IDs before any state mutation so both updateSegments
    // and the emit loop reference exactly the same values.
    const completedIds  = sentences.map((_, i) => (i === 0 ? trailingId : `seg-${now}-c${i}`));
    const newTrailingId = remaining ? `seg-${now}-trail` : null;

    // Update refs synchronously — must happen before updateSegments so any
    // incoming transcription_result routes to the correct target.
    accumulatedTextRef.current   = remaining;
    trailingSegmentIdRef.current = newTrailingId;

    updateSegments((prev) => {
      const idx = prev.findIndex((s) => s.id === trailingId);
      if (idx === -1) return prev;

      const origin = prev[idx]; // the trailing sub-row being split

      const completedSegs = sentences.map((text, i) => ({
        ...origin,
        id: completedIds[i],
        transcript: text,
        translation: '',
        status: 'translating',
        isFirstInSession: i === 0 ? origin.isFirstInSession : false,
      }));

      const insertions = [...completedSegs];

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

    completedIds.forEach((segId, i) => {
      safeEmit('finalize_segment', {
        segmentId: segId,
        fullTranscript: sentences[i],
        targetLang: targetLangRef.current,
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

      updateSegments((prev) => [
        ...prev,
        {
          id: newId,
          sessionId,
          transcript: '',
          translation: '',
          time: getTimestamp(),
          status: 'pending',
          isFirstInSession: !prev.some((s) => s.sessionId === sessionId),
        },
      ]);
    }

    const segmentId = trailingSegmentIdRef.current;
    const prompt    = accumulatedTextRef.current.split(' ').slice(-30).join(' ');

    safeEmit('audio_chunk', {
      audio: utils.encodeWAV(audio),
      mimeType: 'audio/wav',
      targetLang: targetLangRef.current,
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
    const onConnect    = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    /**
     * transcription_result — a new text chunk from Whisper.
     *
     * The segmentId echoed back by the server may be stale if
     * processSentenceBoundaries already sealed that sub-row by the time
     * this response arrives. In that case we re-route to the current
     * trailing sub-row (creating one if needed) rather than discarding.
     */
    const onTranscript = ({ transcript, segmentId }) => {
      const seg = segmentsRef.current.find((s) => s.id === segmentId);
      const isCurrentTrailing =
        seg?.status === 'pending' && segmentId === trailingSegmentIdRef.current;

      let targetId = segmentId;

      if (!isCurrentTrailing) {
        if (!trailingSegmentIdRef.current) {
          const sessionId = activeSessionIdRef.current;
          if (!sessionId) return; // session fully over; discard safely

          const newId = `seg-${Date.now()}-ov`;
          trailingSegmentIdRef.current = newId;

          updateSegments((prev) => [
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

      const newAccumulated = accumulatedTextRef.current
        ? `${accumulatedTextRef.current} ${transcript}`.trim()
        : transcript;
      accumulatedTextRef.current = newAccumulated;

      updateSegments((prev) =>
        prev.map((s) => (s.id === targetId ? { ...s, transcript: newAccumulated } : s)),
      );

      processSentenceBoundaries(targetId);

      setStatus('listening...');
    };

    /**
     * translation_result — bring a sub-row to full opacity.
     */
    const onTranslation = ({ translation, segmentId }) => {
      updateSegments((prev) =>
        prev.map((s) => (s.id === segmentId ? { ...s, translation, status: 'done' } : s)),
      );
    };

    /**
     * transcription_error — surface error codes; non-fatal so we just reset
     * status. RATE_LIMIT and TOO_LARGE get user-visible banners.
     */
    const onTranscriptError = ({ message, code }) => {
      console.error('transcription error:', code, message);
      if (code === 'RATE_LIMIT') {
        flashBanner('Sending audio too fast — slow down.');
      } else if (code === 'TOO_LARGE') {
        flashBanner('Audio chunk too large.');
      } else if (code === 'BAD_PAYLOAD') {
        flashBanner('Audio format rejected.');
      } else {
        flashBanner('Transcription failed.');
      }
      setStatus('waiting for speech...');
    };

    /**
     * translation_error — flip the segment to 'failed' so the spinner stops.
     */
    const onTranslationError = ({ segmentId, message, code }) => {
      console.error('translation error:', code, message);
      if (code === 'BAD_TARGET_LANG') {
        flashBanner('Selected language is not supported by DeepL.');
      } else if (code === 'RATE_LIMIT') {
        flashBanner('Translating too fast — slow down.');
      }
      if (segmentId) {
        updateSegments((prev) =>
          prev.map((s) => (s.id === segmentId ? { ...s, status: 'failed' } : s)),
        );
      }
    };

    socket.on('connect',              onConnect);
    socket.on('disconnect',           onDisconnect);
    socket.on('transcription_result', onTranscript);
    socket.on('translation_result',   onTranslation);
    socket.on('transcription_error',  onTranscriptError);
    socket.on('translation_error',    onTranslationError);

    return () => {
      socket.off('connect',              onConnect);
      socket.off('disconnect',           onDisconnect);
      socket.off('transcription_result', onTranscript);
      socket.off('translation_result',   onTranslation);
      socket.off('transcription_error',  onTranscriptError);
      socket.off('translation_error',    onTranslationError);
      clearTimeout(sentenceTimerRef.current);
      clearTimeout(bannerTimerRef.current);
    };
  }, []);

  // ── Status text resolution ────────────────────────────────────────────────
  const statusText =
    !connected   ? 'Disconnected — retrying…'
  : vad.loading  ? 'Loading models…'
  : vad.errored  ? 'Error loading VAD'
  :                status;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="header">
        <button className="logo logo-btn" onClick={onBack}>
          <span className="logo-name">TRAN<span>SCEND</span></span>
        </button>

        <select
          className="lang-select"
          defaultValue={targetLangRef.current}
          onChange={(e) => { targetLangRef.current = e.target.value; }}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
      </header>

      {banner && (
        <div className="banner" role="status">{banner}</div>
      )}

      <main className="panels">
        <div className="panel">
          <div className="panel-header">Transcript</div>
          <div className="panel-scroll" ref={transcriptPanelRef}>
            {segments.map((s) => (
              <SegmentRow key={s.id} segment={s} field="transcript" />
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">Translation</div>
          <div className="panel-scroll" ref={translationPanelRef}>
            {segments.map((s) => (
              <SegmentRow key={s.id} segment={s} field="translation" />
            ))}
          </div>
        </div>
      </main>

      <footer className="footer">
        <div className="footer-left">
          <span className="status-text">{statusText}</span>

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
//
// memo'd so unrelated segment updates don't re-render every row in long
// sessions.

const SegmentRow = memo(function SegmentRow({ segment, field }) {
  const { status, time, isFirstInSession } = segment;
  const text = segment[field];

  const isDone        = status === 'done';
  const isTranslating = status === 'translating';
  const isFailed      = status === 'failed';

  // Right panel: show nothing while waiting for translation, "(failed)" on error.
  let displayText;
  if (field === 'translation') {
    if (isDone)        displayText = text;
    else if (isFailed) displayText = '(translation failed)';
    else               displayText = '';
  } else {
    displayText = text;
  }

  const opacity = isDone ? 1 : (isFailed ? 0.7 : 0.35);
  const color   = isFailed && field === 'translation' ? 'var(--red)' : undefined;

  return (
    <div className="segment" style={{ position: 'relative' }}>
      <span
        className="seg-time"
        style={{ visibility: isFirstInSession ? 'visible' : 'hidden' }}
      >
        {time}
      </span>

      <p style={{
        opacity,
        color,
        transition: 'opacity 0.4s ease',
        margin: 0,
      }}>
        {displayText}

        {/* Blinking cursor on the trailing sub-row */}
        {field === 'transcript' && !isDone && !isFailed && (
          <span className="transcend-cursor" aria-hidden="true" />
        )}
      </p>

      {/* Spinning dot on right panel while translation is in-flight */}
      {field === 'translation' && isTranslating && (
        <span className="transcend-spinner" aria-label="translating…" />
      )}
    </div>
  );
});
