/**
 * Validates that an event's device timestamp is not more than maxFutureMinutes in the future.
 * According to spec: "Reject ts more than 5 min in the future."
 */
export function isDeviceTimestampValid(
  deviceTs: string | Date,
  maxFutureMinutes: number = 5,
  referenceTime: Date = new Date()
): { valid: boolean; reason?: string } {
  const tsDate = typeof deviceTs === 'string' ? new Date(deviceTs) : deviceTs;

  if (Number.isNaN(tsDate.getTime())) {
    return { valid: false, reason: 'Invalid timestamp format' };
  }

  const maxAllowedTime = referenceTime.getTime() + maxFutureMinutes * 60 * 1000;
  if (tsDate.getTime() > maxAllowedTime) {
    const diffSeconds = Math.round((tsDate.getTime() - referenceTime.getTime()) / 1000);
    return {
      valid: false,
      reason: `Timestamp is ${diffSeconds}s in the future (max allowed: ${maxFutureMinutes * 60}s)`,
    };
  }

  return { valid: true };
}
