import { Node, mergeAttributes } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";

export const Tag = Node.create({
    name: "tag",
    group: "inline",
    inline: true,
    selectable: false,
    atom: true,

    addOptions() {
        return {
            suggestion: {
                char: "@",
                allowSpaces: false,
                command: ({ editor, range, props }) => {
                    editor
                        .chain()
                        .focus()
                        .insertContentAt(range, [
                            { type: "tag", attrs: { id: props.id || props.label } },
                            { type: "text", text: " " },
                        ])
                        .run();
                },
            },
        };
    },

    addAttributes() {
        return {
            id: { default: null, parseHTML: el => el.getAttribute("data-id") },
        };
    },

    parseHTML() {
        return [{ tag: 'span[data-type="tag"]' }];
    },

    renderHTML({ node, HTMLAttributes }) {
        return [
            "span",
            mergeAttributes(HTMLAttributes, {
                "data-type": "tag",
                "data-id": node.attrs.id,
                class: "tag-node",
            }),
            "@" + node.attrs.id,
        ];
    },

    renderText({ node }) {
        return "@" + node.attrs.id;
    },

    addKeyboardShortcuts() {
        return {
            Backspace: () =>
                this.editor.commands.command(({ tr, state }) => {
                    let isMention = false;
                    const { selection } = state;
                    const { empty, anchor } = selection;
                    if (!empty) return false;
                    state.doc.nodesBetween(anchor - 1, anchor, (node, pos) => {
                        if (node.type.name === this.name) {
                            isMention = true;
                            tr.insertText("", pos, pos + node.nodeSize);
                            return false;
                        }
                    });
                    return isMention;
                }),
        };
    },

    addProseMirrorPlugins() {
        return [
            Suggestion({
                editor: this.editor,
                ...this.options.suggestion,
            }),
        ];
    },
});

// Extract all @tag ids from a tiptap JSON doc node
export function extractTags(contentJson) {
    const tags = new Set();
    function walk(node) {
        if (node.type === "tag" && node.attrs?.id) {
            tags.add(node.attrs.id);
        }
        if (node.content) {
            for (const child of node.content) walk(child);
        }
    }
    try {
        const parsed = typeof contentJson === "string" ? JSON.parse(contentJson) : contentJson;
        walk(parsed);
    } catch {}
    return [...tags];
}
