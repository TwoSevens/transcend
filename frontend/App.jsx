import { useState } from 'react';
import Home from './Home.jsx';
import Transcribe from './Transcribe.jsx';
import './App.css';

export default function App() {
  const [view, setView] = useState('home');

  if (view === 'home') {
    return <Home onStart={() => setView('transcribe')} />;
  }
  return <Transcribe onBack={() => setView('home')} />;
}
