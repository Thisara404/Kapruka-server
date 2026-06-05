interface RateLimitRecord {
  timestamps: number[];
}

const limitStore = new Map<string, RateLimitRecord>();

// Clean up records older than 1 hour to prevent memory leaks
const interval = setInterval(() => {
  const now = Date.now();
  const oneHourAgo = now - 3600000;
  for (const [key, record] of limitStore.entries()) {
    record.timestamps = record.timestamps.filter((t) => t > oneHourAgo);
    if (record.timestamps.length === 0) {
      limitStore.delete(key);
    }
  }
}, 600000); // Clean up every 10 minutes

if (typeof interval.unref === "function") {
  interval.unref();
}

/**
 * Checks if a key (IP address or user ID) has exceeded its message quota.
 *
 * @param key The identifier (IP or User ID)
 * @param limit Max allowed requests within the window
 * @param windowMs Time window in milliseconds (default: 1 hour)
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs = 3600000
): { allowed: boolean; remaining: number; resetAt: Date } {
  const now = Date.now();
  const cutoff = now - windowMs;

  let record = limitStore.get(key);
  if (!record) {
    record = { timestamps: [] };
    limitStore.set(key, record);
  }

  // Filter timestamps outside the current window
  record.timestamps = record.timestamps.filter((t) => t > cutoff);

  if (record.timestamps.length >= limit) {
    const oldestTimestamp = record.timestamps[0];
    const resetTime = oldestTimestamp + windowMs;
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(resetTime),
    };
  }

  // Record current request
  record.timestamps.push(now);

  return {
    allowed: true,
    remaining: limit - record.timestamps.length,
    resetAt: new Date(now + windowMs),
  };
}
