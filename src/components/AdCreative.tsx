"use client";

import { useEffect, useRef, useState } from "react";

type AdCreativeProps = {
  imageUrl?: string;
  videoUrl?: string;
  className?: string;
  /** Detail view: show controls and play muted. */
  controls?: boolean;
};

export function AdCreative({
  imageUrl,
  videoUrl,
  className = "",
  controls = false,
}: AdCreativeProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hovering, setHovering] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const canPreview = Boolean(videoUrl) && !videoFailed;
  const showVideo = canPreview && (controls || hovering || !imageUrl);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !canPreview) return;

    if (showVideo) {
      const play = el.play();
      if (play) {
        void play.catch(() => {
          setVideoFailed(true);
        });
      }
    } else {
      el.pause();
      try {
        el.currentTime = 0;
      } catch {
        /* ignore seek errors before metadata */
      }
    }
  }, [showVideo, canPreview, videoUrl]);

  if (!imageUrl && !canPreview) {
    return (
      <div
        className={`flex items-center justify-center bg-surface-2 text-sm text-muted ${className}`}
      >
        Sin creativo
      </div>
    );
  }

  return (
    <div
      className={`relative overflow-hidden bg-surface-2 ${className}`}
      onMouseEnter={() => {
        if (!controls && canPreview) setHovering(true);
      }}
      onMouseLeave={() => {
        if (!controls) setHovering(false);
      }}
    >
      {imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${
            showVideo ? "opacity-0" : "opacity-100"
          }`}
        />
      )}
      {canPreview && (
        <video
          ref={videoRef}
          src={videoUrl}
          muted
          loop
          playsInline
          preload={controls || !imageUrl ? "metadata" : "none"}
          controls={controls}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${
            showVideo ? "opacity-100" : "opacity-0"
          }`}
          onError={() => setVideoFailed(true)}
        />
      )}
      {canPreview && !controls && !hovering && imageUrl && (
        <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white">
          Video
        </span>
      )}
    </div>
  );
}
