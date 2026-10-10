import { cloneElement, useContext, useLayoutEffect, useState } from 'react';
import type { HTMLAttributes, ReactElement } from 'react';
import { OverlayMotionContext, overlayMotionDuration } from '../overlayMotion';
import '../assets/OverlayMotion.css';

interface OverlayAttributes extends HTMLAttributes<HTMLElement> {
    'data-overlay-motion'?: boolean;
    'data-overlay-phase'?: 'open' | 'closing';
}

// The child must be a DOM element so its positioning and existing refs stay intact.
export default function OverlayPresence({
    children
}: {
    children: ReactElement<OverlayAttributes> | null;
}): React.JSX.Element | null {
    const animate = useContext(OverlayMotionContext);
    const [retained, setRetained] = useState(children);
    if (children && children !== retained) {
        setRetained(children);
    } else if (!children && !animate && retained) {
        setRetained(null);
    }

    useLayoutEffect(() => {
        if (children || !retained || !animate) {
            return;
        }
        const timer = setTimeout(() => setRetained(null), overlayMotionDuration);
        return () => clearTimeout(timer);
    }, [children, retained, animate]);

    const element = children || (animate ? retained : null);
    if (!element) {
        return null;
    }
    const closing = !children;
    return cloneElement(element, {
        'data-overlay-motion': animate,
        'data-overlay-phase': closing ? 'closing' : 'open',
        // Return keyboard/pointer control immediately while the old content fades away.
        inert: closing || element.props.inert,
        'aria-hidden': closing ? true : element.props['aria-hidden']
    });
}
