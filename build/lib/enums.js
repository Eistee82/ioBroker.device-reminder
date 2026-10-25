export function enumLabel(id, name, lang) {
    if (typeof name === "string" && name) {
        return name;
    }
    if (name && typeof name === "object") {
        const n = name;
        return n[lang] || n.en || id.split(".").pop() || id;
    }
    return id.split(".").pop() || id;
}
export function membershipOf(members, kind, objectId) {
    return Object.entries(members)
        .filter(([id, list]) => id.startsWith(`enum.${kind}.`) && list.includes(objectId))
        .map(([id]) => id)
        .sort();
}
export function planEnumUpdate(members, kind, objectId, selected) {
    const current = membershipOf(members, kind, objectId);
    const wanted = selected.filter(id => id.startsWith(`enum.${kind}.`) && id in members);
    return {
        add: wanted.filter(id => !current.includes(id)),
        remove: current.filter(id => !wanted.includes(id)),
    };
}
//# sourceMappingURL=enums.js.map