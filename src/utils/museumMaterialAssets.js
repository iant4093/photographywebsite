const TEXTURE_ROOT = '/assets/museum/textures'

// sRGB only for *Color. All normal/roughness maps are linear data; roughness is
// sampled from G by Three.js. Monochrome delivery files expand equally to RGB.
export const MUSEUM_MATERIAL_TEXTURES = Object.freeze({
    woodColor: `${TEXTURE_ROOT}/wood_floor_diff_1024.jpg`,
    woodNormal: `${TEXTURE_ROOT}/wood_floor_nor_gl_1024.jpg`,
    woodRoughness: `${TEXTURE_ROOT}/wood_floor_rough_1024.jpg`,
    joineryColor: `${TEXTURE_ROOT}/joinery_wood_albedo_512.jpg`,
    joineryNormal: `${TEXTURE_ROOT}/joinery_wood_normal_512.jpg`,
    joineryRoughness: `${TEXTURE_ROOT}/joinery_wood_roughness_512.jpg`,
    plasterNormal: `${TEXTURE_ROOT}/fine_plaster_normal_512.jpg`,
    plasterRoughness: `${TEXTURE_ROOT}/fine_plaster_roughness_512.png`,
    brassRoughness: `${TEXTURE_ROOT}/brushed_brass_roughness_256.png`,
    ceramicRoughness: `${TEXTURE_ROOT}/ceramic_roughness_256.png`,
    fabricNormal: `${TEXTURE_ROOT}/fabric_weave_normal_256.png`,
    fabricRoughness: `${TEXTURE_ROOT}/fabric_weave_roughness_256.png`,
})

// Physical source widths. Use world-space UVs/repeats where possible; scaling a
// box's face independently should not stretch plank seams over furniture.
export const MUSEUM_MATERIAL_TILE_METERS = Object.freeze({
    wood: 1.7, // nine ~19cm oak floorboards; grain runs along V
    joinery: 1, // seamless continuous walnut veneer; grain runs along U
    plaster: 0.5,
    brass: 0.16,
    ceramic: 0.25,
    fabric: 0.12,
})

// Captured means aid material tuning: source scans encode absolute roughness;
// authored micro-detail maps are near-white multipliers for the material value.
export const MUSEUM_MATERIAL_ROUGHNESS_MEANS = Object.freeze({
    wood: 0.471,
    joinery: 0.556,
    plaster: 0.878,
    brass: 0.871,
    ceramic: 0.898,
    fabric: 0.937,
})
