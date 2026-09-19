import { afterEach } from 'vitest';
import { yieldWorkerIO } from '../support/yield-worker-io.js';

// Consecutive synchronous tests otherwise keep worker RPC replies queued across the whole suite.
afterEach(yieldWorkerIO);
