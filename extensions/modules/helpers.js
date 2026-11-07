// Pure identity, accelerator, and mask-rect helpers shared by the shell and
// preferences processes. Anything that needs extension state lives on
// PlaidCore or a subsystem class.

export const LAYOUT_NAMES = {
    'dwindle': 'Dwindle',
    'spiral': 'Spiral',
    'master-stack': 'Master-stack',
    'centered-master-stack': 'Centered Master-stack',
    'floating': 'Floating',
};

// What a layout is, by name: the one place a layout name is compared.
// Spiral is dwindle with 50/50 splits, Hyprland-style insertion and rules,
// and its own drag and animation.
const LAYOUT_TRAITS = {
    'dwindle': { bsp: true, spiral: false },
    'spiral': { bsp: true, spiral: true },
};

function layoutTraits(layout) {
    return Object.hasOwn(LAYOUT_TRAITS, layout) ? LAYOUT_TRAITS[layout] : null;
}

// The layouts tiled from a BSP tree.
export function isBspLayout(layout) {
    return !!layoutTraits(layout)?.bsp;
}

export function isSpiralLayout(layout) {
    return !!layoutTraits(layout)?.spiral;
}

// Canonical form of an accelerator for comparison: '<Shift><Super>h' and
// '<Super><Shift>h' are the same shortcut (GTK, mutter, and users write the
// modifier order differently) — lowercased sorted modifiers + key.
const KEY_ALIASES = {
    above_tab: 'grave',
};

export function normalizeAccel(combo) {
    const parts = combo.replace(/[<>]/g, ' ').trim().split(/\s+/);
    if (parts.length === 0) return combo;
    const rawKey = parts[parts.length - 1].toLowerCase();
    const key = KEY_ALIASES[rawKey] || rawKey;
    const mods = parts.slice(0, -1).map((m) => m.toLowerCase()).sort();
    return mods.length ? `<${mods.join('><')}>${key}` : key;
}

// Translate Mutter-only key names into portable GTK accelerator names. The
// shortcut editor uses Gtk.accelerator_parse(), which does not know Above_Tab.
export function normalizeTypedAccel(text) {
    return text.replace(/\babove_tab\b/gi, 'grave');
}

