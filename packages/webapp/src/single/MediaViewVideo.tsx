import * as React from "react";
import { useState, useRef, useEffect } from "react";
import Hammer from 'hammerjs'

import { getHigherPreviewUrl } from '../utils/preview'
import { usePreviewSize } from "./usePreviewSize";

export const MediaViewVideo = (props) => {
  const { media, dispatch, isSlideshowActive } = props
  const { previews } = media;
  const [isPlaying, setIsPlaying] = useState(false)
  const ref = useRef()
  const gestureOverlay = useRef()
  const previewSize = usePreviewSize()
  const posterUrl = getHigherPreviewUrl(previews, previewSize) || ''

  const videoPreview = previews.filter(p => p.match(/video-preview/)).shift()
  const videoUrl = videoPreview ? `files/${videoPreview}` : ''
  const videoMime = videoPreview ? `video/${videoPreview.substring(videoPreview.lastIndexOf('.') + 1).toLowerCase()}` : 'video/mp4'

  useEffect(() => {
    const e: HTMLElement = ref.current;
    if (!e) {
      return
    }

    const onPause = () => {
      setIsPlaying(false)
      dispatch({type: 'pause'})
    }
    const onPlay = () => {
      setIsPlaying(true)
      dispatch({type: 'play'})
    }

    e.addEventListener('pause', onPause)
    e.addEventListener('play', onPlay)

    return () => {
      e.removeEventListener('pause', onPause)
      e.removeEventListener('play', onPlay)
    }
  }, [ref, dispatch])

  // Autoplay if slideshow is active (muted often required by browser policy)
  useEffect(() => {
    const video = ref.current;
    if (!video) return

    if (isSlideshowActive) {
      const tryPlay = () => {
        video.muted = true
        video.play().then(() => setIsPlaying(true))
          .catch(err => console.warn("Autoplay failed:", err))
      }
      if (video.readyState >= 2) {
        tryPlay()
      } else {
        video.addEventListener('canplay', tryPlay, { once: true })
        return () => video.removeEventListener('canplay', tryPlay)
      }
    } else {
      video.muted = false
      video.pause()
      setIsPlaying(false)
    }
  }, [isSlideshowActive])

  // Overlay above control bar: tap = toggle nav, swipe when paused = next/prev (control bar stays tappable)
  useEffect(() => {
    const video = ref.current;
    const overlay = gestureOverlay.current;
    if (!video || !overlay) return;

    const onSwipeHandler = (ev) => {
      if (!video.paused) return;
      ev.preventDefault();
      if (ev.direction === Hammer.DIRECTION_LEFT) {
        dispatch({ type: 'next' });
      } else if (ev.direction === Hammer.DIRECTION_RIGHT) {
        dispatch({ type: 'prev' });
      }
    };

    const onTapHandler = () => {
      dispatch({ type: 'toggleNavigation' });
    };

    const mc = new Hammer.Manager(overlay);
    mc.add(new Hammer.Swipe());
    mc.add(new Hammer.Tap());
    mc.on('swipe', onSwipeHandler);
    mc.on('tap', onTapHandler);

    return () => {
      mc.stop(false);
      mc.destroy();
    };
  }, [dispatch])

  return (
    <div className="relative flex items-center justify-center w-full h-full">
      <video ref={ref} controls playsInline poster={posterUrl} className="w-full h-full">
        <source src={videoUrl} type={videoMime} />
        No native video element support. Watch video file from <a href={videoUrl}>here</a>
      </video>
      {/* Tap = toggle nav; leaves bottom strip (control bar) uncovered so play/pause stay tappable */}
      <div
        ref={gestureOverlay}
        className="absolute top-0 left-0 right-0 bottom-14 md:bottom-18"
        aria-hidden
      />
    </div>
  )
}
