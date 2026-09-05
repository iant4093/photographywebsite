// Display furniture stays in three shared draws while paper, cloth, ceramic,
// and metal retain their own physical response. Values are authored once on
// the geometry, not recomputed while the visitor walks.
export function applyMuseumDisplayResponse(shader) {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `
        #include <common>
        attribute float museumRoughness;
        attribute float museumMetalness;
        varying vec2 vMuseumSurfaceResponse;
    `).replace('#include <begin_vertex>', `
        #include <begin_vertex>
        vMuseumSurfaceResponse = vec2(museumRoughness, museumMetalness);
    `)
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
        #include <common>
        varying vec2 vMuseumSurfaceResponse;
    `).replace('#include <roughnessmap_fragment>', `
        #include <roughnessmap_fragment>
        roughnessFactor *= vMuseumSurfaceResponse.x;
    `).replace('#include <metalnessmap_fragment>', `
        #include <metalnessmap_fragment>
        metalnessFactor *= vMuseumSurfaceResponse.y;
    `)
}
