import { useState } from 'react';
import { FiX, FiPlus } from 'react-icons/fi';

interface TagEditorProps {
    fileName: string;
    /** Tags currently on this file. */
    fileTags: string[];
    /** The library's tag vocabulary (quick-pick chips). */
    tagNames: string[];
    onToggleTag: (tag: string) => void;
    onAddTag: (tag: string) => void;
    onClose: () => void;
}

/**
 * Small panel for tagging the current photo. Existing library tags render
 * as toggle chips (the "quick tags"); new tags join the vocabulary.
 */
export function TagEditor({ fileName, fileTags, tagNames, onToggleTag, onAddTag, onClose }: TagEditorProps) {
    const [newTag, setNewTag] = useState('');

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        const tag = newTag.trim();
        if (tag) {
            onAddTag(tag);
            setNewTag('');
        }
    };

    return (
        <div className="tag-editor" onClick={e => e.stopPropagation()}>
            <div className="tag-editor-header">
                <span className="tag-editor-title" title={fileName}>TAGS — {fileName}</span>
                <button className="close-btn" onClick={onClose}><FiX /></button>
            </div>

            {tagNames.length > 0 ? (
                <div className="tag-chips">
                    {tagNames.map(tag => (
                        <button
                            key={tag}
                            className={`tag-chip ${fileTags.includes(tag) ? 'on' : ''}`}
                            onClick={() => onToggleTag(tag)}
                        >
                            {tag}
                        </button>
                    ))}
                </div>
            ) : (
                <div className="tag-editor-empty">No tags yet — add one below.</div>
            )}

            <form className="tag-add-form" onSubmit={submit}>
                <input
                    value={newTag}
                    placeholder="new tag…"
                    autoFocus
                    onChange={e => setNewTag(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
                />
                <button type="submit" className="text-btn"><FiPlus /> Add</button>
            </form>
        </div>
    );
}
