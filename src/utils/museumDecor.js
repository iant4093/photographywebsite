// Reading accessories remain on existing supports. Floor-standing display
// furniture below exposes the same complete bounds to rendering and collision.
export function museumGalleryDisplays(layout) {
    const displays = []
    const add = (id, kind, position, rotationY, size, roomId = null, variant = 0) => {
        displays.push({ id, kind, position, rotationY, size, roomId, variant })
    }
    for (const [index, plant] of (layout.dressing?.hallPlants || []).entries()) {
        const side = Math.sign(plant.position[0]) || -1
        add(`hall-console-${index}`, 'console', [-side * 4.08, 0, plant.position[2]], side * Math.PI / 2, [1.88, 1.87, 0.64], null, index)
        // Existing plants sit 5.3m before their doorway. This plinth occupies
        // the solid panel 5.2m after it, with the full arch and aisle untouched.
        add(`hall-sculpture-${index}`, 'sculpture', [side * 4.08, 0, plant.position[2] - 10.5], -side * Math.PI / 2, [0.82, 2.23, 0.70], null, index)
    }
    for (const [roomIndex, room] of layout.rooms.entries()) {
        add(`${room.id}-console`, 'console', [room.outerX - room.side * 0.72, 0, room.centerZ], -room.side * Math.PI / 2, [1.88, 1.87, 0.64], room.id, roomIndex)
        const rowXs = [...new Set(room.paintings.map(painting => painting.position[0]))]
        const gaps = rowXs.slice(0, -1).map((x, index) => (x + rowXs[index + 1]) / 2)
        const standCount = Math.min(4, Math.floor(gaps.length / 3))
        for (let index = 0; index < standCount; index += 1) {
            const gapIndex = Math.min(gaps.length - 1, Math.floor((index + 0.5) * gaps.length / standCount))
            const direction = (roomIndex + index) % 2 === 0 ? -1 : 1
            add(`${room.id}-reading-stand-${index}`, 'reading-stand', [gaps[gapIndex], 0, room.centerZ + direction * (room.width / 2 - 0.82)], direction < 0 ? 0 : Math.PI, [0.84, 1.43, 0.66], room.id, roomIndex + index)
        }
    }
    return displays
}

export function museumGalleryDisplayParts(display) {
    const parts = []
    const yaw = display.rotationY || 0
    const place = (position, size, color, surface = 'wood', shape = 'box', rotation = [0, 0, 0]) => {
        const [x, y, z] = position
        parts.push({
            position: [display.position[0] + x * Math.cos(yaw) + z * Math.sin(yaw), display.position[1] + y, display.position[2] - x * Math.sin(yaw) + z * Math.cos(yaw)],
            size, color, surface, shape,
            rotation: [rotation[0], yaw + rotation[1], rotation[2], 'YXZ'],
            displayId: display.id,
        })
    }
    const book = (x, y, z, color, width = 0.52, height = 0.09, depth = 0.40) => {
        place([x, y + 0.009, z], [width, 0.018, depth], color)
        place([x, y + height / 2, z], [width - 0.025, height - 0.03, depth - 0.02], '#d8cab3')
        place([x, y + height - 0.009, z], [width, 0.018, depth], color)
        place([x - width / 2 + 0.012, y + height / 2, z], [0.024, height - 0.03, depth], color)
        place([x, y + height + 0.001, z - 0.06], [width * 0.47, 0.003, 0.014], '#b99960', 'brass')
    }

    if (display.kind === 'console') {
        // Slim, chamfered walnut casework and a low shelf form a repeatable
        // gallery console without a cabinet-sized obstacle in the room.
        place([0, 1.065, 0], [1.82, 0.10, 0.60], '#3a2920', 'wood', 'chamfer')
        place([0, 0.265, 0], [1.58, 0.06, 0.47], '#493328', 'wood', 'chamfer')
        for (const x of [-0.76, 0.76]) {
            for (const z of [-0.20, 0.20]) {
                place([x, 0.52, z], [0.075, 0.96, 0.075], '#493328', 'wood', 'chamfer')
                place([x, 0.045, z], [0.085, 0.09, 0.085], '#a48754', 'brass', 'chamfer')
            }
        }
        for (const z of [-0.24, 0.24]) {
            place([0, 0.925, z], [1.52, 0.20, 0.05], '#473025')
            place([0, 1.028, z], [1.54, 0.012, 0.015], '#af9058', 'brass')
        }
        for (const x of [-0.37, 0.37]) place([x, 0.936, 0.276], [0.09, 0.015, 0.02], '#b59a65', 'brass', 'chamfer')
        book(-0.47, 1.115, 0.015, '#39545a', 0.55, 0.09, 0.42)
        book(-0.45, 1.208, 0.018, display.variant % 2 ? '#82554a' : '#9a8059', 0.49, 0.078, 0.38)
        book(0.17, 0.295, 0, '#6a4446', 0.62, 0.095, 0.36)
        const vaseColor = ['#ded1b6', '#a3b6aa', '#c0a48e'][display.variant % 3]
        place([0.51, 1.115, -0.035], [0.21, 0.66, 0.21], vaseColor, 'ceramic', 'vase')
        place([0.16, 1.115, 0.04], [0.12, 0.39, 0.12], '#cfbf9f', 'ceramic', 'vase')
    } else if (display.kind === 'sculpture') {
        place([0, 0.055, 0], [0.78, 0.11, 0.66], '#40312a', 'wood', 'chamfer')
        place([0, 0.63, 0], [0.52, 1.0, 0.46], '#d2c3a6', 'ceramic', 'chamfer')
        place([0, 0.14, 0], [0.60, 0.06, 0.54], '#a38755', 'brass', 'chamfer')
        place([0, 1.14, 0], [0.68, 0.10, 0.60], '#e0d2b7', 'ceramic', 'chamfer')
        place([0, 1.23, 0], [0.42, 0.08, 0.32], '#51463a', 'wood', 'chamfer')
        // Concentric open forms read clearly in silhouette. The smaller ivory
        // ring stays within the larger bronze opening with no intersecting mesh.
        place([0, 1.707, 0], [0.31, 0.37, 0.62], '#ad8951', 'brass', 'ring', [0, 0.12, 0])
        place([0, 1.707, 0], [0.16, 0.20, 0.38], '#e4d5b8', 'ceramic', 'ring', [0, 0.12, 0])
        // The spacer enters the ivory ring's lower tube instead of merely
        // grazing its lowest vertex, keeping the connection clear at angles.
        place([0, 1.3975, 0], [0.032, 0.265, 0.032], '#af9058', 'brass')
    } else if (display.kind === 'reading-stand') {
        place([0, 0.04, 0], [0.68, 0.08, 0.50], '#46372b', 'wood', 'chamfer')
        place([0, 0.59, -0.025], [0.034, 1.10, 0.034], '#a08350', 'brass', 'cylinder')
        const tilt = 0.34
        const tilted = (x, y, z, size, color, surface = 'wood', shape = 'box') => {
            place([x, 1.18 + y * Math.cos(tilt) - z * Math.sin(tilt), y * Math.sin(tilt) + z * Math.cos(tilt)], size, color, surface, shape, [tilt, 0, 0])
        }
        tilted(0, 0, 0, [0.76, 0.045, 0.50], '#513a28', 'wood', 'chamfer')
        tilted(0, 0.031, 0.008, [0.54, 0.018, 0.39], '#48646a')
        tilted(0, 0.047, 0, [0.49, 0.012, 0.35], '#e4d8bd')
        tilted(0, 0.055, -0.092, [0.34, 0.003, 0.02], '#594f40')
        for (let line = 0; line < 4; line += 1) {
            tilted(0, 0.055, -0.01 + line * 0.037, [0.32 - line % 2 * 0.035, 0.003, 0.006], '#9b917d')
        }
        tilted(0, 0.037, 0.235, [0.71, 0.072, 0.026], '#b3965f', 'brass', 'chamfer')
    }
    return parts
}

export function museumReadingProps(layout) {
    const parts = []
    let support
    const place = (position, size, color, rotation = [0, 0, 0], shape = 'box') => {
        parts.push({ position, size, color, rotation, shape, support })
    }
    const book = (x, y, z, width, depth, height, color, angle = 0) => {
        const rotate = (dx, dz) => [x + dx * Math.cos(angle) + dz * Math.sin(angle), z - dx * Math.sin(angle) + dz * Math.cos(angle)]
        const part = (dx, dy, dz, size, tone) => {
            const [px, pz] = rotate(dx, dz)
            place([px, y + dy, pz], size, tone, [0, angle, 0])
        }
        part(0, 0.009, 0, [width, 0.018, depth], color)
        part(0, height / 2, 0, [width - 0.045, height - 0.036, depth - 0.035], '#d9cdb5')
        part(0, height - 0.009, 0, [width, 0.018, depth], color)
        part(-width / 2 + 0.012, height / 2, 0, [0.024, height - 0.036, depth], color)
        part(0, height + 0.002, -depth * 0.12, [width * 0.52, 0.004, 0.022], '#b89b61')
        part(0, height + 0.002, depth * 0.24, [width * 0.26, 0.004, 0.013], '#b89b61')
    }

    const [deskX, deskY, deskZ] = layout.desk.position
    support = { id: 'reception', position: [deskX, deskY + 0.82, deskZ], rotationY: 0, size: [layout.desk.size[0] + 0.18, layout.desk.size[2] + 0.12] }
    const deskTop = support.position[1]
    book(deskX - 1.36, deskTop, deskZ - 0.01, 0.62, 0.83, 0.095, '#32474e', -0.08)
    book(deskX - 1.34, deskTop + 0.099, deskZ, 0.57, 0.76, 0.09, '#75484a', 0.06)
    book(deskX - 1.35, deskTop + 0.193, deskZ, 0.54, 0.73, 0.075, '#a39577', -0.025)

    // An open guestbook and its pen give reception a small human presence.
    place([deskX + 0.08, deskTop + 0.012, deskZ + 0.02], [0.98, 0.024, 0.65], '#43322a')
    for (const direction of [-1, 1]) {
        place([deskX + 0.08 + direction * 0.24, deskTop + 0.034, deskZ + 0.02], [0.455, 0.022, 0.615], '#e5dcc9')
        for (let line = 0; line < 5; line += 1) {
            place([deskX + 0.08 + direction * 0.24, deskTop + 0.046, deskZ - 0.14 + line * 0.068], [0.30 - (line % 3) * 0.04, 0.002, 0.008], '#a19580')
        }
    }
    place([deskX + 0.77, deskTop + 0.014, deskZ + 0.04], [0.025, 0.025, 0.36], '#3b3833', [0, -0.24, 0])
    place([deskX + 0.73, deskTop + 0.014, deskZ + 0.2], [0.025, 0.025, 0.047], '#b49b61', [0, -0.24, 0])

    // A compact vintage camera faces arriving visitors; all three lens rings
    // share the same merged geometry/material as the books and guestbook.
    place([deskX + 1.42, deskTop + 0.15, deskZ - 0.01], [0.55, 0.30, 0.22], '#302f2b')
    place([deskX + 1.42, deskTop + 0.315, deskZ - 0.01], [0.56, 0.03, 0.23], '#a29881')
    place([deskX + 1.42, deskTop + 0.357, deskZ - 0.045], [0.17, 0.055, 0.11], '#464640')
    place([deskX + 1.60, deskTop + 0.346, deskZ - 0.01], [0.055, 0.031, 0.055], '#baa883')
    for (const [z, radius, depth, color] of [[0.15, 0.122, 0.15, '#524c3e'], [0.24, 0.111, 0.03, '#a69a7d'], [0.258, 0.092, 0.008, '#263e42']]) {
        place([deskX + 1.42, deskTop + 0.15, deskZ + z], [radius, depth, radius], color, [Math.PI / 2, 0, 0], 'cylinder')
    }

    for (const room of layout.rooms) {
        const bench = room.benches[0]
        if (!bench) continue
        const [width, height, depth] = bench.size
        const angle = bench.rotationY || 0
        const top = bench.position[1] + height * 0.58
        const z = depth / 2 - 0.49
        support = { id: bench.id, position: [0, top, 0], rotationY: 0, size: [width, depth] }
        const start = parts.length
        book(0, top, z, 0.60, 0.48, 0.078, '#334c51', -0.045)
        book(0.012, top + 0.082, z, 0.56, 0.44, 0.069, '#a58c67', 0.055)
        for (const part of parts.slice(start)) {
            const [x, y, localZ] = part.position
            part.position = [bench.position[0] + x * Math.cos(angle) + localZ * Math.sin(angle), y, bench.position[2] - x * Math.sin(angle) + localZ * Math.cos(angle)]
            part.rotation[1] += angle
        }
        support.position = [bench.position[0], top, bench.position[2]]
        support.rotationY = angle
    }
    return parts
}
