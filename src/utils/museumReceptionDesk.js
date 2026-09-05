// The collision body, rendered joinery and tabletop props share this assembly.
// Vertical dimensions are authored from the floor so lowering the countertop
// never pushes an old, taller plinth or facade into the floor.
export function createMuseumReceptionDesk() {
    const height = 1.05
    const centerY = height / 2
    const localY = floorY => floorY - centerY
    const desk = {
        id: 'reception-desk',
        position: [0, centerY, 6.4],
        size: [4.3, height, 1.3],
        base: { position: [0, localY(0.07), -0.02], size: [3.52, 0.14, 0.92], radius: 0.045 },
        countertop: { position: [0, localY(height - 0.05), 0], size: [4.48, 0.10, 1.42], radius: 0.045 },
        facade: { bottomY: localY(0.175), topY: localY(height - 0.135), depth: 1.08, bevel: 0.035 },
        panel: { position: [0, localY(0.53), 0.592], size: [3.16, 0.56, 0.055], radius: 0.035 },
        insert: { position: [0, localY(0.53), 0.626], size: [3.0, 0.45, 0.018], radius: 0.025 },
        flutes: { xs: [-1.86, -1.56, -1.26, 1.26, 1.56, 1.86], y: localY(0.55), z: 0.565, height: 0.64, radius: 0.028 },
        label: { position: [0, localY(0.55), 0.642], size: [2.76, 0.39] },
    }
    desk.surfaceY = desk.position[1] + desk.countertop.position[1] + desk.countertop.size[1] / 2
    return desk
}
