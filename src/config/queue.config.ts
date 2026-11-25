import { registerAs } from '@nestjs/config';

export const queueConfig = registerAs('queue', () => {
  const maxAttempts = parseInt(process.env.QUEUE_MAX_ATTEMPTS || '10', 10);
  const retentionDays = parseInt(process.env.QUEUE_RETENTION_DAYS || '30', 10);

  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > 100) {
    throw new Error(
      'QUEUE_MAX_ATTEMPTS must be an integer between 1 and 100'
    );
  }
  if (!Number.isInteger(retentionDays) || retentionDays <= 0 || retentionDays > 90) {
    throw new Error(
      'QUEUE_RETENTION_DAYS must be an integer between 1 and 90'
    );
  }

  return {
    maxAttempts,
    retentionDays,
    hardCaps: {
      maxAttempts: 100,
      retentionDays: 90,
    },
  };
});
