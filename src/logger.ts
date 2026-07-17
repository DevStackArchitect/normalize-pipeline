import pino from 'pino';

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');
const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY === true;

export const logger = pino({
  level,
  ...(pretty ? { transport: { target: 'pino-pretty' } } : {}),
});
