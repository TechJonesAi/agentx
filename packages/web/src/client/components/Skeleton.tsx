import React from 'react';
import './Skeleton.css';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  variant?: 'text' | 'circular' | 'rectangular';
  animation?: 'pulse' | 'wave';
  count?: number;
  style?: React.CSSProperties;
}

export function Skeleton({
  width = '100%',
  height = '20px',
  variant = 'rectangular',
  animation = 'pulse',
  count = 1,
  style,
}: SkeletonProps) {
  const skeletons = Array.from({ length: count });

  return (
    <>
      {skeletons.map((_, idx) => (
        <div
          key={idx}
          className={`skeleton skeleton-${variant} skeleton-${animation}`}
          style={{
            width: typeof width === 'number' ? `${width}px` : width,
            height: typeof height === 'number' ? `${height}px` : height,
            ...(idx < skeletons.length - 1 && { marginBottom: '8px' }),
            ...style,
          }}
        />
      ))}
    </>
  );
}

export function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <div style={{ marginBottom: '16px' }}>
        <Skeleton height="24px" width="40%" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginBottom: '16px' }}>
        <div>
          <Skeleton height="12px" width="60%" style={{ marginBottom: '8px' }} />
          <Skeleton height="32px" width="80%" />
        </div>
        <div>
          <Skeleton height="12px" width="60%" style={{ marginBottom: '8px' }} />
          <Skeleton height="32px" width="80%" />
        </div>
      </div>
      <div style={{ marginBottom: '16px' }}>
        <Skeleton height="6px" />
      </div>
      <Skeleton height="12px" width="70%" />
    </div>
  );
}
