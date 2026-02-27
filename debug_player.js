const url = "albums/test-a33417d5/FoggyScenesAnimation_hls/FoggyScenesAnimation_1080p.m3u8";
let videoUrl = url;
if (videoUrl && videoUrl.endsWith('/master.m3u8')) {
    const parts = videoUrl.split('/');
    const prefix = parts[parts.length - 2];
    if (prefix && prefix.endsWith('_hls')) {
        const baseName = prefix.slice(0, -4);
        parts[parts.length - 1] = `${baseName}.m3u8`;
        videoUrl = parts.join('/');
    }
}
console.log("Input:", url);
console.log("Output:", videoUrl);
