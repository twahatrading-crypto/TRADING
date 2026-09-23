import { ArrowLeft, Construction } from 'lucide-react';
import type { ModuleConfig } from '../../config/modules';
import { EmptyState } from '../ui/EmptyState';
import { MODULE_ICONS } from './moduleIcons';
import './dashboard.css';

/** Placeholder page per module; each becomes a real page in a later phase. */
export function ModulePage({ module }: { module: ModuleConfig }) {
  const Icon = MODULE_ICONS[module.icon];
  return (
    <>
      <main className="module-page">
        <a className="btn-ghost module-page__back" href="#/">
          <ArrowLeft size={14} /> Dashboard
        </a>
        <div className="module-page__head">
          <span className="module__icon"><Icon size={26} /></span>
          <div>
            <h1 className="module-page__title">{module.title}</h1>
            <p className="module-page__desc">{module.description}</p>
          </div>
        </div>
        <div className="panel module-page__body">
          <EmptyState
            icon={<Construction size={18} />}
            title="MODULE NOT YET BUILT"
            message="This module is reserved in the navigation and routing architecture. It will be implemented in a later phase."
          />
        </div>
      </main>
    </>
  );
}
