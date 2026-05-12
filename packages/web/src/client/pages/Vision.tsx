import React, { useState, useEffect, useCallback } from 'react';
import '../styles/Pages.css';

interface AnalysisResult {
  text: string;
  imageUrl?: string;
  filename?: string;
  success?: boolean;
  confidence?: number;
  durationMs?: number;
  ocrText?: string;
}

interface PipelineStatus {
  overall: string;
  modalities: Array<{
    modality: string;
    status: string;
    provider?: string;
  }>;
  implemented: boolean;
  error?: string;
}

// Session-persisted image entry (base64 preview survives navigation)
interface PersistedImage {
  name: string;
  type: string;
  size: number;
  preview: string;       // base64 data URL
  dataBase64: string;    // raw base64 (for re-upload to backend)
}

const SESSION_KEY_IMAGES = 'agentx_vision_images';
const SESSION_KEY_RESULTS = 'agentx_vision_results';

function loadPersistedImages(): PersistedImage[] {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY_IMAGES);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function savePersistedImages(images: PersistedImage[]): void {
  try {
    sessionStorage.setItem(SESSION_KEY_IMAGES, JSON.stringify(images));
  } catch { /* quota exceeded — degrade gracefully */ }
}

function loadPersistedResults(): AnalysisResult[] {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY_RESULTS);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function savePersistedResults(results: AnalysisResult[]): void {
  try {
    sessionStorage.setItem(SESSION_KEY_RESULTS, JSON.stringify(results));
  } catch { /* quota exceeded */ }
}

export function Vision() {
  const [images, setImages] = useState<PersistedImage[]>(() => loadPersistedImages());
  const [analysisResults, setAnalysisResults] = useState<AnalysisResult[]>(() => loadPersistedResults());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // Persist images whenever they change
  useEffect(() => { savePersistedImages(images); }, [images]);
  useEffect(() => { savePersistedResults(analysisResults); }, [analysisResults]);

  // Fetch pipeline status on mount
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/multimodal/status');
        const data = await res.json();
        setPipelineStatus(data);
      } catch {
        // Pipeline status unavailable — degrade gracefully
      } finally {
        setStatusLoading(false);
      }
    };
    fetchStatus();
  }, []);

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.currentTarget.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) {
        setError(`${file.name} is not an image file`);
        continue;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        // Extract raw base64 from data URL
        const base64 = dataUrl.split(',')[1] || '';
        const entry: PersistedImage = {
          name: file.name,
          type: file.type,
          size: file.size,
          preview: dataUrl,
          dataBase64: base64,
        };
        setImages((prev) => [...prev, entry]);
      };
      reader.readAsDataURL(file);
    }
    // Reset the input so the same file can be re-selected
    event.currentTarget.value = '';
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAll = useCallback(() => {
    setImages([]);
    setAnalysisResults([]);
    setError(null);
    sessionStorage.removeItem(SESSION_KEY_IMAGES);
    sessionStorage.removeItem(SESSION_KEY_RESULTS);
  }, []);

  const analyzeImages = async () => {
    if (images.length === 0) {
      setError('Please select at least one image');
      return;
    }

    setLoading(true);
    setError(null);
    setAnalysisResults([]);

    try {
      // Reconstruct FormData from persisted base64
      const formData = new FormData();
      for (const img of images) {
        const byteString = atob(img.dataBase64);
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteString.length; i++) {
          ia[i] = byteString.charCodeAt(i);
        }
        const blob = new Blob([ab], { type: img.type });
        formData.append('file', blob, img.name);
      }

      const response = await fetch('/api/vision/analyze', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || `Analysis failed: ${response.statusText}`);
      }

      // Map results to display format
      const newResults: AnalysisResult[] = [];
      for (let i = 0; i < data.results.length; i++) {
        const result = data.results[i];
        newResults.push({
          text: result.analysis || 'No analysis available',
          imageUrl: images[i]?.preview,
          filename: result.filename,
          success: result.success,
          confidence: result.confidence,
          durationMs: result.durationMs,
          ocrText: result.ocrText,
        });
      }

      setAnalysisResults(newResults);

      if (data.successCount === 0 && data.totalAnalyzed > 0) {
        setError('Analysis completed but no text could be extracted. Ensure the image contains readable text.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Analysis failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  // Determine capability levels
  const imageModality = pipelineStatus?.modalities?.find(m => m.modality === 'image');
  const imageAvailable = imageModality?.status === 'available';
  const isOCROnly = imageAvailable && imageModality?.provider?.toLowerCase().includes('ocr only');
  const hasVisionModel = imageAvailable && !isOCROnly;

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Vision</h1>
        <p>Image analysis and OCR text extraction</p>
      </div>

      <div style={{ maxWidth: '900px', margin: '0 auto', padding: 'var(--spacing-lg)' }}>
        {/* Pipeline Status */}
        {!statusLoading && pipelineStatus && (
          <div
            className="content-card"
            style={{ marginBottom: 'var(--spacing-lg)', padding: 'var(--spacing-md)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)' }}>
              <span style={{ fontWeight: 'bold', fontSize: 'var(--text-sm)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-secondary)' }}>
                Multimodal Pipeline
              </span>
              <span style={{
                padding: '2px 8px',
                borderRadius: 'var(--radius-md)',
                fontSize: 'var(--text-xs)',
                fontWeight: 'bold',
                background: pipelineStatus.overall === 'full' ? '#1b3a2d' : pipelineStatus.overall === 'partial' ? '#3a351b' : '#3a1b1b',
                color: pipelineStatus.overall === 'full' ? '#3fb950' : pipelineStatus.overall === 'partial' ? '#d29922' : '#f85149',
              }}>
                {(pipelineStatus.overall ?? 'unavailable').toUpperCase()}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 'var(--spacing-md)', flexWrap: 'wrap' }}>
              {(pipelineStatus.modalities ?? []).map(m => (
                <div
                  key={m.modality}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--spacing-sm)',
                    fontSize: 'var(--text-sm)',
                  }}
                >
                  <div style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: m.status === 'available' ? '#3fb950' : '#484f58',
                  }} />
                  <span style={{ color: m.status === 'available' ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
                    {m.modality}
                  </span>
                  {m.provider && (
                    <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>
                      ({m.provider})
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Upload Section */}
        <div
          style={{
            border: '2px dashed var(--color-primary)',
            borderRadius: 'var(--radius-lg)',
            padding: 'var(--spacing-xl)',
            marginBottom: 'var(--spacing-lg)',
            textAlign: 'center',
            background: 'rgba(0, 217, 255, 0.05)',
          }}
        >
          <label style={{ cursor: 'pointer', display: 'block' }}>
            <input
              type="file"
              multiple
              accept="image/*"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
            <div style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--spacing-sm)' }}>
              Click to upload images
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              or drag and drop
            </div>
          </label>
        </div>

        {/* OCR-Only Info Banner (not an error — just informational) */}
        {!statusLoading && pipelineStatus && isOCROnly && (
          <div
            style={{
              padding: 'var(--spacing-md)',
              background: '#1b3a2d22',
              border: '1px solid #3fb950',
              borderRadius: 'var(--radius-md)',
              color: '#3fb950',
              marginBottom: 'var(--spacing-lg)',
              fontSize: 'var(--text-sm)',
            }}
          >
            OCR text extraction is available. Vision model (qwen3-vl) is not running — image understanding will use OCR only. You can still extract text from images and documents.
          </div>
        )}

        {/* No image capability at all */}
        {!statusLoading && pipelineStatus && !imageAvailable && (
          <div
            style={{
              padding: 'var(--spacing-md)',
              background: '#f8544422',
              border: '1px solid #f85444',
              borderRadius: 'var(--radius-md)',
              color: '#f85444',
              marginBottom: 'var(--spacing-lg)',
              fontSize: 'var(--text-sm)',
            }}
          >
            No image processing is available. OCR (tesseract.js) could not be loaded and no vision model is running. Image analysis will not work.
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div
            style={{
              padding: 'var(--spacing-md)',
              background: '#f8544422',
              border: '1px solid #f85444',
              borderRadius: 'var(--radius-md)',
              color: '#f85444',
              marginBottom: 'var(--spacing-lg)',
            }}
          >
            {error}
          </div>
        )}

        {/* Image Previews */}
        {images.length > 0 && (
          <div style={{ marginBottom: 'var(--spacing-lg)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-md)' }}>
              <h3>Selected Images ({images.length})</h3>
              <button
                onClick={clearAll}
                style={{
                  padding: '4px 12px',
                  background: 'transparent',
                  color: 'var(--text-tertiary)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  fontSize: 'var(--text-xs)',
                }}
              >
                Clear All
              </button>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: 'var(--spacing-md)',
                marginBottom: 'var(--spacing-lg)',
              }}
            >
              {images.map((img, idx) => (
                <div
                  key={`${img.name}-${idx}`}
                  style={{
                    position: 'relative',
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden',
                    border: '1px solid var(--border-primary)',
                  }}
                >
                  <img
                    src={img.preview}
                    alt={`Preview ${idx}`}
                    style={{ width: '100%', height: '150px', objectFit: 'cover' }}
                  />
                  <button
                    onClick={() => removeImage(idx)}
                    style={{
                      position: 'absolute',
                      top: '4px',
                      right: '4px',
                      background: 'rgba(0, 0, 0, 0.7)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '4px',
                      width: '24px',
                      height: '24px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '14px',
                    }}
                  >
                    x
                  </button>
                  <div
                    style={{
                      fontSize: 'var(--text-xs)',
                      padding: 'var(--spacing-sm)',
                      background: 'var(--bg-secondary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {img.name}
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={analyzeImages}
              disabled={loading || (!imageAvailable && !statusLoading)}
              style={{
                padding: 'var(--spacing-md) var(--spacing-lg)',
                background: 'var(--color-primary)',
                color: '#000',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                fontWeight: '600',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading || (!imageAvailable && !statusLoading) ? 0.5 : 1,
                width: '100%',
              }}
            >
              {loading ? 'Analyzing...' : hasVisionModel ? 'Analyze Images (Vision + OCR)' : 'Extract Text (OCR)'}
            </button>
          </div>
        )}

        {/* Analysis Results */}
        {analysisResults.length > 0 && (
          <div style={{ marginTop: 'var(--spacing-lg)' }}>
            <h3 style={{ marginBottom: 'var(--spacing-md)' }}>Analysis Results</h3>
            {analysisResults.map((result, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  gap: 'var(--spacing-lg)',
                  marginBottom: 'var(--spacing-lg)',
                  padding: 'var(--spacing-lg)',
                  background: 'var(--bg-secondary)',
                  borderRadius: 'var(--radius-md)',
                  border: `1px solid ${result.success ? 'var(--border-primary)' : '#f8544444'}`,
                }}
              >
                {result.imageUrl && (
                  <img
                    src={result.imageUrl}
                    alt={`Result ${idx}`}
                    style={{
                      width: '200px',
                      height: '200px',
                      objectFit: 'cover',
                      borderRadius: 'var(--radius-md)',
                      flexShrink: 0,
                    }}
                  />
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)' }}>
                    <h4 style={{ color: 'var(--color-primary)' }}>
                      {result.filename || `Image ${idx + 1}`}
                    </h4>
                    <div style={{ display: 'flex', gap: 'var(--spacing-sm)', fontSize: 'var(--text-xs)' }}>
                      {result.confidence !== undefined && result.confidence > 0 && (
                        <span style={{ color: 'var(--text-tertiary)' }}>
                          {Math.round(result.confidence * 100)}% confidence
                        </span>
                      )}
                      {result.durationMs !== undefined && result.durationMs > 0 && (
                        <span style={{ color: 'var(--text-tertiary)' }}>
                          {result.durationMs}ms
                        </span>
                      )}
                      <span style={{
                        padding: '1px 6px',
                        borderRadius: 'var(--radius-sm)',
                        background: result.success ? '#1b3a2d' : '#3a1b1b',
                        color: result.success ? '#3fb950' : '#f85149',
                      }}>
                        {result.success ? 'OK' : 'Failed'}
                      </span>
                    </div>
                  </div>
                  <p style={{ whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>{result.text}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
