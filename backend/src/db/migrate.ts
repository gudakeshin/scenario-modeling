import { logger } from "../logger.js";
/**
 * @deprecated Use `npm run db:migrate` (node-pg-migrate) instead.
 * Kept only so old docs/scripts fail loudly with guidance.
 */
logger.error("Deprecated: use `npm run db:migrate` (node-pg-migrate). Seeds: `npm run db:seed`.");
process.exit(1);
