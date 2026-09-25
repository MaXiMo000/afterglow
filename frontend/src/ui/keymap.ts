/**
 * The explore key map (EXPERIENCE section 4). One definition drives the key bindings, the `?` help overlay and the
 * palette's action list, so a key can never exist without being discoverable.
 */
export type ActionId =
  | 'home' | 'reset' | 'frame' | 'preset1' | 'preset2' | 'preset3' | 'preset4' | 'preset5'
  | 'play' | 'slower' | 'faster' | 'stepBack' | 'stepFwd' | 'timeline' | 'compare' | 'palette' | 'insights'
  | 'photo' | 'minimap' | 'arcs' | 'lanterns' | 'help' | 'table' | 'share' | 'story'; // prettier-ignore

export type KeyDef = { id: ActionId; keys: string[]; label: string; group: 'Camera' | 'Time' | 'Panels' | 'View' };

export const KEYMAP: readonly KeyDef[] = [
  { id: 'home', keys: ['H'], label: 'Home view', group: 'Camera' },
  { id: 'reset', keys: ['R'], label: 'Reset view and selection', group: 'Camera' },
  { id: 'frame', keys: ['F'], label: 'Frame the selection', group: 'Camera' },
  { id: 'preset1', keys: ['1'], label: 'Overview', group: 'Camera' },
  { id: 'preset2', keys: ['2'], label: 'Street level', group: 'Camera' },
  { id: 'preset3', keys: ['3'], label: 'Top-down', group: 'Camera' },
  { id: 'preset4', keys: ['4'], label: 'Skyline', group: 'Camera' },
  { id: 'preset5', keys: ['5'], label: 'Cinematic auto-orbit', group: 'Camera' },
  { id: 'play', keys: ['Space'], label: 'Play / pause history', group: 'Time' },
  { id: 'slower', keys: ['['], label: 'Slower playback', group: 'Time' },
  { id: 'faster', keys: [']'], label: 'Faster playback', group: 'Time' },
  { id: 'stepBack', keys: [','], label: 'Step back one month', group: 'Time' },
  { id: 'stepFwd', keys: ['.'], label: 'Step forward one month', group: 'Time' },
  { id: 'timeline', keys: ['T'], label: 'Show / hide the timeline', group: 'Time' },
  { id: 'compare', keys: ['C'], label: 'Compare two dates', group: 'Time' },
  { id: 'palette', keys: ['/', 'Ctrl+K'], label: 'Search files, districts, people, actions', group: 'Panels' },
  { id: 'insights', keys: ['I'], label: 'Insights panel', group: 'Panels' },
  { id: 'minimap', keys: ['M'], label: 'Mini-map', group: 'Panels' },
  { id: 'table', keys: ['V'], label: 'View as table', group: 'Panels' },
  { id: 'help', keys: ['?'], label: 'Keyboard help', group: 'Panels' },
  { id: 'photo', keys: ['P'], label: 'Photo mode (save a PNG)', group: 'View' },
  { id: 'arcs', keys: ['G'], label: 'Coupling arcs on / off', group: 'View' },
  { id: 'lanterns', keys: ['L'], label: 'Lanterns (people) on / off', group: 'View' },
  { id: 'share', keys: ['S'], label: 'Copy a share link to this view', group: 'View' },
  { id: 'story', keys: ['B'], label: 'Back to the story', group: 'View' },
];

/** Keys that are handled directly (movement) and listed in help only. */
export const MOVE_KEYS: readonly { keys: string; label: string }[] = [
  { keys: 'W A S D / arrows', label: 'Move / orbit (Shift: faster)' },
  { keys: 'Q E', label: 'Rotate' },
  { keys: '+ - / wheel / pinch', label: 'Zoom (toward the cursor)' },
  { keys: 'Double-click', label: 'Fly to a building' },
  { keys: 'Esc', label: 'Back out one level' },
];

/** Resolve a keyboard event to an action (null if none). Movement keys are not actions. */
export function actionFor(e: KeyboardEvent): ActionId | null {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') return 'palette';
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  for (const def of KEYMAP) if (def.keys.includes(key)) return def.id;
  return null;
}
