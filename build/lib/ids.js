const UMLAUTS = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };
export function sanitizeId(name) {
    const id = name
        .toLowerCase()
        .replace(/[äöüß]/g, ch => UMLAUTS[ch])
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
    return id === "" ? "device" : id;
}
export function allocateDeviceId(name, existingIds) {
    const base = sanitizeId(name);
    if (!existingIds.has(base)) {
        return base;
    }
    let n = 2;
    while (existingIds.has(`${base}_${n}`)) {
        n++;
    }
    return `${base}_${n}`;
}
//# sourceMappingURL=ids.js.map