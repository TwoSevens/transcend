import { LANGUAGES } from './languages';

export default function Home({ onStart }) {
  return (
    <div className="home">
      <header className="home-nav">
        <div className="logo">
          <div className="logo-mark">
            <svg viewBox="0 0 16 16" fill="none"><path d="M3 8 Q8 2 13 8 Q8 14 3 8Z" fill="white"/></svg>
          </div>
          <span className="logo-name">TRAN<span>SCEND</span></span>
        </div>
        <button className="btn btn-start home-cta" onClick={onStart}>Launch app →</button>
      </header>

      <section className="hero">
        <div className="hero-eyebrow">live transcription · multilingual</div>
        <h1 className="hero-title">
          Speak once.<br />
          <span className="hero-accent">Read everywhere.</span>
        </h1>
        <p className="hero-sub">
          Transcend turns spoken audio into near-real-time subtitles, then
          translates them on the fly. Whisper handles the listening; DeepL
          handles the language.
        </p>
        <div className="hero-actions">
          <button className="btn btn-start hero-btn" onClick={onStart}>
            Start transcribing
          </button>
          <a
            className="btn btn-clear hero-btn"
            href="https://github.com/twosevens/transcend"
            target="_blank"
            rel="noreferrer"
          >
            View source
          </a>
        </div>

        <div className="lang-chips" aria-label="supported languages">
          {LANGUAGES.map(l => (
            <span key={l.code} className="lang-chip">{l.code}</span>
          ))}
        </div>
      </section>

      <section className="features">
        <div className="feature">
          <div className="feature-num">01</div>
          <h3>Capture</h3>
          <p>The browser segments your microphone into 3-second chunks and streams them over WebSockets.</p>
        </div>
        <div className="feature">
          <div className="feature-num">02</div>
          <h3>Transcribe</h3>
          <p>Each chunk goes to Whisper via the Hugging Face Inference API for fast, accurate speech-to-text.</p>
        </div>
        <div className="feature">
          <div className="feature-num">03</div>
          <h3>Translate</h3>
          <p>Transcripts are translated to your chosen language with DeepL and rendered side-by-side instantly.</p>
        </div>
      </section>

      <footer className="home-foot">
        <span>Built with React · Socket.io · Hugging Face · DeepL</span>
      </footer>
    </div>
  );
}
