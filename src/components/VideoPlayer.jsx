import React, { useEffect, useRef } from 'react'
import ReactPlayer from 'react-player'
import Hls from 'hls.js'

export default function VideoPlayer({ videoInfo, autoplay = true, controls = true }) {
    const videoRef = useRef(null)

    const isHls = !!videoInfo.hlsUrl;
    const posterUrl = `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${videoInfo.thumbKey}`;

    let videoUrl = isHls ? videoInfo.hlsUrl : videoInfo.rawKey;
    if (videoUrl && videoUrl.endsWith('/master.m3u8')) {
        const parts = videoUrl.split('/');
        const prefix = parts[parts.length - 2];
        if (prefix && prefix.endsWith('_hls')) {
            const baseName = prefix.slice(0, -4);
            parts[parts.length - 1] = `${baseName}.m3u8`;
            videoUrl = parts.join('/');
        }
    }
    const finalUrl = `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${videoUrl}`;
    const rawUrl = `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${videoInfo.rawKey}`;

    useEffect(() => {
        if (!isHls || !videoRef.current) return;

        let hls;

        if (Hls.isSupported()) {
            hls = new Hls({
                debug: false,
                xhrSetup: function (xhr, url) {
                    xhr.withCredentials = false;
                }
            });
            hls.loadSource(finalUrl);
            hls.attachMedia(videoRef.current);
            hls.on(Hls.Events.MANIFEST_PARSED, function () {
                if (autoplay && videoRef.current) {
                    videoRef.current.play().catch(e => console.warn("Autoplay blocked:", e));
                }
            });
            hls.on(Hls.Events.ERROR, function (event, data) {
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.error("fatal network error encountered, try to recover");
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.error("fatal media error encountered, try to recover");
                            hls.recoverMediaError();
                            break;
                        default:
                            hls.destroy();
                            break;
                    }
                }
            });
        } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
            videoRef.current.src = finalUrl;
            videoRef.current.addEventListener('loadedmetadata', function () {
                if (autoplay && videoRef.current) {
                    videoRef.current.play().catch(e => console.warn("Autoplay blocked:", e));
                }
            });
        }

        return () => {
            if (hls) hls.destroy();
        };
    }, [isHls, finalUrl, autoplay]);

    if (!isHls) {
        return (
            <ReactPlayer
                url={rawUrl}
                controls={controls}
                playing={autoplay}
                muted={true}
                light={posterUrl}
                width="100%"
                height="100%"
                style={{ position: 'absolute', top: 0, left: 0 }}
            />
        );
    }

    return (
        <video
            ref={videoRef}
            controls={controls}
            muted
            playsInline
            poster={posterUrl}
            className="w-full h-full outline-none"
        />
    );
}
