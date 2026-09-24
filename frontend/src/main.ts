import './style.css';

// A0 entry point. The renderer, story and explore modes arrive in A3-A5.
// Rule: DOM text is only ever set via textContent (CLAUDE.md rule 2); Trusted Types enforce it at runtime.
const status = document.getElementById('status');
if (status) {
  status.textContent = 'Under construction. The city arrives in milestone A3.';
}
