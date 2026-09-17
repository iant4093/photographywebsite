// Copyright (c) 2026 Ian Truong. MIT License; see legal/raw-bindings-LICENSE.txt.
// Public RawProcessor adapter for the rawconvert-wasm JavaScript worker API.
#include <emscripten/bind.h>
#include <libraw/libraw.h>
#include <fstream>
#include <string>

class RawProcessor {
    LibRaw raw;
    bool loaded = false;
    bool unpacked = false;
    libraw_processed_image_t* pixels = nullptr;
    std::string error;
    bool check(int result) {
        if (result == LIBRAW_SUCCESS) return true;
        error = libraw_strerror(result);
        return false;
    }
public:
    ~RawProcessor() { reset(); }
    void reset() {
        if (pixels) LibRaw::dcraw_clear_mem(pixels);
        pixels = nullptr;
        raw.recycle();
        loaded = unpacked = false;
        error.clear();
    }
    bool loadFromFile(const std::string& path) {
        reset();
        loaded = check(raw.open_file(path.c_str()));
        return loaded;
    }
    bool isLoaded() const { return loaded; }
    std::string getLastError() const { return error; }
    emscripten::val getMetadata() const {
        auto metadata = emscripten::val::object();
        metadata.set("cameraMake", std::string(raw.imgdata.idata.make));
        metadata.set("cameraModel", std::string(raw.imgdata.idata.model));
        metadata.set("lensModel", std::string(raw.imgdata.lens.Lens));
        metadata.set("iso", raw.imgdata.other.iso_speed);
        metadata.set("shutterSpeed", raw.imgdata.other.shutter);
        metadata.set("aperture", raw.imgdata.other.aperture);
        metadata.set("focalLength", raw.imgdata.other.focal_len);
        metadata.set("width", raw.imgdata.sizes.width);
        metadata.set("height", raw.imgdata.sizes.height);
        metadata.set("librawVersion", std::string(LibRaw::version()));
        return metadata;
    }
    bool process(emscripten::val options) {
        if (!loaded) { error = "No RAW file loaded"; return false; }
        if (pixels) { LibRaw::dcraw_clear_mem(pixels); pixels = nullptr; }
        auto& p = raw.imgdata.params;
        p.output_color = options["colorSpace"].as<int>();
        p.user_qual = options["interpolation"].as<int>();
        p.output_bps = options["outputBps"].as<int>();
        p.half_size = options["halfSize"].as<bool>();
        p.use_auto_wb = options["autoWhiteBalance"].as<bool>();
        p.use_camera_wb = options["cameraWhiteBalance"].as<bool>();
        p.bright = options["brightness"].as<float>();
        p.highlight = options["highlightMode"].as<int>();
        p.threshold = options["noiseReduction"].as<float>();
        p.med_passes = options["medianPasses"].as<int>();
        if (!unpacked) {
            if (!check(raw.unpack())) return false;
            unpacked = true;
        }
        if (!check(raw.dcraw_process())) return false;
        int result = 0;
        pixels = raw.dcraw_make_mem_image(&result);
        if (!check(result) || !pixels) return false;
        if (pixels->type != LIBRAW_IMAGE_BITMAP || pixels->colors != 3) {
            error = "The RAW decoder did not produce RGB bitmap data";
            return false;
        }
        return true;
    }
    bool exportRawPixels(const std::string& path) {
        if (!pixels) { error = "No processed pixels"; return false; }
        std::ofstream out(path, std::ios::binary);
        // rawconvert-wasm expects an 11-byte little-endian header. WASM is LE.
        uint32_t width = pixels->width, height = pixels->height;
        uint16_t bits = pixels->bits;
        uint8_t colors = pixels->colors;
        out.write(reinterpret_cast<char*>(&width), 4);
        out.write(reinterpret_cast<char*>(&height), 4);
        out.write(reinterpret_cast<char*>(&bits), 2);
        out.write(reinterpret_cast<char*>(&colors), 1);
        out.write(reinterpret_cast<char*>(pixels->data), pixels->data_size);
        if (!out.good()) { error = "Could not export processed pixels"; return false; }
        return true;
    }
    bool extractThumbnail(const std::string& path) {
        if (!loaded || !check(raw.unpack_thumb())) return false;
        return check(raw.dcraw_thumb_writer(path.c_str()));
    }
    emscripten::val getThumbnailInfo() const {
        auto info = emscripten::val::object();
        info.set("width", raw.imgdata.thumbnail.twidth);
        info.set("height", raw.imgdata.thumbnail.theight);
        info.set("format", raw.imgdata.thumbnail.tformat == LIBRAW_THUMBNAIL_JPEG ? 0 : 1);
        return info;
    }
};

EMSCRIPTEN_BINDINGS(photography_raw_decoder) {
    emscripten::class_<RawProcessor>("RawProcessor")
        .constructor<>()
        .function("loadFromFile", &RawProcessor::loadFromFile)
        .function("isLoaded", &RawProcessor::isLoaded)
        .function("getLastError", &RawProcessor::getLastError)
        .function("getMetadata", &RawProcessor::getMetadata)
        .function("process", &RawProcessor::process)
        .function("exportRawPixels", &RawProcessor::exportRawPixels)
        .function("extractThumbnail", &RawProcessor::extractThumbnail)
        .function("getThumbnailInfo", &RawProcessor::getThumbnailInfo)
        .function("reset", &RawProcessor::reset);
}
