import pino, { Logger, LoggerOptions } from 'pino';

export interface CreateLoggerOptions {
  service: string;
  level?: string;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const level = options.level || process.env.LOG_LEVEL || 'info';

  const pinoOptions: LoggerOptions = {
    level,
    base: {
      service: options.service,
      env: process.env.NODE_ENV || 'development',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  return pino(pinoOptions);
}
