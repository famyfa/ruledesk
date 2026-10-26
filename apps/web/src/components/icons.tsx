import {
  ArrowDown,
  ArrowUp,
  BrickWallShield,
  Check,
  Circle,
  Copy,
  EqualNot,
  GripVertical,
  Info,
  Lock,
  Minus,
  Moon,
  Pause,
  Play,
  Redo2,
  RefreshCw,
  Sun,
  Trash,
  TriangleAlert,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";

/**
 * The icons RuleDeck uses (Lucide, ISC license). Icons are decoration: the text
 * next to them, or the button's label, says what they mean.
 */
const ICONS = {
  brand: BrickWallShield,
  warn: TriangleAlert,
  ok: Check,
  fail: X,
  sun: Sun,
  moon: Moon,
  undo: Undo2,
  redo: Redo2,
  refresh: RefreshCw,
  grip: GripVertical,
  dot: Circle,
  lock: Lock,
  info: Info,
  copy: Copy,
  up: ArrowUp,
  down: ArrowDown,
  trash: Trash,
  play: Play,
  pause: Pause,
  minus: Minus,
  differs: EqualNot,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  const C = ICONS[name];
  const filled = name === "dot";
  return <C size={filled ? 8 : size} strokeWidth={2} aria-hidden="true" focusable="false" className={`icon icon-${name}${className ? ` ${className}` : ""}`} fill={filled ? "currentColor" : "none"} />;
}
