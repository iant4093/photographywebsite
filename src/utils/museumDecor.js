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
    const place = (position, size, color, surface = 'wood', shape = 'box', rotation = [0, 0, 0], properties = {}) => {
        const [x, y, z] = position
        parts.push({
            position: [display.position[0] + x * Math.cos(yaw) + z * Math.sin(yaw), display.position[1] + y, display.position[2] - x * Math.sin(yaw) + z * Math.cos(yaw)],
            size, color, surface, shape,
            rotation: [rotation[0], yaw + rotation[1], rotation[2], 'YXZ'],
            displayId: display.id,
            ...properties,
        })
    }
    const paper = { roughness: 0.9, metalness: 0 }
    const cloth = { roughness: 0.86, metalness: 0 }
    let bookIndex = 0
    const book = (x, y, z, color, width = 0.52, height = 0.09, depth = 0.40, angle = 0) => {
        const objectId = `${display.id}-book-${bookIndex++}`
        const part = (dx, dy, dz, size, tone, properties = cloth, surface = 'ceramic') => {
            place([x + dx * Math.cos(angle) + dz * Math.sin(angle), y + dy, z - dx * Math.sin(angle) + dz * Math.cos(angle)], size, tone, surface, 'box', [0, angle, 0], { objectId, ...properties })
        }
        part(0, 0.009, 0, [width, 0.018, depth], color, { ...cloth, detail: 'book-cover', fineShade: 'underface' })
        part(0, height / 2, 0, [width - 0.036, height - 0.036, depth - 0.026], '#d8cab3', { ...paper, detail: 'book-paper', shape: 'page-block', fineShade: 'paper-edge' })
        part(0, height - 0.009, 0, [width, 0.018, depth], color, { ...cloth, detail: 'book-cover', fineShade: 'underface' })
        part(-width / 2 + 0.009, height / 2, 0, [0.018, height - 0.036, depth], color)
        // Thin page signatures and spine bands break up the solid blocks. They
        // stay below the upper cover, so the next book rests on a flat surface.
        for (const fraction of [0.38, 0.64]) {
            part(0.012, height * fraction, depth / 2 - 0.0128, [width - 0.066, 0.0015, 0.001], '#b5a990', paper)
        }
        for (const direction of [-1, 1]) {
            part(-width / 2 - 0.0005, height / 2, direction * depth * 0.32, [0.0015, height - 0.036, 0.009], '#b49b69', cloth)
        }
        part(0, height + 0.001, -depth * 0.15, [width * 0.47, 0.002, 0.012], '#b99960', cloth)
        part(0, height + 0.001, depth * 0.23, [width * 0.22, 0.002, 0.008], '#b99960', cloth)
    }

    if (display.kind === 'console') {
        const supportShadow = (position, size, color, angle = 0, round = false) => {
            place(position, [size[0], 1, size[1]], color, 'wood', round ? 'contact-circle' : 'contact-rectangle', [0, angle, 0], {
                detail: 'display-contact', uvFrame: { origin: display.position, yaw },
            })
        }
        // Slim, chamfered walnut casework and a low shelf form a repeatable
        // gallery console without a cabinet-sized obstacle in the room.
        place([0, 1.065, 0], [1.82, 0.10, 0.60], '#a18a72', 'wood', 'chamfer', [0, 0, 0], { fineShade: 'underface' })
        place([0, 0.265, 0], [1.58, 0.06, 0.47], '#b4967b', 'wood', 'chamfer', [0, 0, 0], { fineShade: 'underface' })
        for (const x of [-0.76, 0.76]) {
            for (const z of [-0.20, 0.20]) {
                place([x, 0.52, z], [0.075, 0.96, 0.075], '#b4967b', 'wood', 'chamfer', [0, 0, 0], { fineShade: 'joint' })
                place([x, 0.045, z], [0.085, 0.09, 0.085], '#a48754', 'brass', 'chamfer')
            }
        }
        for (const z of [-0.24, 0.24]) {
            place([0, 0.925, z], [1.52, 0.20, 0.05], '#a48970', 'wood', 'box', [0, 0, 0], { fineShade: 'joint' })
            place([0, 1.028, z], [1.54, 0.012, 0.015], '#af9058', 'brass')
        }
        for (const x of [-0.37, 0.37]) place([x, 0.936, 0.276], [0.09, 0.015, 0.02], '#b59a65', 'brass', 'chamfer')
        supportShadow([-0.47, 1.116, 0.015], [0.61, 0.46], '#a18a72', -0.065)
        supportShadow([0.17, 0.296, 0], [0.655, 0.379], '#b4967b', 0.055)
        supportShadow([0.51, 1.116, -0.035], [0.328, 0.328], '#a18a72', 0, true)
        supportShadow([0.16, 1.116, 0.04], [0.19, 0.19], '#a18a72', 0, true)
        book(-0.47, 1.115, 0.015, '#39545a', 0.55, 0.09, 0.42, -0.065)
        book(-0.455, 1.205, 0.015, display.variant % 2 ? '#82554a' : '#9a8059', 0.49, 0.078, 0.36, 0.045)
        book(0.17, 0.295, 0, '#6a4446', 0.62, 0.095, 0.36, 0.055)
        const vaseColor = ['#ded1b6', '#a3b6aa', '#c0a48e'][display.variant % 3]
        place([0.51, 1.115, -0.035], [0.21, 0.66, 0.21], vaseColor, 'ceramic', 'vase')
        place([0.16, 1.115, 0.04], [0.12, 0.36, 0.12], '#cfbf9f', 'ceramic', 'bud-vase')
        // A joinery reveal under each drawer and an inset top rail give the
        // shallow console a made object scale without increasing its bounds.
        place([0, 0.927, 0.266], [0.009, 0.17, 0.003], '#251d19')
        place([0, 0.837, 0.266], [1.43, 0.004, 0.003], '#251d19')
    } else if (display.kind === 'sculpture') {
        place([0, 0.055, 0], [0.78, 0.11, 0.66], '#9c826c', 'wood', 'chamfer')
        place([0, 0.63, 0], [0.52, 1.0, 0.46], '#d2c3a6', 'ceramic', 'chamfer')
        place([0, 0.14, 0], [0.60, 0.06, 0.54], '#a38755', 'brass', 'chamfer')
        place([0, 1.14, 0], [0.68, 0.10, 0.60], '#e0d2b7', 'ceramic', 'chamfer')
        place([0, 1.23, 0], [0.42, 0.08, 0.32], '#ac9981', 'wood', 'chamfer')
        // Concentric open forms read clearly in silhouette. The smaller ivory
        // ring stays within the larger bronze opening with no intersecting mesh.
        place([0, 1.707, 0], [0.31, 0.37, 0.62], '#ad8951', 'brass', 'ring', [0, 0.12, 0])
        place([0, 1.707, 0], [0.16, 0.20, 0.38], '#e4d5b8', 'ceramic', 'ring', [0, 0.12, 0])
        // The spacer enters the ivory ring's lower tube instead of merely
        // grazing its lowest vertex, keeping the connection clear at angles.
        place([0, 1.3975, 0], [0.032, 0.265, 0.032], '#af9058', 'brass')
        // Small, flush curator labels add human scale to the sculptural plinths.
        place([0, 0.995, 0.233], [0.30, 0.13, 0.012], '#302a24')
        place([-0.094, 1.022, 0.240], [0.057, 0.006, 0.002], '#b89b66', 'brass')
        place([0.025, 1.022, 0.240], [0.14, 0.005, 0.002], '#ded3be', 'ceramic', 'box', [0, 0, 0], paper)
        place([-0.018, 0.989, 0.240], [0.21, 0.004, 0.002], '#b9ad97', 'ceramic', 'box', [0, 0, 0], paper)
        place([-0.05, 0.972, 0.240], [0.145, 0.004, 0.002], '#b9ad97', 'ceramic', 'box', [0, 0, 0], paper)
    } else if (display.kind === 'reading-stand') {
        place([0, 0.04, 0], [0.68, 0.08, 0.50], '#a88d72', 'wood', 'chamfer')
        place([0, 0.59, -0.025], [0.034, 1.10, 0.034], '#a08350', 'brass', 'cylinder')
        const tilt = 0.34
        const tilted = (x, y, z, size, color, surface = 'wood', shape = 'box', roll = 0, properties = {}) => {
            place([x, 1.18 + y * Math.cos(tilt) - z * Math.sin(tilt), y * Math.sin(tilt) + z * Math.cos(tilt)], size, color, surface, shape, [tilt, 0, roll], properties)
        }
        tilted(0, 0, 0, [0.76, 0.045, 0.50], '#bba18b', 'wood', 'chamfer')
        tilted(0, 0.0315, 0, [0.59, 0.018, 0.40], '#48646a', 'ceramic', 'box', 0, cloth)
        for (const direction of [-1, 1]) {
            const roll = direction * 0.035
            const page = (x, y, z, size, color, properties = paper) => {
                tilted(direction * 0.14 + x * Math.cos(roll) - y * Math.sin(roll), 0.0525 + x * Math.sin(roll) + y * Math.cos(roll), z, size, color, 'ceramic', 'box', roll, properties)
            }
            page(0, 0, 0, [0.265, 0.014, 0.368], '#e4d8bd', { ...paper, detail: 'catalog-page' })
            if (direction < 0) {
                // A quiet landscape plate and caption, physically separated
                // from the opposing page by the recessed binding gutter.
                page(0, 0.008, -0.025, [0.209, 0.002, 0.22], '#718990')
                page(0, 0.0095, 0.013, [0.209, 0.001, 0.094], '#41565a')
                page(-0.038, 0.0105, 0.029, [0.133, 0.001, 0.062], '#807865')
                page(-0.026, 0.008, 0.12, [0.158, 0.002, 0.004], '#857b67')
                page(-0.053, 0.008, 0.135, [0.103, 0.002, 0.003], '#9c927e')
            } else {
                page(-0.012, 0.008, -0.114, [0.18, 0.002, 0.014], '#554e43')
                page(-0.04, 0.008, -0.089, [0.122, 0.002, 0.007], '#8b7959')
                for (let line = 0; line < 6; line += 1) {
                    page(-0.005, 0.008, -0.026 + line * 0.024, [0.195 - line % 3 * 0.017, 0.002, 0.003], '#9b917d')
                }
            }
        }
        tilted(0, 0.043, 0.022, [0.012, 0.004, 0.39], '#8c4a43', 'ceramic', 'box', 0, { ...cloth, detail: 'catalog-bookmark' })
        tilted(0, 0.037, 0.235, [0.71, 0.072, 0.026], '#b3965f', 'brass', 'chamfer')
    }
    return parts
}

export function museumReadingProps(layout) {
    const parts = []
    let support
    const place = (position, size, color, rotation = [0, 0, 0], shape = 'box', properties = {}) => {
        parts.push({ position, size, color, rotation, shape, support, ...properties })
    }
    const book = (x, y, z, width, depth, height, color, angle = 0) => {
        const rotate = (dx, dz) => [x + dx * Math.cos(angle) + dz * Math.sin(angle), z - dx * Math.sin(angle) + dz * Math.cos(angle)]
        const part = (dx, dy, dz, size, tone, properties = {}) => {
            const [px, pz] = rotate(dx, dz)
            place([px, y + dy, pz], size, tone, [0, angle, 0], 'box', properties)
        }
        part(0, 0.009, 0, [width, 0.018, depth], color, { fineShade: 'underface' })
        part(0, height / 2, 0, [width - 0.045, height - 0.036, depth - 0.035], '#d9cdb5', { shape: 'page-block', fineShade: 'paper-edge', roughness: 0.9 })
        part(0, height - 0.009, 0, [width, 0.018, depth], color, { fineShade: 'underface' })
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

    // A worn metal-and-leather camera, with its strap resting on the desk,
    // makes reception feel inhabited. It still shares the reading-detail draw.
    const metal = { roughness: 0.32, metalness: 0.78 }
    const leather = { roughness: 0.84, metalness: 0, fineShade: 'underface' }
    const camera = (position, size, color, shape = 'box', rotation = [0, 0, 0], properties = leather) => {
        place([deskX + 1.42 + position[0], deskTop + position[1], deskZ + position[2]], size, color, rotation, shape, { detail: 'reception-camera', ...properties })
    }
    camera([0, 0.012, -0.01], [0.565, 0.024, 0.23], '#a99e89', 'chamfer', [0, 0, 0], metal)
    camera([0, 0.16, -0.01], [0.55, 0.27, 0.22], '#38352f', 'chamfer')
    camera([0, 0.305, -0.01], [0.565, 0.02, 0.23], '#c0b49c', 'chamfer', [0, 0, 0], metal)
    for (const direction of [-1, 1]) {
        camera([direction * 0.205, 0.16, 0.109], [0.108, 0.205, 0.018], '#272925', 'chamfer')
        camera([direction * 0.26, 0.16, 0.12], [0.003, 0.19, 0.002], '#726956')
        camera([direction * 0.29, 0.235, -0.042], [0.020, 0.020, 0.05], '#aba18b', 'lens-ring', [0, 0, 0], metal)
    }
    camera([-0.045, 0.34, -0.005], [0.17, 0.05, 0.14], '#9c9482', 'chamfer', [0, 0, 0], metal)
    camera([-0.045, 0.341, 0.067], [0.097, 0.027, 0.006], '#253637', 'box', [0, 0, 0], { roughness: 0.15, metalness: 0 })
    camera([0.18, 0.327, -0.025], [0.043, 0.023, 0.043], '#baae94', 'cylinder', [0, 0, 0], metal)
    camera([0.18, 0.341, -0.025], [0.014, 0.007, 0.014], '#645e50', 'cylinder', [0, 0, 0], metal)
    for (const x of [-0.076, -0.014]) camera([x, 0.368, -0.006], [0.011, 0.006, 0.075], '#c3b9a4', 'box', [0, 0, 0], metal)
    for (const [z, radius, depth, color] of [
        [0.145, 0.122, 0.11, '#57564c'], [0.205, 0.118, 0.04, '#282e2a'],
        [0.195, 0.119, 0.006, '#9f9988'], [0.215, 0.119, 0.006, '#9f9988'],
        [0.24, 0.115, 0.04, '#282d2a'],
    ]) camera([0, 0.16, z], [radius, depth, radius], color, 'cylinder', [Math.PI / 2, 0, 0], metal)
    camera([0, 0.16, 0.263], [0.096, 0.006, 0.096], '#253e40', 'cylinder', [Math.PI / 2, 0, 0], { roughness: 0.12, metalness: 0 })
    camera([0, 0.16, 0.265], [0.105, 0.105, 0.1], '#b6ad96', 'lens-ring', [0, 0, 0], { ...metal, fineShade: 'lens' })
    for (let index = -3; index <= 3; index += 1) {
        const angle = index * 0.22
        camera([Math.sin(angle) * 0.104, 0.16 + Math.cos(angle) * 0.104, 0.272], [0.003, index === 0 ? 0.008 : 0.005, 0.0015], '#eee2c8', 'box', [0, 0, -angle], { roughness: 0.75, metalness: 0 })
    }
    const strapPath = [
        [-0.29, 0.235, -0.042], [-0.35, 0.035, -0.165], [-0.32, 0.006, -0.28],
        [-0.12, 0.006, -0.395], [0.26, 0.006, -0.4], [0.41, 0.006, -0.285],
        [0.36, 0.035, -0.16], [0.29, 0.235, -0.042],
    ]
    for (let index = 1; index < strapPath.length; index += 1) {
        const a = strapPath[index - 1]
        const b = strapPath[index]
        const dx = b[0] - a[0]
        const dy = b[1] - a[1]
        const dz = b[2] - a[2]
        camera(a.map((value, axis) => (value + b[axis]) / 2), [0.032, 0.006, Math.hypot(dx, dy, dz) + 0.005], '#684b37', 'box', [-Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(dx, dz), 0, 'YXZ'], { ...leather, detail: 'camera-strap' })
    }
    // A small contact sheet uses opaque printed blocks, so its nine studies
    // need no photo requests, alpha layers or dedicated material.
    const sheetAngle = -0.09
    const sheet = (x, y, z, size, color) => {
        place([deskX + 1.905 + x * Math.cos(sheetAngle) + z * Math.sin(sheetAngle), deskTop + y, deskZ + 0.245 - x * Math.sin(sheetAngle) + z * Math.cos(sheetAngle)], size, color, [0, sheetAngle, 0], 'box', { detail: 'contact-sheet', roughness: 0.93, metalness: 0, fineShade: 'underface' })
    }
    sheet(0, 0.002, 0, [0.39, 0.003, 0.51], '#d8cfba')
    sheet(-0.063, 0.004, -0.222, [0.207, 0.001, 0.009], '#565d56')
    sheet(0.112, 0.004, -0.222, [0.063, 0.001, 0.006], '#927754')
    const printColors = ['#7f9290', '#869895', '#9c9987', '#898879', '#87929a', '#9b9486', '#75887f', '#8c9c9d', '#8c8980']
    for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
        const x = (column - 1) * 0.111
        const z = -0.134 + row * 0.124
        sheet(x, 0.004, z, [0.101, 0.001, 0.111], '#343c38')
        sheet(x, 0.005, z - 0.004, [0.092, 0.001, 0.095], printColors[row * 3 + column])
        sheet(x, 0.006, z + 0.022, [0.092, 0.001, 0.043], row % 2 ? '#4f645d' : '#536462')
        sheet(x - 0.013, 0.007, z + 0.034, [0.066, 0.001, 0.019], column % 2 ? '#7e7665' : '#657568')
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
