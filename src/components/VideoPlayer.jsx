import React, { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'

export default function VideoPlayer({ videoInfo, autoplay = true, controls = true }) {
    const videoRef = useRef(null)
    const [hlsFailed, setHlsFailed] = useState(false)

    const hasHlsUrl = !!videoInfo.hlsUrl;
    const isHls = hasHlsUrl && !hlsFailed;
    const posterUrl = `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${videoInfo.thumbKey}`;
    const rawUrl = `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${videoInfo.rawKey}`;

    // Build the HLS URL
    let hlsVideoUrl = videoInfo.hlsUrl || '';
    if (hlsVideoUrl && hlsVideoUrl.endsWith('/master.m3u8')) {
        const parts = hlsVideoUrl.split('/');
        const prefix = parts[parts.length - 2];
        if (prefix && prefix.endsWith('_hls')) {
            const baseName = prefix.slice(0, -4);
            parts[parts.length - 1] = `${baseName}.m3u8`;
            hlsVideoUrl = parts.join('/');
        }
    }
    const hlsFinalUrl = `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${hlsVideoUrl}`;

    useEffect(() => {
        if (!videoRef.current) return;

        // If not using HLS, play the raw video directly
        if (!isHls) {
            const video = videoRef.current;
            video.src = rawUrl;
            video.load();
            if (autoplay) {
                // Try muted autoplay first (browsers allow this), then unmute
                video.muted = true;
                video.play().then(() => {
                    video.muted = false;
                }).catch(e => console.warn("Autoplay blocked:", e));
            }
            return;
        }

        // HLS playback path
        let hls;

        if (Hls.isSupported()) {
            hls = new Hls({
                debug: false,
                xhrSetup: function (xhr, url) {
                    xhr.withCredentials = false;
                }
            });
            hls.loadSource(hlsFinalUrl);
            hls.attachMedia(videoRef.current);
            hls.on(Hls.Events.MANIFEST_PARSED, function () {
                if (autoplay && videoRef.current) {
                    videoRef.current.muted = true;
                    videoRef.current.play().then(() => {
                        videoRef.current.muted = false;
                    }).catch(e => console.warn("Autoplay blocked:", e));
                }
            });
            hls.on(Hls.Events.ERROR, function (event, data) {
                if (data.fatal) {
                    console.warn("HLS fatal error, falling back to direct playback:", data.type);
                    hls.destroy();
                    setHlsFailed(true);
                }
            });
        } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari native HLS support
            videoRef.current.src = hlsFinalUrl;
            videoRef.current.addEventListener('loadedmetadata', function () {
                if (autoplay && videoRef.current) {
                    videoRef.current.muted = true;
                    videoRef.current.play().then(() => {
                        videoRef.current.muted = false;
                    }).catch(e => console.warn("Autoplay blocked:", e));
                }
            });
            videoRef.current.addEventListener('error', function () {
                console.warn("Native HLS failed, falling back to direct playback");
                setHlsFailed(true);
            });
        }

        return () => {
            if (hls) hls.destroy();
        };
    }, [isHls, hlsFinalUrl, rawUrl, autoplay]);

    // Single native <video> element for both paths
    return (
        <video
            ref={videoRef}
            controls={controls}
            playsInline
            poster={posterUrl}
            className="w-full h-full outline-none"
        />
    );
}
