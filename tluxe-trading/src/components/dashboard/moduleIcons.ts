import { BookOpen, CalendarDays, Cpu, LayoutDashboard, Settings, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { ModuleIcon } from '../../config/modules';

export const MODULE_ICONS: Record<ModuleIcon, LucideIcon> = {
  overview: LayoutDashboard,
  calendar: CalendarDays,
  journal: BookOpen,
  risk: ShieldCheck,
  engines: Cpu,
  settings: Settings,
};
