// Every object sits on existing furniture: adding gallery detail must not
// introduce new obstacles into the walking route or overlap upholstery studs.
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
