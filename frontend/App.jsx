import { useState, Component } from 'react';
import Home from './Home.jsx';
import Transcribe from './Transcribe.jsx';
import './App.css';

class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('App crashed:', error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="error-fallback">
          <h2>Something went wrong.</h2>
          <pre>{String(this.state.error?.message || this.state.error)}</pre>
          <button className="btn btn-start" onClick={this.reset}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [view, setView] = useState('home');

  return (
    <ErrorBoundary>
      {view === 'home'
        ? <Home onStart={() => setView('transcribe')} />
        : <Transcribe onBack={() => setView('home')} />}
    </ErrorBoundary>
  );
}
