import type { Op } from '@ccfleet/protocol';

/** Keys that drive the selected turtles (anywhere on the dashboard). */
export const DRIVE_KEYS: Record<string, Op> = { w: 'forward', s: 'back', a: 'turnLeft', d: 'turnRight', r: 'up', f: 'down' };

/** Keys of the 3D view (only while it is open). Must not overlap DRIVE_KEYS. */
export const VIEW3D_KEYS = { x: 'xray', c: 'cut', g: 'follow', o: 'overview', h: 'recentre' } as const;
export type View3DAction = (typeof VIEW3D_KEYS)[keyof typeof VIEW3D_KEYS];

/** A key press meant for a text field (or with a modifier): not a shortcut. */
export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  const typing =
    !!el &&
    (el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable ||
      (el instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button'].includes(el.type)));
  return typing || e.ctrlKey || e.metaKey || e.altKey || e.repeat;
}

/** The 3D action for a key, if any. */
export function view3dAction(key: string): View3DAction | undefined {
  return (VIEW3D_KEYS as Record<string, View3DAction>)[key.toLowerCase()];
}
