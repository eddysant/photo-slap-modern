import { SHORTCUT_GROUPS, shortcutsByGroup } from '../shortcuts';

/**
 * `?` help. Every shortcut also appears in the Actions menu, but the menu is
 * a long way from a fullscreen slideshow on a TV.
 */
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
    return (
        <div className="shortcuts-backdrop" onClick={onClose} role="presentation">
            <div
                className="shortcuts-panel"
                onClick={e => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Keyboard shortcuts"
            >
                <div className="shortcuts-header">
                    <strong>KEYBOARD SHORTCUTS</strong>
                    <button className="shortcuts-close" onClick={onClose} aria-label="Close">✕</button>
                </div>
                <div className="shortcuts-groups">
                    {SHORTCUT_GROUPS.map(group => (
                        <section key={group} className="shortcuts-group">
                            <h3>{group}</h3>
                            <ul>
                                {shortcutsByGroup(group).map(shortcut => (
                                    <li key={shortcut.label}>
                                        <span className="shortcuts-keys">
                                            {shortcut.keys.map(key => <kbd key={key}>{key}</kbd>)}
                                        </span>
                                        <span className="shortcuts-label">{shortcut.label}</span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            </div>
        </div>
    );
}
