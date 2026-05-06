import React, { useEffect, useRef, useState } from 'react';
import '../styles/Pages.css';

export function Voice() {
  const [text, setText] = useState('');
  const [voice, setVoice] = useState('Chelsie');
  const [isGenerating, setIsGenerating] = useState(false);
  const [message, setMessage] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  // Bumped whenever a new synthesis completes — used as a React `key` on the
  // <audio> element so the browser creates a fresh element and actually picks
  // up the new blob URL (HTML <audio> does not auto-reload on src changes).
  const [audioVersion, setAudioVersion] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Auto-play when a new synthesis arrives + free the previous blob URL.
  useEffect(() => {
    if (!audioUrl) return;
    const a = audioRef.current;
    if (a) {
      a.load();
      a.play().catch(() => { /* user-gesture policy or codec issue — silent */ });
    }
    // Revoke the previous blob URL when this one is replaced.
    return () => { try { URL.revokeObjectURL(audioUrl); } catch { /* ignore */ } };
  }, [audioUrl, audioVersion]);

  const voices = [
    { id: 'Chelsie', name: 'Chelsie', description: 'Female, warm and clear' },
    { id: 'Ethan', name: 'Ethan', description: 'Male, calm and professional' },
    { id: 'Aria', name: 'Aria', description: 'Female, friendly and expressive' },
    { id: 'Davis', name: 'Davis', description: 'Male, authoritative narrator' },
  ];

  const handleSynthesize = async () => {
    if (!text.trim()) {
      setMessage('Please enter text to synthesize');
      return;
    }

    setIsGenerating(true);
    setMessage('');
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voiceId: voice }),
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        setAudioVersion((v) => v + 1);
        // Surface which voice actually spoke — the server returns this header.
        const servedVoice = res.headers.get('X-AgentX-TTS-Voice') ?? voice;
        setMessage(`Audio generated (${servedVoice})`);
      } else {
        const error = await res.json();
        setMessage(`Error: ${error.error || 'Failed to generate audio'}`);
      }
    } catch (err) {
      setMessage('Failed to synthesize speech');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Voice</h1>
        <p>Text-to-speech synthesis</p>
      </div>

      <div style={{ maxWidth: '600px', margin: '0 auto' }}>
        <div className="content-card" style={{ marginBottom: 'var(--spacing-lg)' }}>
          <div className="content-card-title">Text-to-Speech</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
            <div>
              <label style={{ display: 'block', marginBottom: 'var(--spacing-sm)', color: 'var(--text-secondary)', fontWeight: 'bold', fontSize: 'var(--text-sm)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Select Voice
              </label>
              <select
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                style={{
                  width: '100%',
                  padding: 'var(--spacing-md)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-color)',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  fontFamily: 'inherit',
                  fontSize: 'var(--text-md)',
                }}
              >
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} - {v.description}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 'var(--spacing-sm)', color: 'var(--text-secondary)', fontWeight: 'bold', fontSize: 'var(--text-sm)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Text to Synthesize
              </label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Enter text to convert to speech..."
                style={{
                  width: '100%',
                  minHeight: '120px',
                  padding: 'var(--spacing-md)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-color)',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  fontFamily: 'inherit',
                  fontSize: 'var(--text-md)',
                  resize: 'vertical',
                }}
              />
            </div>

            <button
              onClick={handleSynthesize}
              disabled={isGenerating || !text.trim()}
              style={{
                background: 'var(--color-primary)',
                color: 'white',
                border: 'none',
                padding: '10px 20px',
                borderRadius: 'var(--radius-md)',
                cursor: isGenerating ? 'not-allowed' : 'pointer',
                fontWeight: '600',
                opacity: isGenerating || !text.trim() ? 0.6 : 1,
              }}
            >
              {isGenerating ? 'Generating...' : 'Synthesize Speech'}
            </button>

            {message && (
              <div
                style={{
                  padding: 'var(--spacing-md)',
                  borderRadius: 'var(--radius-md)',
                  background: message.toLowerCase().startsWith('audio generated') ? '#10b98122' : '#f8544422',
                  color: message.toLowerCase().startsWith('audio generated') ? '#10b981' : '#f85444',
                  fontSize: 'var(--text-sm)',
                }}
              >
                {message}
              </div>
            )}

            {audioUrl && (
              <div>
                <label style={{ display: 'block', marginBottom: 'var(--spacing-sm)', color: 'var(--text-secondary)', fontWeight: 'bold', fontSize: 'var(--text-sm)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Generated Audio
                </label>
                {/*
                 * key={audioVersion} forces React to unmount and remount the
                 * <audio> element each synthesis, guaranteeing the browser
                 * picks up the new blob URL. autoPlay + the useEffect fallback
                 * handle the "play immediately on generation" behaviour.
                 */}
                <audio
                  key={audioVersion}
                  ref={audioRef}
                  controls
                  autoPlay
                  src={audioUrl}
                  style={{ width: '100%', marginTop: 'var(--spacing-sm)' }}
                >
                  Your browser does not support the audio element.
                </audio>
              </div>
            )}
          </div>
        </div>

        <div className="content-card">
          <div className="content-card-title">About Voice</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            <p>This module provides text-to-speech synthesis capabilities powered by Qwen3 TTS.</p>
            <p>Enter any text above and click "Synthesize Speech" to generate audio from the text.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
