// Workflow cards in the shape the old task guides had (id, workflow, example, checklist,
// prompt), which is what get_card returns as their implementation.
import { createHash } from 'node:crypto';
import { listCards, workflowOf } from './cards.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const listGuides = () => listCards().filter(c => c.kind === 'workflow').map(workflowOf).map(p => ({...p, contentHash:hash(p)}));
