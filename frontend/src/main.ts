import 'virtual:tokens.css'; // design tokens as CSS custom properties, generated from src/tokens.ts
import './style.css';
import { App } from './ui/app';

// Rule: DOM text is only ever set via textContent (CLAUDE.md rule 2); Trusted Types enforce it at runtime.
new App().start();
