import { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { fetchProtectedPhotoBlobUrl } from '../lib/photoApi';

interface SecureClinicalImageProps {
  src?: string;
  alt: string;
  className?: string;
  fallbackLabel?: string;
}

const sessionBlobCache = new Map<string, string>();

export function SecureClinicalImage({
  src,
  alt,
  className = 'w-full h-full object-cover',
  fallbackLabel,
}: SecureClinicalImageProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => {
    if (!src) return null;
    if (!src.startsWith('/api/photos/')) return src;
    return sessionBlobCache.get(src) || null;
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!src) {
      setBlobUrl(null);
      setFailed(false);
      return;
    }
    if (!src.startsWith('/api/photos/')) {
      setBlobUrl(src);
      setFailed(false);
      return;
    }

    const cached = sessionBlobCache.get(src);
    if (cached) {
      setBlobUrl(cached);
      setFailed(false);
      return;
    }

    let cancelled = false;
    setFailed(false);
    fetchProtectedPhotoBlobUrl(src)
      .then((objectUrl) => {
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        sessionBlobCache.set(src, objectUrl);
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [src]);

  if (!src || failed) {
    return (
      <div className="w-full h-full bg-slate-100 text-slate-400 flex flex-col items-center justify-center gap-1 select-none p-2 text-center">
        {fallbackLabel ? (
          <span className="text-xs font-semibold tracking-tight text-slate-500 uppercase">
            {fallbackLabel}
          </span>
        ) : (
          <ImageOff className="w-5 h-5" />
        )}
      </div>
    );
  }

  if (!blobUrl) {
    return <div className="w-full h-full bg-slate-100" aria-label={alt} />;
  }

  return (
    <img
      src={blobUrl}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
