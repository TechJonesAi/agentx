/**
 * Offline Status Indicator
 * Shows user when operating without network connectivity
 */

import { useOfflineState } from '../hooks/useOfflineState';
import './OfflineIndicator.css';

export function OfflineIndicator() {
  const { isOnline, hasBeenOffline, lastOfflineTime } = useOfflineState();

  // Only show if offline or was offline
  if (isOnline && !hasBeenOffline) {
    return null;
  }

  // Format time since offline
  const getTimeAgo = () => {
    if (!lastOfflineTime) return '';

    const now = new Date();
    const diffMs = now.getTime() - lastOfflineTime.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return 'earlier';
  };

  if (!isOnline) {
    return (
      <div className="offline-indicator offline-indicator-disconnected">
        <div className="offline-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="1"></circle>
            <path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9h-5.5a4.5 4.5 0 1 1 0-9m5.5 9v-4.5"></path>
            <path d="M3 3l18 18"></path>
          </svg>
        </div>
        <div className="offline-content">
          <div className="offline-title">No Connection</div>
          <div className="offline-message">Using cached data</div>
        </div>
      </div>
    );
  }

  // Show reconnected status temporarily
  return (
    <div className="offline-indicator offline-indicator-reconnected">
      <div className="offline-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
          <polyline points="23 7 23 1 17 1"></polyline>
          <line x1="16" y1="8" x2="23" y2="1"></line>
        </svg>
      </div>
      <div className="offline-content">
        <div className="offline-title">Reconnected</div>
        <div className="offline-message">Back online • {getTimeAgo()}</div>
      </div>
    </div>
  );
}
