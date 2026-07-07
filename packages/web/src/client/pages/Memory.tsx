import React, { useState, useEffect, useRef, useCallback } from 'react';
import '../styles/Pages.css';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MemoryItem {
  id: string;
  title: string;
  type: 'email' | 'document' | 'attachment' | 'note' | 'audio' | 'image' | 'other';
  sender?: string;
  date: string;
  preview: string;
  source: string;
  attachmentCount: number;
  wordCount: number;
}

interface MemoryDetail {
  id: string;
  title: string;
  type: string;
  sender?: string;
  date: string;
  body: string;
  source: string;
  wordCount: number;
  attachments: { filename: string; path: string; size?: number }[];
  metadata: Record<string, unknown>;
}

interface MemoryStats {
  totalBuilds: number;
  successRate: number;
  recordedBuilds: number;
  successfulPatterns: number;
  failedPatterns: number;
  enabled: boolean;
  connected: boolean;
}

interface CategorizedStats {
  total: number;
  byCategory: Record<string, number>;
  byState: Record<string, number>;
  avgStrength: number;
}

type MemoryType = '' | 'email' | 'document' | 'attachment' | 'note' | 'audio' | 'image';

// ─── Tab system ─────────────────────────────────────────────────────────────

type TabId = 'browse' | 'upload' | 'query' | 'stats';

// ─── Main Component ─────────────────────────────────────────────────────────

export function Memory() {
  const [activeTab, setActiveTab] = useState<TabId>('browse');
  const [memoryHealthy, setMemoryHealthy] = useState(false);
  const [healthChecking, setHealthChecking] = useState(true);

  // Health check with retry
  useEffect(() => {
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;

    const checkHealth = async () => {
      setHealthChecking(true);
      try {
        const res = await fetch('/api/memory/gateway/health');
        setMemoryHealthy(res.ok);
        if (!res.ok && attempts < 20) {
          attempts++;
          timer = setTimeout(checkHealth, 3000);
        }
      } catch {
        if (attempts < 20) {
          attempts++;
          timer = setTimeout(checkHealth, 3000);
        }
        setMemoryHealthy(false);
      } finally {
        setHealthChecking(false);
      }
    };

    checkHealth();
    return () => clearTimeout(timer);
  }, []);

  const tabs: { id: TabId; label: string }[] = [
    { id: 'browse', label: 'Browse Memory' },
    { id: 'upload', label: 'Upload' },
    { id: 'query', label: 'Query' },
    { id: 'stats', label: 'Statistics' },
  ];

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Memory Control Center</h1>
        <p style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              width: '10px', height: '10px', borderRadius: '50%',
              background: healthChecking ? '#f59e0b' : memoryHealthy ? '#10b981' : '#ef4444',
              display: 'inline-block',
            }}
          />
          {healthChecking ? 'Connecting...' : memoryHealthy ? 'Memory Online' : 'Memory Offline — retrying'}
        </p>
      </div>

      {/* Tab bar */}
      <div style={{
        maxWidth: '960px', margin: '0 auto', padding: '0 var(--spacing-lg)',
        display: 'flex', gap: '2px', borderBottom: '1px solid var(--border-primary)',
        marginBottom: 'var(--spacing-lg)',
      }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '10px 20px',
              background: activeTab === tab.id ? 'var(--bg-secondary)' : 'transparent',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--color-primary)' : '2px solid transparent',
              color: activeTab === tab.id ? 'var(--color-primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontWeight: activeTab === tab.id ? '600' : '400',
              fontSize: 'var(--text-sm)',
              transition: 'all 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: '960px', margin: '0 auto', padding: '0 var(--spacing-lg) var(--spacing-lg)' }}>
        {activeTab === 'browse' && <BrowseTab />}
        {activeTab === 'upload' && <UploadTab memoryHealthy={memoryHealthy} />}
        {activeTab === 'query' && <QueryTab memoryHealthy={memoryHealthy} />}
        {activeTab === 'stats' && <StatsTab />}
      </div>
    </div>
  );
}

// ─── Browse Tab (Search, Filter, Paginate, Detail View) ─────────────────────

function BrowseTab() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(15);
  const [searchText, setSearchText] = useState('');
  const [filterType, setFilterType] = useState<MemoryType>('');
  const [filterSender, setFilterSender] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selectedItem, setSelectedItem] = useState<MemoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; title: string } | null>(null);
  const [deleteText, setDeleteText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [bulkDeleteText, setBulkDeleteText] = useState('');
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (searchText) params.set('q', searchText);
      if (filterType) params.set('type', filterType);
      if (filterSender) params.set('sender', filterSender);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));

      const res = await fetch(`/api/memory/control-center?${params}`);
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      setItems(data.items ?? []);
      setTotalCount(data.totalCount ?? 0);
    } catch {
      setItems([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  }, [searchText, filterType, filterSender, dateFrom, dateTo, page, pageSize]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [searchText, filterType, filterSender, dateFrom, dateTo]);

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/memory/control-center/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error('Failed to load detail');
      const data = await res.json();
      // Normalize: API may return 'content' or 'body'
      if (!data.body && data.content) data.body = data.content;
      // Normalize attachments: API may return 'name' instead of 'filename'
      if (data.attachments) {
        data.attachments = data.attachments.map((a: any) => ({
          filename: a.filename || a.name || 'unknown',
          path: a.path || '',
          size: a.size,
        }));
      }
      setSelectedItem(data);
    } catch {
      setSelectedItem(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/memory/control-center/${encodeURIComponent(deleteConfirm.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      setDeleteConfirm(null);
      setDeleteText('');
      setSelectedItem(null);
      fetchItems();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map(i => i.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBulkDeleting(true);
    try {
      const ids = Array.from(selectedIds);
      const res = await fetch('/api/memory/control-center/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error(`Delete failed: HTTP ${res.status}`);
      setSelectedIds(new Set());
      setBulkDeleteConfirm(false);
      setBulkDeleteText('');
      fetchItems();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Bulk delete failed');
    } finally {
      setBulkDeleting(false);
    }
  };

  // Clear selection when items change (new search/page)
  useEffect(() => { setSelectedIds(new Set()); }, [items]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const typeColors: Record<string, { bg: string; fg: string }> = {
    email: { bg: '#8b5cf622', fg: '#8b5cf6' },
    document: { bg: '#3b82f622', fg: '#3b82f6' },
    attachment: { bg: '#f59e0b22', fg: '#f59e0b' },
    note: { bg: '#10b98122', fg: '#10b981' },
    audio: { bg: '#ec489922', fg: '#ec4899' },
    image: { bg: '#14b8a622', fg: '#14b8a6' },
    other: { bg: '#6b728022', fg: '#6b7280' },
  };

  return (
    <div>
      {/* Search + Filters */}
      <div style={{
        display: 'grid', gap: 'var(--spacing-sm)',
        gridTemplateColumns: '1fr auto',
        marginBottom: 'var(--spacing-md)',
      }}>
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search memory..."
          style={{
            padding: '10px 14px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: 'var(--text-sm)',
            outline: 'none',
          }}
        />
        <button
          onClick={fetchItems}
          style={{
            padding: '10px 20px',
            background: '#238636', color: '#fff', border: 'none',
            borderRadius: 'var(--radius-sm)', fontWeight: 600,
            fontSize: 'var(--text-sm)', cursor: 'pointer',
          }}
        >
          Search
        </button>
      </div>

      {/* Filter row */}
      <div style={{
        display: 'grid', gridTemplateColumns: '140px 180px 130px auto 130px auto',
        gap: '8px', marginBottom: 'var(--spacing-lg)', alignItems: 'center',
      }}>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as MemoryType)}
          style={{
            padding: '6px 10px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: '12px',
          }}
        >
          <option value="">All Types</option>
          <option value="email">Email</option>
          <option value="document">Document</option>
          <option value="attachment">Attachment</option>
          <option value="note">Note</option>
          <option value="audio">Audio</option>
          <option value="image">Image</option>
        </select>

        <input
          type="text"
          value={filterSender}
          onChange={(e) => setFilterSender(e.target.value)}
          placeholder="Filter by sender..."
          style={{
            padding: '6px 10px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: '12px',
          }}
        />

        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          style={{
            padding: '6px 10px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: '12px',
          }}
        />
        <span style={{ color: 'var(--text-secondary)', fontSize: '12px', textAlign: 'center' }}>to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          style={{
            padding: '6px 10px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: '12px',
          }}
        />

        <div>
          {(filterType || filterSender || dateFrom || dateTo) && (
            <button
              onClick={() => { setFilterType(''); setFilterSender(''); setDateFrom(''); setDateTo(''); }}
              style={{
                padding: '6px 10px',
                background: 'transparent',
                border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)',
                fontSize: '12px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Results count + selection bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)' }}>
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          {loading ? 'Loading...' : `${totalCount} item${totalCount !== 1 ? 's' : ''} found`}
          {totalPages > 1 && ` — Page ${page} of ${totalPages}`}
        </div>
        {items.length > 0 && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              onClick={selectAll}
              style={{
                padding: '4px 10px',
                background: 'transparent',
                border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-sm)',
                color: selectedIds.size === items.length && items.length > 0 ? 'var(--color-primary)' : 'var(--text-secondary)',
                fontSize: '11px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {selectedIds.size === items.length && items.length > 0 ? 'Deselect All' : 'Select All'}
            </button>
            {selectedIds.size > 0 && (
              <>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  {selectedIds.size} selected
                </span>
                <button
                  onClick={() => setBulkDeleteConfirm(true)}
                  style={{
                    padding: '4px 12px',
                    background: '#f8514922',
                    border: '1px solid #f85149',
                    borderRadius: 'var(--radius-sm)',
                    color: '#f85149',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Delete Selected
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Results list */}
      <div style={{
        background: 'var(--bg-secondary)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-primary)',
        overflow: 'hidden',
        marginBottom: 'var(--spacing-md)',
        minHeight: '200px',
      }}>
        {loading ? (
          <div style={{ padding: 'var(--spacing-xl)', textAlign: 'center', color: 'var(--text-secondary)' }}>
            Loading memory items...
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: 'var(--spacing-xl)', textAlign: 'center', color: 'var(--text-secondary)' }}>
            No memory items found. {searchText || filterType ? 'Try adjusting your filters.' : 'Ingest emails or upload documents to get started.'}
          </div>
        ) : (
          items.map((item, idx) => {
            const tc = typeColors[item.type] ?? typeColors.other;
            const isSelected = selectedIds.has(item.id);
            return (
              <div
                key={item.id}
                style={{
                  padding: '12px 16px',
                  borderBottom: idx < items.length - 1 ? '1px solid var(--border-primary)' : 'none',
                  cursor: 'pointer',
                  transition: 'background 0.1s',
                  display: 'grid',
                  gridTemplateColumns: '28px 1fr auto',
                  gap: '12px',
                  alignItems: 'center',
                  background: isSelected ? 'rgba(0, 217, 255, 0.06)' : '',
                }}
                onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--bg-tertiary)'; }}
                onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = ''; }}
              >
                {/* Checkbox */}
                <div
                  onClick={(e) => { e.stopPropagation(); toggleSelect(item.id); }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(item.id)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: '#00d9ff' }}
                  />
                </div>
                {/* Content (clickable for detail) */}
                <div style={{ minWidth: 0 }} onClick={() => openDetail(item.id)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{
                      padding: '2px 8px', borderRadius: '4px', fontSize: '10px',
                      fontWeight: '600', background: tc.bg, color: tc.fg,
                      textTransform: 'uppercase', flexShrink: 0,
                    }}>
                      {item.type}
                    </span>
                    <span style={{
                      fontWeight: '500', color: 'var(--text-primary)', fontSize: '14px',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {item.title}
                    </span>
                  </div>
                  <div style={{
                    fontSize: '12px', color: 'var(--text-secondary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {item.sender && <span style={{ color: '#8b5cf6', marginRight: '8px' }}>{item.sender}</span>}
                    {item.preview}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, fontSize: '11px', color: 'var(--text-secondary)' }} onClick={() => openDetail(item.id)}>
                  <div>{item.date ? new Date(item.date).toLocaleDateString() : ''}</div>
                  {item.attachmentCount > 0 && <div style={{ color: '#f59e0b' }}>{item.attachmentCount} file{item.attachmentCount > 1 ? 's' : ''}</div>}
                  {item.wordCount > 0 && <div>{item.wordCount.toLocaleString()} words</div>}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', alignItems: 'center' }}>
          <PagButton label="Prev" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))} />
          {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
            let pageNum: number;
            if (totalPages <= 7) {
              pageNum = i + 1;
            } else if (page <= 4) {
              pageNum = i + 1;
            } else if (page >= totalPages - 3) {
              pageNum = totalPages - 6 + i;
            } else {
              pageNum = page - 3 + i;
            }
            return (
              <PagButton
                key={pageNum}
                label={String(pageNum)}
                active={pageNum === page}
                onClick={() => setPage(pageNum)}
              />
            );
          })}
          <PagButton label="Next" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))} />
        </div>
      )}

      {/* Detail Modal */}
      {(selectedItem || detailLoading) && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            zIndex: 1000, padding: '20px',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) { setSelectedItem(null); } }}
        >
          <div style={{
            background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-primary)',
            maxWidth: '720px', width: '100%', maxHeight: '80vh', overflow: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          }}>
            {detailLoading ? (
              <div style={{ padding: 'var(--spacing-xl)', textAlign: 'center', color: 'var(--text-secondary)' }}>
                Loading...
              </div>
            ) : selectedItem ? (
              <div>
                {/* Detail header */}
                <div style={{
                  padding: '16px 20px', borderBottom: '1px solid var(--border-primary)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: '4px', fontSize: '10px',
                        fontWeight: '600',
                        background: (typeColors[selectedItem.type] ?? typeColors.other).bg,
                        color: (typeColors[selectedItem.type] ?? typeColors.other).fg,
                        textTransform: 'uppercase',
                      }}>
                        {selectedItem.type}
                      </span>
                      <span style={{ fontWeight: '600', color: 'var(--text-primary)', fontSize: '16px' }}>
                        {selectedItem.title}
                      </span>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                      {selectedItem.sender && <span>From: <strong style={{ color: '#8b5cf6' }}>{selectedItem.sender}</strong></span>}
                      <span>{selectedItem.date ? new Date(selectedItem.date).toLocaleString() : ''}</span>
                      <span>{selectedItem.source}</span>
                      {selectedItem.wordCount > 0 && <span>{selectedItem.wordCount.toLocaleString()} words</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                    <button
                      onClick={() => setDeleteConfirm({ id: selectedItem.id, title: selectedItem.title })}
                      style={{
                        padding: '6px 12px', background: 'transparent',
                        border: '1px solid #ef4444', borderRadius: 'var(--radius-sm)',
                        color: '#ef4444', cursor: 'pointer', fontSize: '12px',
                      }}
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setSelectedItem(null)}
                      style={{
                        padding: '6px 12px', background: 'var(--bg-tertiary)',
                        border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                        color: 'var(--text-primary)', cursor: 'pointer', fontSize: '12px',
                      }}
                    >
                      Close
                    </button>
                  </div>
                </div>

                {/* Attachments */}
                {selectedItem.attachments.length > 0 && (
                  <div style={{
                    padding: '12px 20px', borderBottom: '1px solid var(--border-primary)',
                    background: 'var(--bg-secondary)',
                  }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Attachments ({selectedItem.attachments.length})
                    </div>
                    {selectedItem.attachments.map((att, i) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '4px 0', fontSize: '13px',
                      }}>
                        <span style={{ color: '#f59e0b' }}>&#128206;</span>
                        <span style={{ color: 'var(--text-primary)' }}>{att.filename}</span>
                        {att.size != null && <span style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>({(att.size / 1024).toFixed(1)} KB)</span>}
                      </div>
                    ))}
                  </div>
                )}

                {/* Body content */}
                <div style={{
                  padding: '16px 20px', fontSize: '13px', lineHeight: '1.7',
                  color: 'var(--text-primary)', whiteSpace: 'pre-wrap',
                  maxHeight: '400px', overflow: 'auto',
                  fontFamily: selectedItem.type === 'email' ? 'inherit' : 'monospace',
                }}>
                  {selectedItem.body || '(No content)'}
                </div>

                {/* Metadata */}
                {Object.keys(selectedItem.metadata ?? {}).length > 0 && (
                  <div style={{
                    padding: '12px 20px', borderTop: '1px solid var(--border-primary)',
                    background: 'var(--bg-secondary)',
                  }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Metadata
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: '12px' }}>
                      {Object.entries(selectedItem.metadata ?? {}).map(([k, v]) => (
                        <React.Fragment key={k}>
                          <span style={{ color: 'var(--text-secondary)' }}>{k}:</span>
                          <span style={{ color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '11px' }}>{String(v)}</span>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Bulk Delete Confirmation Modal */}
      {bulkDeleteConfirm && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            zIndex: 1100, padding: '20px',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) { setBulkDeleteConfirm(false); setBulkDeleteText(''); } }}
        >
          <div style={{
            background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)',
            border: '1px solid #ef4444',
            maxWidth: '480px', width: '100%', padding: '24px',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          }}>
            <div style={{ fontWeight: '600', color: '#ef4444', fontSize: '16px', marginBottom: '12px' }}>
              Permanently Delete {selectedIds.size} Item{selectedIds.size !== 1 ? 's' : ''}
            </div>
            <div style={{ fontSize: '14px', color: 'var(--text-primary)', marginBottom: '12px', lineHeight: '1.5' }}>
              This will <strong style={{ color: '#ef4444' }}>permanently remove</strong> the following items from the database and disk. This cannot be undone.
            </div>
            <div style={{
              maxHeight: '150px', overflow: 'auto', marginBottom: '16px',
              padding: '8px 12px', background: 'var(--bg-secondary)',
              borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-primary)',
              fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.6',
            }}>
              {items.filter(i => selectedIds.has(i.id)).map(i => (
                <div key={i.id}>{i.title}</div>
              ))}
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
                Type <strong style={{ color: '#ef4444' }}>DELETE</strong> to confirm:
              </label>
              <input
                type="text"
                value={bulkDeleteText}
                onChange={(e) => setBulkDeleteText(e.target.value)}
                placeholder="DELETE"
                style={{
                  width: '100%', padding: '8px 12px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)', fontSize: '14px',
                  outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setBulkDeleteConfirm(false); setBulkDeleteText(''); }}
                style={{
                  padding: '8px 16px', background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)', cursor: 'pointer', fontSize: '13px',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleteText !== 'DELETE' || bulkDeleting}
                style={{
                  padding: '8px 16px',
                  background: bulkDeleteText === 'DELETE' ? '#ef4444' : '#ef444444',
                  border: 'none', borderRadius: 'var(--radius-sm)',
                  color: '#fff', cursor: bulkDeleteText === 'DELETE' ? 'pointer' : 'not-allowed',
                  fontSize: '13px', fontWeight: 600,
                  opacity: bulkDeleting ? 0.6 : 1,
                }}
              >
                {bulkDeleting ? `Deleting ${selectedIds.size} items...` : `Delete ${selectedIds.size} Item${selectedIds.size !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            zIndex: 1100, padding: '20px',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) { setDeleteConfirm(null); setDeleteText(''); } }}
        >
          <div style={{
            background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)',
            border: '1px solid #ef4444',
            maxWidth: '440px', width: '100%', padding: '24px',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          }}>
            <div style={{ fontWeight: '600', color: '#ef4444', fontSize: '16px', marginBottom: '12px' }}>
              Permanently Delete Item
            </div>
            <div style={{ fontSize: '14px', color: 'var(--text-primary)', marginBottom: '16px', lineHeight: '1.5' }}>
              This will <strong style={{ color: '#ef4444' }}>permanently remove</strong> &ldquo;{deleteConfirm.title}&rdquo; from the database and disk.
              <br />
              <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                This cannot be undone.
              </span>
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
                Type <strong style={{ color: '#ef4444' }}>DELETE</strong> to confirm:
              </label>
              <input
                type="text"
                value={deleteText}
                onChange={(e) => setDeleteText(e.target.value)}
                placeholder="DELETE"
                style={{
                  width: '100%', padding: '8px 12px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)', fontSize: '14px',
                  outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setDeleteConfirm(null); setDeleteText(''); }}
                style={{
                  padding: '8px 16px', background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)', cursor: 'pointer', fontSize: '13px',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteText !== 'DELETE' || deleting}
                style={{
                  padding: '8px 16px',
                  background: deleteText === 'DELETE' ? '#ef4444' : '#ef444444',
                  border: 'none', borderRadius: 'var(--radius-sm)',
                  color: '#fff', cursor: deleteText === 'DELETE' ? 'pointer' : 'not-allowed',
                  fontSize: '13px', fontWeight: 600,
                  opacity: deleting ? 0.6 : 1,
                }}
              >
                {deleting ? 'Deleting...' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Upload Tab ─────────────────────────────────────────────────────────────

interface UploadedFile {
  name: string;
  type: string;
  size: number;
  preview?: string;   // base64 data URL for images
  status: 'uploading' | 'success' | 'failed' | 'duplicate';
  documentId?: string;
  error?: string;
  duplicateOf?: string;
}

function UploadTab({ memoryHealthy }: { memoryHealthy: boolean }) {
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [previewFile, setPreviewFile] = useState<UploadedFile | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Book detection modal state
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [showBookModal, setShowBookModal] = useState(false);
  const [bookName, setBookName] = useState('');
  const [bookProgress, setBookProgress] = useState<string | null>(null);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);

  // Quality report after book upload
  interface PageQualityItem { page: number; filename: string; quality: 'good' | 'warning' | 'rescan'; confidence: number; words: number; issues: string[]; }
  interface QualityReport { total_pages: number; good: number; warnings: number; needs_rescan: number; overall: string; flagged_pages: PageQualityItem[]; }
  const [qualityReport, setQualityReport] = useState<{ report: QualityReport; bookName: string; documentId: string; pages: Array<{ page: number; filename: string; words: number; confidence: number; quality: string; quality_issues: string[] }> } | null>(null);

  // Expanded book detail (loaded from API on click)
  const [expandedBookId, setExpandedBookId] = useState<string | null>(null);
  const [openCollectionName, setOpenCollectionName] = useState<string | null>(null);
  const [expandedBookDetail, setExpandedBookDetail] = useState<{ report: QualityReport; bookName: string; pages: Array<{ page: number; filename: string; words: number; confidence: number; quality: string; quality_issues: string[] }> } | null>(null);
  const [bookDetailLoading, setBookDetailLoading] = useState(false);

  // Page preview + replace state
  const [previewPageInfo, setPreviewPageInfo] = useState<{ docId: string; page: number; quality: string; confidence: number; words: number; issues: string[]; filename?: string } | null>(null);
  const [replacingPage, setReplacingPage] = useState(false);
  const [replaceStatus, setReplaceStatus] = useState<string | null>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Existing books
  interface BookInfo { document_id: string; name: string; mime_type?: string; source_type?: string; page_count: number; word_count: number; avg_ocr_confidence: number | null; created_at: string; updated_at: string | null; collection: string; }
  const [existingBooks, setExistingBooks] = useState<BookInfo[]>([]);
  const [booksLoading, setBooksLoading] = useState(true);
  const [viewingImageId, setViewingImageId] = useState<string | null>(null);

  // P7-2A.5: Collection management
  const DEFAULT_COLLECTIONS = ['Medical', 'Law', 'Personal', 'Emails'];
  const [selectedCollection, setSelectedCollection] = useState('');
  const [customCollectionName, setCustomCollectionName] = useState('');
  const [editingCollectionBookId, setEditingCollectionBookId] = useState<string | null>(null);

  useEffect(() => {
    const loadBooks = async () => {
      setBooksLoading(true);
      try {
        const res = await fetch('/api/cognitive/books');
        if (res.ok) {
          const data = await res.json();
          setExistingBooks(data.books || []);
        }
      } catch { /* ok */ }
      setBooksLoading(false);
    };
    loadBooks();
  }, [uploadStatus]); // Reload after any upload

  // P7-2A.5: Collection picker modal state
  const [showCollectionPicker, setShowCollectionPicker] = useState(false);
  const [collectionPendingFiles, setCollectionPendingFiles] = useState<File[] | null>(null);

  // Detect upload type — always show collection picker first
  const detectBookUpload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const fileArr = Array.from(files);

    // Always show collection picker first
    setCollectionPendingFiles(fileArr);
    setSelectedCollection('');
    setCustomCollectionName('');
    setShowCollectionPicker(true);
  };

  // After collection is chosen, proceed with the right upload path.
  // If the user typed a new-collection name, promote it into selectedCollection
  // so the rest of the upload code path (which reads selectedCollection) picks
  // it up transparently.
  const handleCollectionChosen = () => {
    if (!collectionPendingFiles) return;

    // Resolve the final collection: typed name wins over picked button.
    const typed = customCollectionName.trim();
    if (typed) {
      setSelectedCollection(typed);
    }
    // Collection name is capped to 64 chars; anything longer is almost
    // certainly paste-by-accident and would crowd the sidebar list.
    const chosen = typed || selectedCollection;
    if (!chosen || chosen.length > 64) return;

    const fileArr = collectionPendingFiles;
    setShowCollectionPicker(false);
    setCollectionPendingFiles(null);
    setCustomCollectionName('');

    const imageFiles = fileArr.filter(f => f.type.startsWith('image/'));

    // If 2+ image files, ask if it's a scanned book
    if (imageFiles.length >= 2) {
      setPendingFiles(fileArr);
      setBookName('');
      setSelectedBookId(null);
      setShowBookModal(true);
      return;
    }

    // Otherwise, proceed with normal upload — pass `chosen` explicitly
    // because state hasn't settled yet from the setSelectedCollection above.
    handleNormalUpload(fileArr, chosen);
  };

  // Collection is mandatory for uploads — no skip allowed.
  // Emails collection is auto-assigned only (via email ingestion service).

  // Upload pages to an existing book
  const handleAddToExistingBook = async (bookDocId: string) => {
    if (!pendingFiles) return;
    const imageFiles = pendingFiles.filter(f => f.type.startsWith('image/'));
    const nonImageFiles = pendingFiles.filter(f => !f.type.startsWith('image/'));
    const book = existingBooks.find(b => b.document_id === bookDocId);

    setShowBookModal(false);
    setUploading(true);
    setUploadStatus(null);
    setBookProgress(`Adding ${imageFiles.length} pages to "${book?.name || 'book'}"...`);

    const bookEntry: UploadedFile = {
      name: `${book?.name || 'Book'} (+${imageFiles.length} pages)`,
      type: 'image/book-collection',
      size: imageFiles.reduce((s, f) => s + f.size, 0),
      status: 'uploading',
    };
    setUploadedFiles(prev => [...prev, bookEntry]);

    try {
      const formData = new FormData();
      formData.append('document_id', bookDocId);
      formData.append('book_name', book?.name || '');
      const sorted = [...imageFiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const file of sorted) {
        formData.append('files', file);
      }

      const res = await fetch('/api/cognitive/ingest-book', { method: 'POST', body: formData });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        bookEntry.status = 'success';
        bookEntry.documentId = data.document_id;
        setUploadStatus(`Added ${data.pages_added} pages to "${data.book_name}". Total: ${data.total_pages} pages, ${data.total_words} words.`);

        if (data.quality_report) {
          setQualityReport({ report: data.quality_report, bookName: data.book_name || book?.name || 'Book', documentId: data.document_id, pages: data.pages || [] });
        }
      } else {
        bookEntry.status = 'failed';
        bookEntry.error = data.error || `HTTP ${res.status}`;
        setUploadStatus(`Failed to add pages: ${bookEntry.error}`);
      }
    } catch (err) {
      bookEntry.status = 'failed';
      bookEntry.error = err instanceof Error ? err.message : 'Upload failed';
      setUploadStatus(`Failed: ${bookEntry.error}`);
    }

    setUploadedFiles(prev => prev.map(f => f.name === bookEntry.name ? { ...bookEntry } : f));
    setBookProgress(null);

    if (nonImageFiles.length > 0) await handleNormalUpload(nonImageFiles);
    setUploading(false);
    setPendingFiles(null);
  };

  // Upload as a scanned book (all pages → one document)
  const handleBookUpload = async () => {
    if (!pendingFiles || !bookName.trim()) return;
    const imageFiles = pendingFiles.filter(f => f.type.startsWith('image/'));
    const nonImageFiles = pendingFiles.filter(f => !f.type.startsWith('image/'));

    setShowBookModal(false);
    setUploading(true);
    setUploadStatus(null);
    setBookProgress(`Preparing ${imageFiles.length} pages for OCR...`);

    // Add placeholder entries for the book
    const bookEntry: UploadedFile = {
      name: `${bookName.trim()} (${imageFiles.length} pages)`,
      type: 'image/book-collection',
      size: imageFiles.reduce((s, f) => s + f.size, 0),
      status: 'uploading',
    };
    setUploadedFiles(prev => [...prev, bookEntry]);

    try {
      const formData = new FormData();
      formData.append('book_name', bookName.trim());
      if (selectedCollection) formData.append('collection', selectedCollection);

      // Sort files by name to preserve page order
      const sorted = [...imageFiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const file of sorted) {
        formData.append('files', file);
      }

      setBookProgress(`Uploading & OCR scanning ${imageFiles.length} pages... This may take a moment.`);

      const res = await fetch('/api/cognitive/ingest-book', { method: 'POST', body: formData });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        bookEntry.status = 'success';
        bookEntry.documentId = data.document_id;
        const pagesAdded = data.pages_added ?? data.pages_processed ?? imageFiles.length;
        setUploadStatus(`Book "${bookName.trim()}" uploaded: ${pagesAdded} pages, ${data.total_words} words extracted in ${(data.duration_ms / 1000).toFixed(1)}s`);

        // Show quality report if there are any issues
        if (data.quality_report) {
          setQualityReport({ report: data.quality_report, bookName: bookName.trim(), documentId: data.document_id, pages: data.pages || [] });
        }
      } else {
        bookEntry.status = 'failed';
        bookEntry.error = data.error || `HTTP ${res.status}`;
        setUploadStatus(`Book upload failed: ${bookEntry.error}`);
      }
    } catch (err) {
      bookEntry.status = 'failed';
      bookEntry.error = err instanceof Error ? err.message : 'Upload failed';
      setUploadStatus(`Book upload failed: ${bookEntry.error}`);
    }

    setUploadedFiles(prev => prev.map(f => f.name === bookEntry.name ? { ...bookEntry } : f));
    setBookProgress(null);

    // Upload any non-image files normally
    if (nonImageFiles.length > 0) {
      await handleNormalUpload(nonImageFiles);
    }

    setUploading(false);
    setPendingFiles(null);
  };

  // Skip book — upload all files individually
  const handleSkipBook = () => {
    const files = pendingFiles;
    setShowBookModal(false);
    setPendingFiles(null);
    if (files) handleNormalUpload(files);
  };

  // Normal individual file upload
  const handleNormalUpload = async (fileArr: File[], collectionOverride?: string) => {
    if (fileArr.length === 0) return;
    // selectedCollection (state) may still be stale when we're invoked
    // synchronously from handleCollectionChosen after setSelectedCollection
    // was queued. Accept an explicit override so the typed new-collection
    // name lands on the very first upload, not after the next re-render.
    const effectiveCollection = collectionOverride ?? selectedCollection;
    setUploading(true);
    setUploadStatus(null);
    let success = 0, fail = 0, dupes = 0;

    for (const file of fileArr) {
      // Create preview for images
      let preview: string | undefined;
      if (file.type.startsWith('image/')) {
        preview = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target?.result as string);
          reader.readAsDataURL(file);
        });
      }

      const entry: UploadedFile = {
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        preview,
        status: 'uploading',
      };
      setUploadedFiles(prev => [...prev, entry]);

      try {
        const formData = new FormData();
        formData.append('file', file);
        let res = await fetch('/api/cognitive/ingest', { method: 'POST', body: formData });
        if (res.status === 409) {
          const data = await res.json().catch(() => ({}));
          entry.status = 'duplicate';
          entry.duplicateOf = data.existing_file_name || 'an existing document';
          entry.documentId = data.existing_document_id;
          dupes++;
        } else if (!res.ok) {
          res = await fetch('/api/memory/upload-document', { method: 'POST', body: formData });
          if (res.ok) {
            const data = await res.json().catch(() => ({}));
            entry.status = 'success';
            entry.documentId = data.document_id;
            success++;
          } else {
            entry.status = 'failed';
            entry.error = `HTTP ${res.status}`;
            fail++;
          }
        } else {
          const data = await res.json().catch(() => ({}));
          entry.status = 'success';
          entry.documentId = data.document_id;
          success++;
        }
      } catch (err) {
        entry.status = 'failed';
        entry.error = err instanceof Error ? err.message : 'Upload failed';
        fail++;
      }

      // Assign collection if one was selected and upload succeeded
      if (entry.status === 'success' && entry.documentId && effectiveCollection) {
        try {
          await fetch(`/api/cognitive/books/${encodeURIComponent(entry.documentId)}/collection`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collection: effectiveCollection }),
          });
        } catch { /* best-effort */ }
      }

      setUploadedFiles(prev => prev.map(f => f.name === entry.name && f.size === entry.size ? { ...entry } : f));
    }

    setUploading(false);
    const parts = [];
    if (success > 0) parts.push(`${success} uploaded`);
    if (dupes > 0) parts.push(`${dupes} duplicate(s) skipped`);
    if (fail > 0) parts.push(`${fail} failed`);
    setUploadStatus(parts.join(', ') || 'No files processed');
  };

  const openPreview = async (file: UploadedFile) => {
    setPreviewFile(file);
    setPreviewContent(null);

    // Images use their base64 preview directly
    if (file.preview) return;

    // For documents, fetch content from the detail endpoint
    if (file.documentId) {
      setPreviewLoading(true);
      try {
        const res = await fetch(`/api/memory/control-center/${encodeURIComponent(file.documentId)}`);
        if (res.ok) {
          const data = await res.json();
          setPreviewContent(data.body || data.content || '(No content extracted)');
        } else {
          setPreviewContent('(Could not load document content)');
        }
      } catch {
        setPreviewContent('(Failed to fetch content)');
      } finally {
        setPreviewLoading(false);
      }
    }
  };

  const handlePageReplace = async (file: File) => {
    if (!previewPageInfo) return;
    const docId = previewPageInfo.docId;
    if (!docId) return;
    setReplacingPage(true);
    setReplaceStatus('Uploading & OCR scanning replacement page...');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/cognitive/books/${encodeURIComponent(docId)}/page/${previewPageInfo.page}/replace`, { method: 'POST', body: formData });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setReplaceStatus(`Page ${previewPageInfo.page} replaced: ${data.words} words, ${data.confidence}% confidence — ${data.quality}`);
        setPreviewPageInfo(null);
        // Refresh the book detail if viewing from expanded book card
        if (expandedBookId === docId) {
          await handleBookClick(expandedBookId, expandedBookDetail?.bookName || '');
        }
        // Refresh inline quality report if viewing from inline report
        if (qualityReport?.documentId === docId) {
          try {
            const refreshRes = await fetch(`/api/cognitive/books/${encodeURIComponent(docId)}`);
            const refreshData = await refreshRes.json().catch(() => ({}));
            if (refreshRes.ok && refreshData.quality_report) {
              setQualityReport({ report: refreshData.quality_report, bookName: qualityReport.bookName, documentId: docId, pages: refreshData.pages || [] });
            }
          } catch { /* non-fatal */ }
        }
      } else {
        setReplaceStatus(`Replace failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      setReplaceStatus(`Replace failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setReplacingPage(false);
  };

  // P7-2A.5: Update a book's collection
  const handleSetCollection = async (bookId: string, collection: string) => {
    try {
      const res = await fetch(`/api/cognitive/books/${encodeURIComponent(bookId)}/collection`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection }),
      });
      if (res.ok) {
        setExistingBooks(prev => prev.map(b =>
          b.document_id === bookId ? { ...b, collection } : b
        ));
      }
    } catch { /* ok */ }
    setEditingCollectionBookId(null);
  };

  // Get unique collections from existing books
  const getCollections = (): string[] => {
    const fromBooks = existingBooks.map(b => b.collection).filter(c => c && c !== 'Uncategorised');
    const all = [...new Set([...DEFAULT_COLLECTIONS, ...fromBooks])];
    return all.sort();
  };

  const handleBookClick = async (bookId: string, bookName: string) => {
    if (expandedBookId === bookId) {
      setExpandedBookId(null);
      setExpandedBookDetail(null);
      return;
    }
    setExpandedBookId(bookId);
    setExpandedBookDetail(null);
    setBookDetailLoading(true);
    try {
      const res = await fetch(`/api/cognitive/books/${encodeURIComponent(bookId)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.quality_report && data.pages) {
          setExpandedBookDetail({ report: data.quality_report, bookName: data.name || bookName, pages: data.pages });
        } else {
          setExpandedBookDetail({ report: { total_pages: data.page_count || 0, good: data.page_count || 0, warnings: 0, needs_rescan: 0, overall: 'excellent', flagged_pages: [] }, bookName: data.name || bookName, pages: [] });
        }
      }
    } catch { /* ok */ }
    setBookDetailLoading(false);
  };

  // Extract display page number from filename (e.g. "Page 34.jpeg" → "34", "Page 120 Some Title.jpeg" → "120")
  const getDisplayPageNum = (filename: string): string => {
    const match = filename?.match(/^Page\s+(\d+)/i);
    return match ? match[1] : '';
  };

  const clearUploaded = () => {
    setUploadedFiles([]);
    setUploadStatus(null);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div>
      {/* Collection Picker Modal — shown before any upload */}
      {showCollectionPicker && collectionPendingFiles && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 10000,
        }}>
          <div style={{
            background: 'var(--bg-primary)', border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-lg)', padding: '30px', maxWidth: '440px', width: '90%',
          }}>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--color-primary)', marginBottom: '8px' }}>
              Choose a Collection
            </div>
            <div style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '20px', lineHeight: 1.5 }}>
              Uploading <strong style={{ color: 'var(--text-primary)' }}>
                {collectionPendingFiles.length} file{collectionPendingFiles.length !== 1 ? 's' : ''}
              </strong>. Which collection should {collectionPendingFiles.length === 1 ? 'it' : 'they'} go into?
            </div>

            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
              {/* Defaults: Medical, Law, Personal. Emails is auto-assigned via email ingestion. */}
              {DEFAULT_COLLECTIONS.filter(col => col !== 'Emails').map(col => (
                <button
                  key={col}
                  onClick={() => { setSelectedCollection(selectedCollection === col ? '' : col); setCustomCollectionName(''); }}
                  style={{
                    padding: '12px 22px',
                    background: selectedCollection === col ? 'rgba(0, 224, 255, 0.15)' : 'var(--bg-secondary)',
                    border: `2px solid ${selectedCollection === col ? 'var(--color-primary)' : 'var(--border-primary)'}`,
                    borderRadius: '12px', cursor: 'pointer',
                    color: selectedCollection === col ? 'var(--color-primary)' : 'var(--text-secondary)',
                    fontSize: '15px', fontWeight: 600, transition: 'all 0.15s',
                    flex: '1 1 auto', textAlign: 'center',
                  }}
                >
                  {col === 'Medical' ? '\u{1F3E5}' : col === 'Law' ? '\u{2696}\u{FE0F}' : '\u{1F4C1}'} {col}
                </button>
              ))}
            </div>

            {/* User-created collections from previous uploads, if any */}
            {(() => {
              const userCollections = getCollections().filter(
                c => !DEFAULT_COLLECTIONS.includes(c) && c !== 'Uncategorised',
              );
              if (userCollections.length === 0) return null;
              return (
                <div style={{ marginBottom: '16px' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Your collections
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {userCollections.map(col => (
                      <button
                        key={col}
                        onClick={() => { setSelectedCollection(selectedCollection === col ? '' : col); setCustomCollectionName(''); }}
                        style={{
                          padding: '10px 16px',
                          background: selectedCollection === col ? 'rgba(0, 224, 255, 0.15)' : 'var(--bg-secondary)',
                          border: `2px solid ${selectedCollection === col ? 'var(--color-primary)' : 'var(--border-primary)'}`,
                          borderRadius: '10px', cursor: 'pointer',
                          color: selectedCollection === col ? 'var(--color-primary)' : 'var(--text-secondary)',
                          fontSize: '13px', fontWeight: 600, transition: 'all 0.15s',
                        }}
                      >
                        {'\u{1F5C2}\u{FE0F}'} {col}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Create a new collection on the fly */}
            <div style={{
              marginBottom: '24px', paddingTop: '16px',
              borderTop: '1px solid var(--border-primary)',
            }}>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Or create a new collection
              </div>
              <input
                type="text"
                value={customCollectionName}
                onChange={(e) => {
                  // Max 64 chars — anything longer is almost certainly a paste
                  // accident and would crowd the sidebar list.
                  const v = e.target.value.slice(0, 64);
                  setCustomCollectionName(v);
                  // Typing clears any picked default so the two inputs don't fight.
                  if (v.trim()) setSelectedCollection('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customCollectionName.trim()) {
                    handleCollectionChosen();
                  }
                }}
                placeholder={'e.g. Research, Cookbooks, Contracts\u2026'}
                maxLength={64}
                style={{
                  width: '100%', padding: '10px 14px',
                  background: 'var(--bg-secondary)',
                  border: `2px solid ${customCollectionName.trim() ? 'var(--color-primary)' : 'var(--border-primary)'}`,
                  borderRadius: '10px',
                  color: 'var(--text-primary)', fontSize: '14px',
                  outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setShowCollectionPicker(false);
                  setCollectionPendingFiles(null);
                  setSelectedCollection('');
                  setCustomCollectionName('');
                }}
                style={{
                  padding: '10px 20px', background: 'transparent',
                  border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              {(() => {
                const resolved = customCollectionName.trim() || selectedCollection;
                return (
                  <button
                    onClick={handleCollectionChosen}
                    disabled={!resolved}
                    style={{
                      padding: '10px 20px',
                      background: resolved ? '#238636' : 'var(--bg-tertiary)',
                      color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)',
                      fontWeight: 600, fontSize: '13px',
                      cursor: resolved ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Upload to {resolved || '...'}
                  </button>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Book Detection Modal */}
      {showBookModal && pendingFiles && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 9999,
        }}>
          <div style={{
            background: 'var(--bg-primary)', border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-lg)', padding: '30px', maxWidth: '500px', width: '90%',
          }}>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--color-primary)', marginBottom: '16px' }}>
              Scanned Book Detected
            </div>
            <div style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: 1.5 }}>
              You are uploading <strong style={{ color: 'var(--text-primary)' }}>
                {pendingFiles.filter(f => f.type.startsWith('image/')).length} images
              </strong>. Are these scanned pages from a book?
            </div>

            {/* Existing books — add to one */}
            {existingBooks.length > 0 && (
              <div style={{ marginBottom: '20px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '8px' }}>
                  Add to an existing book:
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '160px', overflowY: 'auto' }}>
                  {existingBooks.map(book => (
                    <div
                      key={book.document_id}
                      onClick={() => setSelectedBookId(selectedBookId === book.document_id ? null : book.document_id)}
                      style={{
                        padding: '10px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                        background: selectedBookId === book.document_id ? 'rgba(0, 224, 255, 0.12)' : 'var(--bg-secondary)',
                        border: `1px solid ${selectedBookId === book.document_id ? 'var(--color-primary)' : 'var(--border-primary)'}`,
                        transition: 'all 0.15s',
                      }}
                    >
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{book.name}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                        {book.page_count} pages | {book.word_count.toLocaleString()} words
                      </div>
                    </div>
                  ))}
                </div>
                {selectedBookId && (
                  <button
                    onClick={() => handleAddToExistingBook(selectedBookId)}
                    style={{
                      marginTop: '10px', width: '100%', padding: '10px',
                      background: '#1f6feb', color: '#fff', border: 'none',
                      borderRadius: 'var(--radius-sm)', fontWeight: 600, fontSize: '13px', cursor: 'pointer',
                    }}
                  >
                    Add {pendingFiles.filter(f => f.type.startsWith('image/')).length} pages to this book
                  </button>
                )}
              </div>
            )}

            {/* Divider */}
            {existingBooks.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                <div style={{ flex: 1, height: '1px', background: 'var(--border-primary)' }} />
                <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>or create a new book</span>
                <div style={{ flex: 1, height: '1px', background: 'var(--border-primary)' }} />
              </div>
            )}

            {/* New book name */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
                {existingBooks.length > 0 ? 'New Book Name' : 'Book Name'}
              </label>
              <input
                type="text"
                value={bookName}
                onChange={(e) => { setBookName(e.target.value); setSelectedBookId(null); }}
                placeholder="e.g. Employment Law Handbook 2024"
                autoFocus={existingBooks.length === 0}
                style={{
                  width: '100%', padding: '10px 14px',
                  background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
                  borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
                  fontSize: '14px', outline: 'none', boxSizing: 'border-box',
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && bookName.trim()) handleBookUpload(); }}
              />
            </div>

            {/* Collection picker */}
            <div style={{ marginBottom: '20px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
                Collection
              </label>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {getCollections().map(col => (
                  <button
                    key={col}
                    onClick={() => setSelectedCollection(selectedCollection === col ? '' : col)}
                    style={{
                      padding: '6px 14px',
                      background: selectedCollection === col ? 'rgba(0, 224, 255, 0.15)' : 'var(--bg-secondary)',
                      border: `1px solid ${selectedCollection === col ? 'var(--color-primary)' : 'var(--border-primary)'}`,
                      borderRadius: '16px', cursor: 'pointer',
                      color: selectedCollection === col ? 'var(--color-primary)' : 'var(--text-secondary)',
                      fontSize: '12px', fontWeight: 600, transition: 'all 0.15s',
                    }}
                  >
                    {col === 'Medical' ? '\u{1F3E5}' : col === 'Law' ? '\u{2696}\u{FE0F}' : col === 'Personal' ? '\u{1F4C1}' : col === 'Emails' ? '\u{1F4E7}' : '\u{1F4C2}'} {col}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={handleSkipBook}
                style={{
                  padding: '10px 20px', background: 'transparent',
                  border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer',
                }}
              >
                No, upload individually
              </button>
              <button
                onClick={handleBookUpload}
                disabled={!bookName.trim()}
                style={{
                  padding: '10px 20px',
                  background: bookName.trim() ? '#238636' : 'var(--bg-tertiary)',
                  color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)',
                  fontWeight: 600, fontSize: '13px',
                  cursor: bookName.trim() ? 'pointer' : 'not-allowed',
                }}
              >
                Create New Book
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload Drop Zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); detectBookUpload(e.dataTransfer.files); }}
        onClick={() => fileInputRef.current?.click()}
        style={{
          padding: '40px var(--spacing-xl)',
          background: dragOver ? 'rgba(0, 224, 255, 0.08)' : 'var(--bg-secondary)',
          border: `2px dashed ${dragOver ? 'var(--color-primary)' : 'var(--border-primary)'}`,
          borderRadius: 'var(--radius-md)',
          textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s',
        }}
      >
        <input
          ref={fileInputRef} type="file" multiple
          accept=".pdf,.txt,.md,.doc,.docx,.json,.jsonl,.epub,.csv,.xlsx,.xls,.html,.xml,.rtf,.wav,.mp3,.ogg,.webm,image/*"
          style={{ display: 'none' }}
          onChange={(e) => { detectBookUpload(e.target.files); if (e.target) e.target.value = ''; }}
        />
        {uploading ? (
          <div style={{ color: 'var(--color-primary)', fontSize: '16px' }}>
            {bookProgress || 'Uploading...'}
          </div>
        ) : (
          <>
            <div style={{ fontSize: '36px', marginBottom: 'var(--spacing-sm)', color: 'var(--color-primary)' }}>+</div>
            <div style={{ color: 'var(--text-primary)', fontWeight: '500', fontSize: '16px' }}>
              Drop files here or click to upload
            </div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', marginTop: '8px' }}>
              Images (JPG, PNG, GIF, WebP, TIFF), PDF, TXT, DOCX, XLSX, CSV, JSON, MD, EPUB, Audio (WAV, MP3)
            </div>
            <div style={{ color: 'var(--text-tertiary)', fontSize: '11px', marginTop: '6px' }}>
              Multiple scanned images? AgentX will ask if they are from a book
            </div>
          </>
        )}
      </div>

      {/* Your Collections Section */}
      {!booksLoading && existingBooks.length > 0 && (() => {
        // Group books by collection
        const groups: Record<string, BookInfo[]> = {};
        for (const book of existingBooks) {
          const col = book.collection || 'Uncategorised';
          if (!groups[col]) groups[col] = [];
          groups[col].push(book);
        }
        // Sort: default collections first, then alphabetical
        const collectionOrder = [...DEFAULT_COLLECTIONS, ...Object.keys(groups).filter(c => !DEFAULT_COLLECTIONS.includes(c) && c !== 'Uncategorised').sort()];
        if (groups['Uncategorised']) collectionOrder.push('Uncategorised');
        const orderedCollections = collectionOrder.filter(c => groups[c]?.length > 0);

        const collectionIcon = (col: string) => col === 'Medical' ? '\u{1F3E5}' : col === 'Law' ? '\u{2696}\u{FE0F}' : col === 'Personal' ? '\u{1F4C1}' : col === 'Emails' ? '\u{1F4E7}' : '\u{1F4C2}';

        const totalWords = (items: BookInfo[]) => items.reduce((sum, b) => sum + b.word_count, 0);

        return (
        <div style={{ marginTop: 'var(--spacing-lg)' }}>
          <div style={{
            fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)',
            textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 'var(--spacing-md)',
          }}>
            Your Collections
          </div>

          {/* Folder cards grid */}
          {!openCollectionName && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 'var(--spacing-md)',
            }}>
              {orderedCollections.map(collectionName => (
                <div
                  key={collectionName}
                  onClick={() => setOpenCollectionName(collectionName)}
                  style={{
                    padding: '20px', background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-primary)',
                    borderRadius: 'var(--radius-md)', cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.background = 'rgba(0, 224, 255, 0.05)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.background = 'var(--bg-secondary)'; }}
                >
                  <div style={{ fontSize: '40px', marginBottom: '12px' }}>{collectionIcon(collectionName)}</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
                    {collectionName}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {groups[collectionName].length} document{groups[collectionName].length !== 1 ? 's' : ''} | {totalWords(groups[collectionName]).toLocaleString()} words
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Open collection — show contents */}
          {openCollectionName && groups[openCollectionName] && (
            <div>
              {/* Back button + collection header */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '12px', marginBottom: 'var(--spacing-md)',
              }}>
                <button
                  onClick={() => { setOpenCollectionName(null); setExpandedBookId(null); }}
                  style={{
                    padding: '6px 14px', background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: '6px',
                  }}
                >
                  ← Back
                </button>
                <span style={{ fontSize: '24px' }}>{collectionIcon(openCollectionName)}</span>
                <span style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {openCollectionName}
                </span>
                <span style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>
                  ({groups[openCollectionName].length} document{groups[openCollectionName].length !== 1 ? 's' : ''})
                </span>
              </div>

              {/* Document cards inside the collection */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                gap: 'var(--spacing-md)',
              }}>
                {groups[openCollectionName].map(book => {
                  const isImage = (book.mime_type || '').startsWith('image/') || book.source_type === 'image';
                  const imageUrl = isImage ? `/api/cognitive/document/${book.document_id}/file` : null;
                  return (
                  <div
                    key={book.document_id}
                    style={{
                      padding: '14px 16px', background: expandedBookId === book.document_id ? 'rgba(0, 224, 255, 0.08)' : 'var(--bg-secondary)',
                      border: `1px solid ${expandedBookId === book.document_id ? 'var(--color-primary)' : 'var(--border-primary)'}`,
                      borderRadius: 'var(--radius-md)', transition: 'all 0.15s', position: 'relative',
                    }}
                  >
                    {isImage && imageUrl ? (
                      <>
                        <div
                          style={{ cursor: 'pointer', marginBottom: '8px' }}
                          onClick={() => setViewingImageId(book.document_id)}
                          title="Click to view full size"
                        >
                          <img
                            src={imageUrl}
                            alt={book.name}
                            style={{
                              width: '100%', height: '120px', objectFit: 'cover',
                              borderRadius: 'var(--radius-sm)', background: 'var(--bg-tertiary)',
                              border: '1px solid var(--border-primary)',
                            }}
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        </div>
                        <div style={{
                          fontSize: '12px', fontWeight: 600, color: 'var(--color-primary)',
                          marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }} title={book.name}>
                          {book.name}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                          {book.mime_type || 'image'}
                        </div>
                      </>
                    ) : (
                      <div style={{ cursor: 'pointer' }} onClick={() => handleBookClick(book.document_id, book.name)}>
                        <div style={{ fontSize: '24px', marginBottom: '8px' }}>{'\u{1F4DA}'}</div>
                        <div style={{
                          fontSize: '14px', fontWeight: 600, color: 'var(--color-primary)',
                          marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {book.name}
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {book.page_count} pages | {book.word_count.toLocaleString()} words
                        </div>
                        {book.avg_ocr_confidence != null && (
                          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                            OCR confidence: {Math.round(book.avg_ocr_confidence * 100)}%
                          </div>
                        )}
                      </div>
                    )}
                    {/* View + Delete actions for images */}
                    {isImage && (
                      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); setViewingImageId(book.document_id); }}
                          style={{
                            flex: 1, padding: '4px 8px', background: 'var(--bg-tertiary)',
                            border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                            color: 'var(--text-secondary)', fontSize: '11px', cursor: 'pointer',
                          }}
                        >
                          View
                        </button>
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!confirm(`Delete "${book.name}"? The image file will also be removed from disk.`)) return;
                            try {
                              const r = await fetch(`/api/cognitive/document/${book.document_id}`, { method: 'DELETE' });
                              if (r.ok) {
                                setExistingBooks(prev => prev.filter(b => b.document_id !== book.document_id));
                              }
                            } catch { /* non-fatal */ }
                          }}
                          style={{
                            flex: 1, padding: '4px 8px', background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 'var(--radius-sm)',
                            color: '#ef4444', fontSize: '11px', cursor: 'pointer',
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                    {/* Move to collection button */}
                    <div style={{ marginTop: '8px', borderTop: '1px solid var(--border-primary)', paddingTop: '8px' }}>
                      {editingCollectionBookId === book.document_id ? (
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                          {DEFAULT_COLLECTIONS.filter(c => c !== book.collection).map(col => (
                            <button
                              key={col}
                              onClick={(e) => { e.stopPropagation(); handleSetCollection(book.document_id, col); }}
                              style={{
                                padding: '3px 10px', background: 'var(--bg-tertiary)',
                                border: '1px solid var(--border-primary)', borderRadius: '12px',
                                color: 'var(--text-secondary)', fontSize: '11px', cursor: 'pointer',
                              }}
                            >
                              {collectionIcon(col)} {col}
                            </button>
                          ))}
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditingCollectionBookId(null); }}
                            style={{
                              padding: '3px 8px', background: 'none', border: 'none',
                              color: 'var(--text-tertiary)', fontSize: '11px', cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingCollectionBookId(book.document_id); }}
                          style={{
                            padding: '3px 10px', background: 'none',
                            border: '1px solid var(--border-primary)', borderRadius: '12px',
                            color: 'var(--text-tertiary)', fontSize: '11px', cursor: 'pointer',
                          }}
                        >
                          Move to...
                        </button>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Full-size image viewer modal */}
          {viewingImageId && (() => {
            const img = existingBooks.find(b => b.document_id === viewingImageId);
            if (!img) return null;
            return (
              <div
                onClick={() => setViewingImageId(null)}
                style={{
                  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
                  zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '20px', cursor: 'zoom-out',
                }}
              >
                <div onClick={(e) => e.stopPropagation()} style={{
                  maxWidth: '95vw', maxHeight: '95vh', display: 'flex', flexDirection: 'column',
                  gap: '12px', alignItems: 'center',
                }}>
                  <img
                    src={`/api/cognitive/document/${img.document_id}/file`}
                    alt={img.name}
                    style={{
                      maxWidth: '100%', maxHeight: 'calc(95vh - 60px)',
                      objectFit: 'contain', borderRadius: '8px',
                      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                    }}
                  />
                  <div style={{
                    color: 'white', fontSize: '13px', background: 'rgba(0,0,0,0.6)',
                    padding: '6px 14px', borderRadius: '6px',
                  }}>
                    {img.name} — Click outside to close
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Expanded Book Quality Report */}
          {expandedBookId && (
            <div style={{
              marginTop: 'var(--spacing-md)', padding: 'var(--spacing-md)',
              background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-md)',
            }}>
              {bookDetailLoading && (
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', textAlign: 'center', padding: '16px 0' }}>
                  Loading quality report...
                </div>
              )}
              {!bookDetailLoading && expandedBookDetail && (
                <>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '12px' }}>
                    Scan Quality Report — {expandedBookDetail.bookName}
                  </div>

                  {/* Summary bar */}
                  <div style={{ display: 'flex', gap: '16px', marginBottom: '12px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />
                      <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{expandedBookDetail.report.good} good</span>
                    </div>
                    {expandedBookDetail.report.warnings > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
                        <span style={{ fontSize: '13px', color: '#f59e0b' }}>{expandedBookDetail.report.warnings} warnings</span>
                      </div>
                    )}
                    {expandedBookDetail.report.needs_rescan > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#f85444', display: 'inline-block' }} />
                        <span style={{ fontSize: '13px', color: '#f85444' }}>{expandedBookDetail.report.needs_rescan} need re-scan</span>
                      </div>
                    )}
                    <div style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                      Overall: <strong style={{
                        color: expandedBookDetail.report.overall === 'excellent' ? '#10b981'
                          : expandedBookDetail.report.overall === 'acceptable' ? '#f59e0b'
                          : '#f85444'
                      }}>{expandedBookDetail.report.overall}</strong>
                    </div>
                  </div>

                  {/* Page tiles — only warning and rescan pages */}
                  {expandedBookDetail.pages.filter(p => p.quality !== 'good').length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
                      {expandedBookDetail.pages.filter(p => p.quality !== 'good').map((p) => {
                        const displayNum = getDisplayPageNum(p.filename) || String(p.page);
                        return (
                        <div
                          key={p.page}
                          onClick={() => expandedBookId && setPreviewPageInfo({ docId: expandedBookId, page: p.page, quality: p.quality, confidence: p.confidence, words: p.words, issues: p.quality_issues || [], filename: p.filename })}
                          title={`Page ${displayNum} (${p.filename})\n${p.words} words, ${p.confidence >= 0 ? p.confidence + '% confidence' : 'no confidence data'}${p.quality_issues?.length ? '\n' + p.quality_issues.join('\n') : ''}\nClick to preview & re-upload`}
                          style={{
                            width: 48, height: 62, borderRadius: '4px', fontSize: '9px', fontWeight: 600,
                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end',
                            cursor: 'pointer', overflow: 'hidden', position: 'relative',
                            background: p.quality === 'warning' ? '#f59e0b18' : '#f8544418',
                            border: `2px solid ${p.quality === 'warning' ? '#f59e0b80' : '#f8544480'}`,
                            transition: 'transform 0.1s',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.1)')}
                          onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                        >
                          {/* Thumbnail preview */}
                          <img
                            src={`/api/cognitive/books/${expandedBookId}/page/${p.page}/image`}
                            alt={`Page ${displayNum}`}
                            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.4 }}
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                          {/* Page number overlay — uses original filename number */}
                          <div style={{
                            position: 'relative', zIndex: 1, padding: '2px 4px',
                            background: p.quality === 'warning' ? '#f59e0bcc' : '#f85444cc',
                            color: '#fff', borderRadius: '2px', fontSize: '9px', marginBottom: '2px',
                          }}>
                            {displayNum}
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Flagged pages detail list */}
                  {expandedBookDetail.report.flagged_pages.length > 0 && (
                    <div>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        Pages needing attention
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '200px', overflowY: 'auto' }}>
                        {expandedBookDetail.report.flagged_pages.map((fp) => {
                          const fpDisplayNum = getDisplayPageNum(fp.filename) || String(fp.page);
                          return (
                          <div key={fp.page} style={{
                            padding: '8px 12px', borderRadius: 'var(--radius-sm)',
                            background: fp.quality === 'rescan' ? '#f8544412' : '#f59e0b12',
                            border: `1px solid ${fp.quality === 'rescan' ? '#f8544440' : '#f59e0b40'}`,
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '13px', fontWeight: 600, color: fp.quality === 'rescan' ? '#f85444' : '#f59e0b' }}>
                                Page {fpDisplayNum} — {fp.filename}
                              </span>
                              <span style={{
                                padding: '2px 8px', borderRadius: '10px', fontSize: '10px', fontWeight: 700,
                                background: fp.quality === 'rescan' ? '#f85444' : '#f59e0b',
                                color: '#fff',
                              }}>
                                {fp.quality === 'rescan' ? 'RE-SCAN' : 'WARNING'}
                              </span>
                            </div>
                            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                              {fp.confidence}% confidence | {fp.words} words
                            </div>
                            <ul style={{ margin: '4px 0 0 16px', padding: 0, fontSize: '11px', color: 'var(--text-tertiary)' }}>
                              {fp.issues.map((issue, idx) => (
                                <li key={idx} style={{ marginBottom: '2px' }}>{issue}</li>
                              ))}
                            </ul>
                            <button
                              onClick={() => expandedBookId && setPreviewPageInfo({ docId: expandedBookId, page: fp.page, quality: fp.quality, confidence: fp.confidence, words: fp.words, issues: fp.issues, filename: fp.filename })}
                              style={{
                                marginTop: '6px', padding: '4px 12px', fontSize: '11px', fontWeight: 600,
                                background: '#1f6feb', color: '#fff', border: 'none',
                                borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                              }}
                            >
                              Preview & Re-upload
                            </button>
                          </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {expandedBookDetail.report.flagged_pages.length === 0 && (
                    <div style={{ fontSize: '13px', color: '#10b981', textAlign: 'center', padding: '8px 0' }}>
                      All pages scanned successfully — no issues detected
                    </div>
                  )}
                </>
              )}
              {!bookDetailLoading && !expandedBookDetail && (
                <div style={{ fontSize: '13px', color: 'var(--text-tertiary)', textAlign: 'center', padding: '16px 0' }}>
                  No quality report available for this book
                </div>
              )}
            </div>
          )}
        </div>
        ); })()}

      {/* Upload Status */}
      {uploadStatus && (
        <div style={{
          marginTop: 'var(--spacing-md)', padding: 'var(--spacing-sm) var(--spacing-md)',
          background: uploadStatus.includes('failed') ? '#f8544422' : '#10b98122',
          border: `1px solid ${uploadStatus.includes('failed') ? '#f85444' : '#10b981'}`,
          borderRadius: 'var(--radius-sm)',
          color: uploadStatus.includes('failed') ? '#f85444' : '#10b981',
          fontSize: 'var(--text-sm)',
        }}>
          {uploadStatus}
        </div>
      )}

      {/* Quality Report after book upload */}
      {qualityReport && (
        <div style={{
          marginTop: 'var(--spacing-md)', padding: 'var(--spacing-md)',
          background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
          borderRadius: 'var(--radius-md)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Scan Quality Report — {qualityReport.bookName}
            </div>
            <button
              onClick={() => setQualityReport(null)}
              style={{
                padding: '2px 8px', background: 'transparent', border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-sm)', color: 'var(--text-tertiary)', fontSize: '11px', cursor: 'pointer',
              }}
            >Dismiss</button>
          </div>

          {/* Summary bar */}
          <div style={{ display: 'flex', gap: '16px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{qualityReport.report.good} good</span>
            </div>
            {qualityReport.report.warnings > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
                <span style={{ fontSize: '13px', color: '#f59e0b' }}>{qualityReport.report.warnings} warnings</span>
              </div>
            )}
            {qualityReport.report.needs_rescan > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#f85444', display: 'inline-block' }} />
                <span style={{ fontSize: '13px', color: '#f85444' }}>{qualityReport.report.needs_rescan} need re-scan</span>
              </div>
            )}
            <div style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--text-tertiary)' }}>
              Overall: <strong style={{
                color: qualityReport.report.overall === 'excellent' ? '#10b981'
                  : qualityReport.report.overall === 'acceptable' ? '#f59e0b'
                  : '#f85444'
              }}>{qualityReport.report.overall}</strong>
            </div>
          </div>

          {/* Page tiles — only warning and rescan pages */}
          {qualityReport.pages.filter(p => p.quality !== 'good').length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
            {qualityReport.pages.filter(p => p.quality !== 'good').map((p) => {
              const displayNum = getDisplayPageNum(p.filename) || String(p.page);
              return (
              <div
                key={p.page}
                onClick={() => qualityReport.documentId && setPreviewPageInfo({ docId: qualityReport.documentId, page: p.page, quality: p.quality, confidence: p.confidence, words: p.words, issues: p.quality_issues || [], filename: p.filename })}
                title={`Page ${displayNum} (${p.filename})\n${p.words} words, ${p.confidence >= 0 ? p.confidence + '% confidence' : 'no confidence data'}${p.quality_issues?.length ? '\n' + p.quality_issues.join('\n') : ''}\nClick to preview & re-upload`}
                style={{
                  width: 48, height: 62, borderRadius: '4px', fontSize: '9px', fontWeight: 600,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end',
                  cursor: 'pointer', overflow: 'hidden', position: 'relative',
                  background: p.quality === 'warning' ? '#f59e0b18' : '#f8544418',
                  border: `2px solid ${p.quality === 'warning' ? '#f59e0b80' : '#f8544480'}`,
                  transition: 'transform 0.1s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.1)')}
                onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
              >
                {/* Thumbnail preview */}
                <img
                  src={`/api/cognitive/books/${qualityReport.documentId}/page/${p.page}/image`}
                  alt={`Page ${displayNum}`}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.4 }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
                {/* Page number overlay — uses original filename number */}
                <div style={{
                  position: 'relative', zIndex: 1, padding: '2px 4px',
                  background: p.quality === 'warning' ? '#f59e0bcc' : '#f85444cc',
                  color: '#fff', borderRadius: '2px', fontSize: '9px', marginBottom: '2px',
                }}>
                  {displayNum}
                </div>
              </div>
              );
            })}
          </div>
          )}

          {/* Flagged pages detail list */}
          {qualityReport.report.flagged_pages.length > 0 && (
            <div>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Pages needing attention
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '200px', overflowY: 'auto' }}>
                {qualityReport.report.flagged_pages.map((fp) => {
                  const fpDisplayNum = getDisplayPageNum(fp.filename) || String(fp.page);
                  return (
                  <div key={fp.page} style={{
                    padding: '8px 12px', borderRadius: 'var(--radius-sm)',
                    background: fp.quality === 'rescan' ? '#f8544412' : '#f59e0b12',
                    border: `1px solid ${fp.quality === 'rescan' ? '#f8544440' : '#f59e0b40'}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: fp.quality === 'rescan' ? '#f85444' : '#f59e0b' }}>
                        Page {fpDisplayNum} — {fp.filename}
                      </span>
                      <span style={{
                        padding: '2px 8px', borderRadius: '10px', fontSize: '10px', fontWeight: 700,
                        background: fp.quality === 'rescan' ? '#f85444' : '#f59e0b',
                        color: '#fff',
                      }}>
                        {fp.quality === 'rescan' ? 'RE-SCAN' : 'WARNING'}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                      {fp.confidence}% confidence | {fp.words} words
                    </div>
                    <ul style={{ margin: '4px 0 0 16px', padding: 0, fontSize: '11px', color: 'var(--text-tertiary)' }}>
                      {fp.issues.map((issue, idx) => (
                        <li key={idx} style={{ marginBottom: '2px' }}>{issue}</li>
                      ))}
                    </ul>
                    <button
                      onClick={() => qualityReport.documentId && setPreviewPageInfo({ docId: qualityReport.documentId, page: fp.page, quality: fp.quality, confidence: fp.confidence, words: fp.words, issues: fp.issues, filename: fp.filename })}
                      style={{
                        marginTop: '6px', padding: '4px 12px', fontSize: '11px', fontWeight: 600,
                        background: '#1f6feb', color: '#fff', border: 'none',
                        borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                      }}
                    >
                      Preview & Re-upload
                    </button>
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {qualityReport.report.flagged_pages.length === 0 && (
            <div style={{ fontSize: '13px', color: '#10b981', textAlign: 'center', padding: '8px 0' }}>
              All pages scanned successfully — no issues detected
            </div>
          )}
        </div>
      )}

      {/* Uploaded Files Gallery */}
      {uploadedFiles.length > 0 && (
        <div style={{ marginTop: 'var(--spacing-lg)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Uploaded Files ({uploadedFiles.length})
            </span>
            <button
              onClick={clearUploaded}
              style={{
                padding: '3px 10px', background: 'transparent',
                border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                color: 'var(--text-tertiary)', fontSize: '11px', cursor: 'pointer',
              }}
            >
              Clear List
            </button>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap: 'var(--spacing-md)',
          }}>
            {uploadedFiles.map((file, idx) => (
              <div
                key={`${file.name}-${idx}`}
                onClick={() => file.status === 'success' ? openPreview(file) : undefined}
                style={{
                  background: 'var(--bg-secondary)',
                  border: `1px solid ${file.status === 'success' ? 'var(--border-primary)' : file.status === 'failed' ? '#f85149' : 'var(--color-primary)'}`,
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                  cursor: file.status === 'success' ? 'pointer' : 'default',
                  transition: 'border-color 0.2s',
                }}
              >
                {/* Thumbnail / Icon */}
                <div style={{
                  height: '100px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'var(--bg-tertiary)',
                  overflow: 'hidden',
                }}>
                  {file.preview ? (
                    <img src={file.preview} alt={file.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <span style={{ fontSize: '32px', opacity: 0.4 }}>
                      {file.type.includes('pdf') ? '\u{1F4C4}' : file.type.includes('audio') ? '\u{1F3B5}' : file.type.includes('spreadsheet') || file.name.endsWith('.xlsx') || file.name.endsWith('.csv') ? '\u{1F4CA}' : '\u{1F4C3}'}
                    </span>
                  )}
                </div>

                {/* File Info */}
                <div style={{ padding: '8px 10px' }}>
                  <div style={{
                    fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    marginBottom: '4px',
                  }}>
                    {file.name}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>
                      {formatSize(file.size)}
                    </span>
                    <span style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <span style={{
                        fontSize: '10px', fontWeight: 600,
                        color: file.status === 'success' ? '#3fb950' : file.status === 'duplicate' ? '#d29922' : file.status === 'failed' ? '#f85149' : 'var(--color-primary)',
                      }}>
                        {file.status === 'uploading' ? 'Processing...' : file.status === 'success' ? 'Indexed' : file.status === 'duplicate' ? 'Duplicate' : 'Failed'}
                      </span>
                      {file.status === 'duplicate' && file.duplicateOf && (
                        <span style={{
                          fontSize: '9px', padding: '1px 4px', borderRadius: '3px',
                          background: 'rgba(210,153,34,0.15)', color: '#d29922',
                          maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                          title={`Duplicate of "${file.duplicateOf}"`}
                        >
                          of "{file.duplicateOf}"
                        </span>
                      )}
                      {file.status === 'success' && (
                        <span style={{
                          fontSize: '9px', padding: '1px 4px', borderRadius: '3px',
                          background: 'rgba(76,175,80,0.15)', color: '#81c784',
                        }}>
                          In Chat
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewFile && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            zIndex: 1000, padding: '20px',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setPreviewFile(null); }}
        >
          <div style={{
            background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-primary)',
            maxWidth: '800px', width: '100%', maxHeight: '85vh', overflow: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          }}>
            {/* Preview Header */}
            <div style={{
              padding: '14px 20px', borderBottom: '1px solid var(--border-primary)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '15px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {previewFile.name}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  {previewFile.type} — {formatSize(previewFile.size)}
                </div>
              </div>
              <button
                onClick={() => setPreviewFile(null)}
                style={{
                  padding: '6px 14px', background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)', cursor: 'pointer', fontSize: '12px', flexShrink: 0,
                }}
              >
                Close
              </button>
            </div>

            {/* Preview Content */}
            <div style={{ padding: '20px' }}>
              {previewFile.preview ? (
                <img
                  src={previewFile.preview}
                  alt={previewFile.name}
                  style={{
                    maxWidth: '100%', maxHeight: '60vh', display: 'block',
                    margin: '0 auto', borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-primary)',
                  }}
                />
              ) : previewLoading ? (
                <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '40px' }}>
                  Loading content...
                </div>
              ) : previewContent ? (
                <pre style={{
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  fontSize: '13px', lineHeight: '1.6', color: 'var(--text-primary)',
                  maxHeight: '60vh', overflow: 'auto',
                  padding: '16px', background: 'var(--bg-secondary)',
                  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-primary)',
                  fontFamily: 'monospace', margin: 0,
                }}>
                  {previewContent}
                </pre>
              ) : (
                <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '40px' }}>
                  No preview available for this file type.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Page Preview + Re-upload Modal */}
      {previewPageInfo && previewPageInfo.docId && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.75)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => { setPreviewPageInfo(null); setReplaceStatus(null); }}>
          <div style={{
            background: 'var(--bg-primary)', border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-lg)', padding: '24px', maxWidth: '600px', width: '90%',
            maxHeight: '85vh', overflowY: 'auto',
          }} onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Page {getDisplayPageNum(previewPageInfo.filename || '') || previewPageInfo.page}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  {previewPageInfo.filename && <span style={{ marginRight: '8px' }}>{previewPageInfo.filename}</span>}
                  {previewPageInfo.words} words | {previewPageInfo.confidence >= 0 ? `${previewPageInfo.confidence}% confidence` : 'No confidence data'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{
                  padding: '4px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 700,
                  background: previewPageInfo.quality === 'good' ? '#10b981' : previewPageInfo.quality === 'warning' ? '#f59e0b' : '#f85444',
                  color: '#fff',
                }}>
                  {previewPageInfo.quality === 'good' ? 'GOOD' : previewPageInfo.quality === 'warning' ? 'WARNING' : 'RE-SCAN'}
                </span>
                <button onClick={() => { setPreviewPageInfo(null); setReplaceStatus(null); }} style={{
                  background: 'transparent', border: 'none', color: 'var(--text-tertiary)', fontSize: '20px', cursor: 'pointer', padding: '0 4px',
                }}>×</button>
              </div>
            </div>

            {/* Issues list */}
            {previewPageInfo.issues.length > 0 && (
              <div style={{
                marginBottom: '16px', padding: '10px 14px',
                background: previewPageInfo.quality === 'rescan' ? '#f8544412' : '#f59e0b12',
                border: `1px solid ${previewPageInfo.quality === 'rescan' ? '#f8544440' : '#f59e0b40'}`,
                borderRadius: 'var(--radius-sm)',
              }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: previewPageInfo.quality === 'rescan' ? '#f85444' : '#f59e0b', marginBottom: '6px' }}>Issues detected:</div>
                <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {previewPageInfo.issues.map((issue, idx) => <li key={idx} style={{ marginBottom: '3px' }}>{issue}</li>)}
                </ul>
              </div>
            )}

            {/* Page image preview */}
            <div style={{
              marginBottom: '16px', borderRadius: 'var(--radius-sm)', overflow: 'hidden',
              border: '1px solid var(--border-primary)', background: '#111',
              display: 'flex', justifyContent: 'center', maxHeight: '400px',
            }}>
              <img
                src={`/api/cognitive/books/${previewPageInfo.docId}/page/${previewPageInfo.page}/image`}
                alt={`Page ${previewPageInfo.page}`}
                style={{ maxWidth: '100%', maxHeight: '400px', objectFit: 'contain' }}
                onError={(e) => {
                  const el = e.target as HTMLImageElement;
                  el.style.display = 'none';
                  el.parentElement!.innerHTML = '<div style="padding:40px;color:#666;text-align:center">Page image not available<br><span style="font-size:11px">Images are stored during upload</span></div>';
                }}
              />
            </div>

            {/* Replace status */}
            {replaceStatus && (
              <div style={{
                marginBottom: '12px', padding: '8px 12px', borderRadius: 'var(--radius-sm)',
                background: replaceStatus.includes('failed') ? '#f8544422' : '#10b98122',
                border: `1px solid ${replaceStatus.includes('failed') ? '#f85444' : '#10b981'}`,
                color: replaceStatus.includes('failed') ? '#f85444' : '#10b981',
                fontSize: '12px',
              }}>
                {replaceStatus}
              </div>
            )}

            {/* Re-upload button */}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setPreviewPageInfo(null); setReplaceStatus(null); }}
                style={{
                  padding: '10px 20px', background: 'transparent',
                  border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer',
                }}
              >Close</button>
              <button
                onClick={() => replaceInputRef.current?.click()}
                disabled={replacingPage}
                style={{
                  padding: '10px 20px',
                  background: previewPageInfo.quality !== 'good' ? '#1f6feb' : '#238636',
                  color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)',
                  fontWeight: 600, fontSize: '13px', cursor: replacingPage ? 'not-allowed' : 'pointer',
                  opacity: replacingPage ? 0.6 : 1,
                }}
              >
                {replacingPage ? 'Replacing...' : previewPageInfo.quality !== 'good' ? `Re-upload Page ${getDisplayPageNum(previewPageInfo.filename || '') || previewPageInfo.page}` : `Replace Page ${getDisplayPageNum(previewPageInfo.filename || '') || previewPageInfo.page}`}
              </button>
              <input
                ref={replaceInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handlePageReplace(file);
                  if (e.target) e.target.value = '';
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Query Tab ──────────────────────────────────────────────────────────────

function QueryTab({ memoryHealthy }: { memoryHealthy: boolean }) {
  const [queryText, setQueryText] = useState('');
  const [querying, setQuerying] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryResult, setQueryResult] = useState<any>(null);
  const [querySource, setQuerySource] = useState<string | null>(null);

  const handleQuery = async () => {
    const q = queryText.trim();
    if (!q || querying) return;
    setQuerying(true);
    setQueryError(null);
    setQueryResult(null);
    setQuerySource(null);
    try {
      const res = await fetch('/api/memory/gateway/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      const data = await res.json();
      if (!res.ok) { setQueryError(data.detail || data.error || 'Query failed'); return; }
      if (data.status === 'no_results' || !data.result) { setQueryResult({ empty: true }); return; }
      setQuerySource(data.source || null);
      setQueryResult({ ...data.result, elapsed_ms: data.elapsed_ms });
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setQuerying(false);
    }
  };

  return (
    <div>
      <div style={{
        padding: 'var(--spacing-lg)', background: 'var(--bg-secondary)',
        borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)',
      }}>
        <div style={{ fontWeight: '600', color: 'var(--color-primary)', fontSize: '16px', marginBottom: 'var(--spacing-sm)' }}>
          Query Memory
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--spacing-md)' }}>
          Search your ingested documents, emails, and OCR-scanned images
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input
            type="text" value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleQuery(); }}
            placeholder="e.g. What are the key findings in the report?"
            disabled={querying}
            style={{
              flex: 1, padding: '10px 14px',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)', fontSize: 'var(--text-sm)', outline: 'none',
            }}
          />
          <button
            onClick={handleQuery}
            disabled={querying || !queryText.trim()}
            style={{
              padding: '10px 20px',
              background: querying ? 'var(--bg-tertiary)' : '#238636',
              color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)',
              fontWeight: 600, fontSize: 'var(--text-sm)',
              cursor: querying || !queryText.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            {querying ? 'Searching...' : 'Search'}
          </button>
        </div>

        {queryError && (
          <div style={{
            marginTop: 'var(--spacing-md)', padding: 'var(--spacing-md)',
            background: '#f8514422', border: '1px solid #f85149',
            borderRadius: 'var(--radius-sm)', color: '#f85149', fontSize: 'var(--text-sm)',
          }}>
            {queryError}
          </div>
        )}

        {queryResult?.empty && (
          <div style={{
            marginTop: 'var(--spacing-md)', padding: 'var(--spacing-md)',
            background: '#1f2d3d', border: '1px solid #30363d',
            borderRadius: 'var(--radius-sm)', color: '#58a6ff', fontSize: 'var(--text-sm)',
          }}>
            No results found for this query.
          </div>
        )}

        {queryResult && !queryResult.empty && (
          <div style={{ marginTop: 'var(--spacing-md)' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: 'var(--spacing-md)' }}>
              Type: <strong style={{ color: 'var(--text-primary)' }}>{queryResult.query?.query_type || 'general'}</strong>
              {queryResult.elapsed_ms != null && (
                <> | Latency: <strong style={{ color: 'var(--text-primary)' }}>{queryResult.elapsed_ms}ms</strong></>
              )}
              {querySource && (
                <> | Source: <strong style={{ color: querySource.includes('local') ? '#3fb950' : '#58a6ff' }}>{querySource}</strong></>
              )}
            </div>
            <EvidenceGroup title="Direct Evidence" items={queryResult.direct_evidence} />
            <EvidenceGroup title="Supporting Background" items={queryResult.supporting_background} />
            <EvidenceGroup title="Summary Guidance" items={queryResult.summary_guidance} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Statistics Tab ─────────────────────────────────────────────────────────

function StatsTab() {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [catStats, setCatStats] = useState<CategorizedStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const [buildRes, catRes] = await Promise.allSettled([
        fetch('/api/build-memory/stats').then(r => r.ok ? r.json() : null),
        fetch('/api/memory/stats').then(r => r.ok ? r.json() : null),
      ]);
      if (buildRes.status === 'fulfilled' && buildRes.value) setStats(buildRes.value);
      // Only accept the categorized-stats shape this panel renders —
      // /api/memory/stats returns {counts,available} on this build, and
      // setting that object crashed the tab on Object.entries(undefined).
      if (catRes.status === 'fulfilled' && catRes.value?.byCategory) setCatStats(catRes.value);
      setLoading(false);
    };
    load();
  }, []);

  if (loading) {
    return <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 'var(--spacing-xl)' }}>Loading statistics...</div>;
  }

  return (
    <div>
      {/* Categorized Memory */}
      {catStats && (
        <div style={{ marginBottom: 'var(--spacing-xl)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)', marginBottom: 'var(--spacing-lg)' }}>
            <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: catStats.total > 0 ? '#10b981' : '#6b7280' }} />
            <div>
              <div style={{ fontWeight: '600', color: 'var(--color-primary)', fontSize: '18px' }}>Categorized Memory</div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                {catStats.total} memories | Avg strength: {catStats.avgStrength}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 'var(--spacing-md)', marginBottom: 'var(--spacing-lg)' }}>
            {Object.entries(catStats.byCategory ?? {}).map(([cat, count]) => (
              <div key={cat} style={{
                padding: 'var(--spacing-md)', background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: '4px' }}>{cat.replace('_', ' ')}</div>
                <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--color-primary)' }}>{count}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 'var(--spacing-lg)', flexWrap: 'wrap' }}>
            {Object.entries(catStats.byState ?? {}).map(([state, count]) => {
              const colors: Record<string, string> = { active: '#10b981', archived: '#6b7280', consolidated: '#8b5cf6' };
              return (
                <div key={state} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: colors[state] ?? '#6b7280' }} />
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{state}: {count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Build Learning */}
      {stats && (
        <div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)',
            padding: 'var(--spacing-lg)', background: 'var(--bg-secondary)',
            borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)',
            marginBottom: 'var(--spacing-lg)',
          }}>
            <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: stats.enabled ? '#10b981' : '#ef4444' }} />
            <div>
              <div style={{ fontWeight: '600', color: 'var(--color-primary)' }}>Build Learning Memory</div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                {(() => {
                  // A store that has recorded builds is, by definition,
                  // connected — derive it so a missing/stale `connected`
                  // field can never show a false 'waiting for DB'.
                  const connected = stats.connected || (stats.recordedBuilds ?? 0) > 0;
                  if (stats.enabled && connected) return 'Active — connected and recording patterns';
                  if (stats.enabled) return 'Enabled — no builds recorded yet';
                  return 'Disabled';
                })()}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--spacing-md)' }}>
            <StatCard label="Total Builds" value={stats.totalBuilds ?? stats.recordedBuilds ?? 0} color="var(--color-primary)" />
            <StatCard label="Success Rate" value={`${stats.successRate ?? (
              (stats.recordedBuilds ?? 0) > 0
                ? Math.round(((stats.successfulPatterns ?? 0) / (stats.recordedBuilds ?? 1)) * 100)
                : 0
            )}%`} color="#10b981" />
            <StatCard label="Recorded Builds" value={stats.recordedBuilds ?? 0} color="var(--color-primary)" />
            <StatCard label="Success Patterns" value={stats.successfulPatterns} color="#8b5cf6" />
            <StatCard label="Failed Patterns" value={stats.failedPatterns} color="#ef4444" />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Shared Components ──────────────────────────────────────────────────────

function PagButton({ label, active, disabled, onClick }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '6px 12px',
        background: active ? 'var(--color-primary)' : 'var(--bg-secondary)',
        color: active ? '#000' : disabled ? 'var(--text-secondary)' : 'var(--text-primary)',
        border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-sm)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '12px', fontWeight: active ? '600' : '400',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

function EvidenceGroup({ title, items }: { title: string; items?: any[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ marginBottom: 'var(--spacing-md)' }}>
      <div style={{
        fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px',
        color: 'var(--text-secondary)', marginBottom: '8px',
        paddingBottom: '4px', borderBottom: '1px solid var(--border-primary)',
      }}>
        {title} ({items.length})
      </div>
      {items.map((item, i) => (
        <EvidenceCard key={i} item={item} />
      ))}
    </div>
  );
}

function EvidenceCard({ item }: { item: any }) {
  return (
    <div style={{
      padding: '10px 12px', background: 'var(--bg-primary)',
      border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
      marginBottom: '6px',
    }}>
      {item.file_name && (
        <div style={{ fontSize: '11px', color: '#58a6ff', marginBottom: '4px', fontWeight: 600 }}>
          {item.file_name}
          {item.page_from && <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}> — page {item.page_from}</span>}
        </div>
      )}
      <div style={{ fontSize: '13px', lineHeight: '1.5', color: 'var(--text-primary)' }}>
        {item.text}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '6px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: '#3fb950', fontWeight: 600 }}>Score: {typeof item.score === 'number' ? item.score.toFixed(3) : item.score}</span>
        {item.tier && (
          <span style={{
            padding: '1px 6px', borderRadius: '10px', fontSize: '10px', fontWeight: 600,
            background: item.tier === 'canonical' ? '#1f3a2e' : item.tier === 'summary' ? '#1a1d4e' : '#21262d',
            color: item.tier === 'canonical' ? '#3fb950' : item.tier === 'summary' ? '#6e7ff3' : '#8b949e',
          }}>
            {item.tier}
          </span>
        )}
        {item.has_ocr && (
          <span style={{
            padding: '1px 6px', borderRadius: '10px', fontSize: '10px', fontWeight: 600,
            background: '#1a3a4e', color: '#58d4ff',
          }}>
            OCR{item.ocr_confidence != null ? ` ${(item.ocr_confidence * 100).toFixed(0)}%` : ''}
          </span>
        )}
        {item.heading_path && <span>{item.heading_path}</span>}
        {!item.file_name && item.page_from && <span>p.{item.page_from}</span>}
        {item.source_document_id && <span style={{ fontFamily: 'monospace' }}>doc:{item.source_document_id.slice(0, 12)}...</span>}
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{
      padding: 'var(--spacing-lg)', background: 'var(--bg-secondary)',
      borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--spacing-sm)' }}>{label}</div>
      <div style={{ fontSize: '32px', fontWeight: '600', color }}>{value}</div>
    </div>
  );
}
