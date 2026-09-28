import { useEffect, useState } from 'react';

export const defaultFontFamily = '"Cascadia Code", "Consolas", "Yu Gothic UI", monospace';

export function useEditorSettings() {
    const [editorConfig, setEditorConfig] = useState(
        () => localStorage.getItem('nido.editorConfig') !== 'false'
    );
    useEffect(() => {
        localStorage.setItem('nido.editorConfig', String(editorConfig));
    }, [editorConfig]);
    const [relativeLineNumbers, setRelativeLineNumbers] = useState(
        () => localStorage.getItem('nido.relativeLineNumbers') === 'true'
    );
    useEffect(() => {
        localStorage.setItem('nido.relativeLineNumbers', String(relativeLineNumbers));
    }, [relativeLineNumbers]);
    const [sidebar, setSidebar] = useState(true);
    const [animations, setAnimations] = useState(
        () => localStorage.getItem('nido.animations') !== 'false'
    );
    const [smoothCursor, setSmoothCursor] = useState(
        () => localStorage.getItem('nido.smoothCursor') === 'true'
    );
    const [smoothBlink, setSmoothBlink] = useState(
        () => localStorage.getItem('nido.smoothBlink') === 'true'
    );
    useEffect(() => {
        localStorage.setItem('nido.smoothBlink', String(smoothBlink));
    }, [smoothBlink]);
    useEffect(() => {
        localStorage.setItem('nido.smoothCursor', String(smoothCursor));
    }, [smoothCursor]);
    const [scrollFollowCursor, setScrollFollowCursor] = useState(
        () => localStorage.getItem('nido.scrollFollowCursor') !== 'false'
    );
    const [formatOnSave, setFormatOnSave] = useState(
        () => localStorage.getItem('nido.formatOnSave') !== 'false'
    );
    const [clipboardSharing, setClipboardSharing] = useState(
        () => localStorage.getItem('nido.clipboardSharing') === 'true'
    );
    useEffect(() => {
        localStorage.setItem('nido.clipboardSharing', String(clipboardSharing));
    }, [clipboardSharing]);
    const [fontFamily, setFontFamily] = useState(
        () => localStorage.getItem('nido.fontFamily') ?? defaultFontFamily
    );

    useEffect(() => {
        localStorage.setItem('nido.fontFamily', fontFamily);
    }, [fontFamily]);

    useEffect(() => {
        localStorage.setItem('nido.scrollFollowCursor', String(scrollFollowCursor));
    }, [scrollFollowCursor]);

    useEffect(() => {
        localStorage.setItem('nido.formatOnSave', String(formatOnSave));
    }, [formatOnSave]);

    useEffect(() => {
        localStorage.setItem('nido.animations', String(animations));
    }, [animations]);

    const [sidebarWidth, setSidebarWidth] = useState(() => {
        const saved = Number(localStorage.getItem('nido.sidebarWidth'));
        return Number.isFinite(saved) && saved >= 160 && saved <= 480 ? saved : 243;
    });

    const resizeSidebar = (width: number): void => {
        setSidebarWidth(Math.max(160, Math.min(480, width)));
    };

    useEffect(() => {
        localStorage.setItem('nido.sidebarWidth', String(sidebarWidth));
    }, [sidebarWidth]);

    const [fontSize, setFontSize] = useState(() => {
        const value = Number(localStorage.getItem('nido.fontSize'));
        return value >= 8 && value <= 24 ? value : 15;
    });

    useEffect(() => {
        localStorage.setItem('nido.fontSize', String(fontSize));
    }, [fontSize]);

    return {
        editorConfig,
        setEditorConfig,
        relativeLineNumbers,
        setRelativeLineNumbers,
        sidebar,
        setSidebar,
        animations,
        setAnimations,
        smoothCursor,
        setSmoothCursor,
        smoothBlink,
        setSmoothBlink,
        scrollFollowCursor,
        setScrollFollowCursor,
        formatOnSave,
        setFormatOnSave,
        clipboardSharing,
        setClipboardSharing,
        fontFamily,
        setFontFamily,
        fontSize,
        setFontSize,
        sidebarWidth,
        resizeSidebar
    };
}

export type EditorSettings = ReturnType<typeof useEditorSettings>;
