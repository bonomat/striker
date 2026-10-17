import { writeFileSync } from 'node:fs';
import { signedProgramVector } from './vector.js';
writeFileSync(new URL('./vector.json', import.meta.url), JSON.stringify(signedProgramVector(), null, 2) + '\n');
